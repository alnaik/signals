import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runRunner, setRunner } from "../ats/reader.ts";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { companyByName, upsertCompany, watchCompany } from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { intakeLead } from "../intake/leads.ts";
import { setProviders } from "../providers/registry.ts";
import type { SearchOpts, SearchResult } from "../providers/types.ts";
import { readSourceState } from "../signals/state.ts";
import boardSearch, { plan, postingUrl, readPosting, setGetter, stems } from "./board-search/index.ts";

const data = tempData();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  deleteSecret("contextdev");
  deleteSecret("anthropic");
  setGetter(null);
  setProviders(null);
  setRunner(runRunner);
  data.cleanup();
});
const page = (f: string) =>
  readFileSync(path.join(import.meta.dir, "..", "fixtures", "board-search", f), "utf8");

const GH = "https://job-boards.greenhouse.io/tessera/jobs/4421";
const LEVER = "https://jobs.lever.co/acmerobotics/3f1c2a9e-8b7d-4e6f-a5c4-1b2d3e4f5a6b";
const LEVER_OLD = "https://jobs.lever.co/acmerobotics/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ASHBY = "https://jobs.ashbyhq.com/corvane.dev/7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WD = "https://hollin.wd1.myworkdayjobs.com/Plattery_Careers/job/Denver-CO/Software-Engineer_R123";
const WD_ACME = "https://acme.wd5.myworkdayjobs.com/External/job/Denver-CO/Software-Engineer_R9";
const SR = "https://jobs.smartrecruiters.com/Brindle3/744000990012345-engineer";
const WORKABLE = "https://apply.workable.com/nameless/j/389310941F/";
const AGENCY = "https://jobs.ashbyhq.com/pellwood-talent/5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NEWCO = "https://jobs.ashbyhq.com/newco/6b2e3d4c-5f6a-4b7c-9d8e-0f1a2b3c4d5e";

// The small model, as the employer check sees it, answered through fetch: never a real call.
const prompts: string[] = [];
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const user = JSON.parse(String(init?.body ?? "{}")).messages[0].content as string;
  prompts.push(user);
  const agency = user.includes("Organization: Pellwood Talent");
  // On Workday the same call names the employer: Plattery, as its posting writes it; for the
  // other tenant it answers its slug, which that posting never writes.
  const workday = user.match(/^Workday's payroll entity: (.*)$/m)?.[1];
  const name = workday === undefined ? {} : { name: workday === "Hollin Holdings LLC" ? "Plattery" : "Acme" };
  return Response.json({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify(
          agency
            ? { is: "agency", why: "Its board lists attorneys and engineers for clients" }
            : { is: "employer", why: "Hires for itself", ...name },
        ),
      },
    ],
    usage: { input_tokens: 500, output_tokens: 20 },
  });
}) as unknown as typeof fetch;

test("a posting's own page says what it is: JSON-LD, then og: tags, then the Workday URL", () => {
  expect(readPosting(page("greenhouse.html"), GH)).toEqual({
    title: "Senior Product Engineer",
    location: "Denver, Colorado, United States",
    postedAt: null,
  });
  expect(readPosting(page("lever.html"), LEVER)).toMatchObject({
    title: "Backend Engineer",
    location: "Denver, Colorado",
    org: "Acme Robotics",
  });
  expect(readPosting(page("ashby.html"), ASHBY)).toMatchObject({
    title: "Design Engineer",
    location: "Remote",
    site: "https://corvane.dev",
  });
  // A website is taken only where Ashby's board states it: another board's sameAs is not.
  const sameAs = page("lever.html").replace(
    '"name":"Acme Robotics"',
    '"name":"Acme Robotics","sameAs":"https://acme.com"',
  );
  expect(readPosting(sameAs, LEVER)?.site).toBeUndefined();
  // Workday's organisation is a payroll entity: kept as a hint for the name, never as the name.
  const wd = readPosting(page("workday.html"), WD)!;
  expect(wd).toMatchObject({ title: "Software Engineer", location: "Denver", entity: "Hollin Holdings LLC" });
  expect(wd.org).toBeUndefined();
  // SmartRecruiters names it in microdata; a placeholder names no one.
  const sr = (org: string) =>
    `<meta property="og:title" content="Engineer"><span itemprop="hiringOrganization" itemscope itemtype="http://schema.org/Organization"><meta itemprop="name" content="${org}"></span>`;
  expect(readPosting(sr("Brindle Robotics"), SR)?.org).toBe("Brindle Robotics");
  expect(readPosting(sr("Confidential"), SR)?.org).toBeUndefined();
  expect(readPosting(page("workday.html").replace(/<script[\s\S]*?<\/script>/, ""), WD)?.location).toBe(
    "Denver CO",
  );
  // Entities are decoded, twice-encoded ones too (Workday's og:title), in JSON-LD and in tags.
  const amp = page("workday.html").replace(
    /"title":"Software Engineer"/,
    '"title":"Cloud Engineer – Ops &amp; Platform"',
  );
  expect(readPosting(amp, WD)?.title).toBe("Cloud Engineer – Ops & Platform");
  const og = page("greenhouse.html").replace(
    /og:title" content="[^"]*"/,
    'og:title" content="Ops &amp;amp; Platform &#8211; Engineer"',
  );
  expect(readPosting(og, GH)?.title).toBe("Ops & Platform – Engineer");
});

test("board search: one query per city × host, each posting read once, a signal per posting that fits", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({
      filters: {
        locations: ["Denver", "CO", "Remote"],
        remote_ok: true,
        title_include: ["Engineer", "Product Designer"],
      },
    }),
  );
  writeFileSync(paths.config(), '[providers]\ncompany = ["dir"]\n[source.board-search]\non = true\n');
  for (const k of ["contextdev", "exa", "firecrawl", "parallel"]) deleteSecret(k);
  expect(await boardSearch.connected()).toBe(false); // no web search yet
  setSecret("contextdev", "k");
  expect(await boardSearch.connected()).toBe(true);
  expect(plan()).toHaveLength(7);
  expect(plan().find((q) => q.host === "myworkdayjobs.com")?.query).toBe(
    "site:myworkdayjobs.com (Engineer OR Designer) Denver",
  );
  // With metros, one query per metro × host: its city words with OR, states and codes left out.
  const profile = JSON.parse(readFileSync(paths.me("profile.json"), "utf8"));
  profile.filters.metros = { Colorado: ["Denver", "Boulder", "Colorado", "CO"], Remote: ["Remote"] };
  writeFileSync(paths.me("profile.json"), JSON.stringify(profile));
  expect(plan()).toHaveLength(7);
  expect(plan().find((q) => q.host === "jobs.lever.co")).toEqual({
    city: "Colorado",
    host: "jobs.lever.co",
    query: "(Engineer OR Designer) (Denver OR Boulder)",
  });
  delete profile.filters.metros;
  writeFileSync(paths.me("profile.json"), JSON.stringify(profile));
  // Three stems at most, the commonest last words first; short tokens like "AR" are never stems.
  expect(
    stems([
      "Software Engineer",
      "Data Engineer",
      "Developer",
      "Web Developer",
      "Product Manager",
      "AR",
      "TPM",
    ]),
  ).toEqual(["Engineer", "Developer", "Manager"]);

  const results: Record<string, string[]> = {
    "job-boards.greenhouse.io": [
      "https://boards.greenhouse.io/embed/job_app?for=tessera&token=4421",
      "https://job-boards.greenhouse.io/tessera",
    ],
    "jobs.lever.co": [
      LEVER,
      `${LEVER_OLD}/apply`,
      "https://jobs.lever.co/watched/11111111-2222-4333-8444-555555555555",
    ],
    "jobs.ashbyhq.com": [ASHBY, AGENCY],
    "apply.workable.com": [WORKABLE],
    "myworkdayjobs.com": [
      "https://hollin.wd1.myworkdayjobs.com/en-US/Plattery_Careers/job/Denver-CO/Software-Engineer_R123",
      WD_ACME,
    ],
  };
  const queries: [string, SearchOpts][] = [];
  setProviders([
    {
      name: "contextdev",
      label: "Context.dev",
      key: "contextdev",
      cost: { search: 0.001 },
      search: async (q: string, o: SearchOpts): Promise<SearchResult[]> => {
        queries.push([q, o]);
        const host = o.includeDomains?.[0] ?? "myworkdayjobs.com";
        return (results[host] ?? []).map((url) => ({ url, title: "trust me", snippet: "Anywhere" }));
      },
    },
  ]);
  const pages: Record<string, string> = {
    [GH]: page("greenhouse.html"),
    [LEVER]: page("lever.html"),
    [LEVER_OLD]: page("lever-old.html"),
    [ASHBY]: page("ashby.html"),
    [WD]: page("workday.html"),
    // A Workday posting whose words name no one: the model's answer (its slug) is no name.
    [WD_ACME]: page("workday.html")
      .replace(/Hollin Holdings LLC/g, "00042 PAYROLL CO")
      .replace(/At Plattery, join/g, "Join"),
    // Greenhouse's posting names no company: its board's API does. Workable's names none, nor
    // does its account here: that posting is skipped, never named from its slug.
    "https://boards-api.greenhouse.io/v1/boards/tessera": JSON.stringify({ name: "Tessera Labs" }),
    [WORKABLE]: '<meta property="og:title" content="Platform Engineer">',
    // A staffing agency's posting, and its board's titles: the employer check says no.
    [AGENCY]: page("ashby.html").replace('"name":"Corvane"', '"name":"Pellwood Talent Solutions Partners"'),
    "https://jobs.ashbyhq.com/pellwood-talent": '{"title":"Associate Attorney"},{"title":"Registered Nurse"}',
    [NEWCO]: page("ashby.html")
      .replace('"name":"Corvane"', '"name":"NewCo"')
      .replace("corvane.dev", "newco.dev"),
  };
  const read: string[] = [];
  setGetter(async (url) => {
    read.push(url);
    if (!pages[url]) throw new Error("HTTP 404");
    return { status: 200, url, text: pages[url]!, notModified: false };
  });
  let detected = 0;
  setRunner(async () => {
    detected++;
    return [];
  });
  setSecret("anthropic", "sk-test");
  // A company already known is filed without the employer check.
  upsertCompany({ name: "Acme Robotics" });
  const watched = upsertCompany({ name: "Watched", domain: "watched.dev" });
  watchCompany(watched, "manual");
  addBoard(watched, "lever", "https://jobs.lever.co/watched", "test");

  const now = new Date("2026-10-28T03:00:00Z");
  const leads = await boardSearch.fetch(new Date("2026-10-21T03:00:00Z"), now);
  expect(queries).toHaveLength(7);
  expect(queries[0]![1]).toMatchObject({
    n: 10,
    includeDomains: ["job-boards.greenhouse.io"],
    since: "2026-10-21T03:00:00.000Z",
  });
  // The watched board's posting is never read; every other posting once, and a board's own API
  // when its posting names no company.
  expect(read.filter((u) => postingUrl(u) === u).sort()).toEqual(
    [ASHBY, AGENCY, GH, LEVER, LEVER_OLD, WD, WD_ACME, WORKABLE].sort(),
  );
  expect(read).toContain("https://boards-api.greenhouse.io/v1/boards/tessera");
  expect(read).toContain("https://apply.workable.com/api/v1/widget/accounts/nameless");
  // One employer check per board whose company would be new (Acme Robotics is known), with the
  // posting's text and the board's titles; the agency's postings are not filed. A Workday board's
  // one check names it too, from the posting with its payroll entity as a hint.
  expect(
    prompts.map((u) => u.match(/^(?:Organization|Workday's payroll entity): (.*)$/m)?.[1]).sort(),
  ).toEqual(
    [
      "00042 PAYROLL CO",
      "Corvane",
      "Tessera Labs",
      "Pellwood Talent Solutions Partners",
      "Hollin Holdings LLC",
    ].sort(),
  );
  const asked = prompts.find((u) => u.includes("Pellwood Talent"))!;
  expect(asked).toContain("Associate Attorney; Registered Nurse");
  expect(asked).toContain("Posting: Design Engineer · Remote");
  expect(prompts.find((u) => u.includes("Hollin Holdings"))).toContain("At Plattery, join our team");
  // Every posting that fits is a signal naming its company; a site only when the posting names it
  // (Ashby's sameAs). The posting's link is where discovery starts for the company's board.
  expect(leads.map((l) => [l.url, l.company_hint, l.domain ?? null, l.title])).toEqual([
    [GH, "Tessera Labs", null, "Senior Product Engineer"],
    [LEVER, "Acme Robotics", null, "Backend Engineer"],
    [LEVER_OLD, "Acme Robotics", null, "Firmware Engineer"],
    [ASHBY, "Corvane", "corvane.dev", "Design Engineer"],
    [WD, "Plattery", null, "Software Engineer"],
  ]);
  // Workable's posting and the Workday one whose words name no one are named by nothing.
  expect(boardSearch.note).toBe("2 named by nothing · 1 not by their employer");
  // The old Lever posting is age-gated at intake.
  expect(leads.map((l) => intakeLead(l, now).result)).toEqual(["added", "added", "stale", "added", "added"]);
  // Ashby's stated website is its board's proof; no other company here gets a domain.
  expect(companyByName("Corvane")).toMatchObject({ domain: "corvane.dev", domain_from: "board" });
  expect(companyByName("Tessera Labs")?.domain).toBeNull();
  // The Workday board's name is kept with its employer check: the next posting there asks nothing.
  expect(
    readSourceState<{ employers: Record<string, { name?: string }> }>("board-search", { employers: {} })
      .employers["https://hollin.wd1.myworkdayjobs.com/Plattery_Careers"],
  ).toMatchObject({ is: "employer", name: "Plattery" });
  // Nothing is looked up or detected here.
  expect(detected).toBe(0);
  expect(boardSearch.status?.()).toContain("7 used this month");

  // A second run reads no posting again; the month's limit stops the queries.
  writeFileSync(
    paths.config(),
    '[providers]\ncompany = ["dir"]\n[source.board-search]\non = true\nmonth_credits = 10\n',
  );
  read.length = 0;
  queries.length = 0;
  await boardSearch.fetch(null, now);
  expect(queries).toHaveLength(3);
  expect(read).toEqual([]);
  // A run with no last run (the first) asks for the last week only, not every posting the index has.
  expect(queries[0]![1].since).toBe("2026-10-21T03:00:00.000Z");

  // Without the model, a new company's posting waits, unread as far as the next run is concerned.
  writeFileSync(paths.config(), "[source.board-search]\non = true\nmonth_credits = 100\n");
  results["jobs.ashbyhq.com"] = [NEWCO];
  deleteSecret("anthropic");
  prompts.length = 0;
  expect((await boardSearch.fetch(null, now)).map((l) => l.url)).toEqual([]);
  expect(boardSearch.note).toBe("1 waiting for the employer check");
  setSecret("anthropic", "sk-test");
  expect((await boardSearch.fetch(null, now)).map((l) => [l.company_hint, l.domain])).toEqual([
    ["NewCo", "newco.dev"],
  ]);
  expect(prompts).toHaveLength(1);

  // Whichever web search is connected, in the [providers] order: one that fails hands on.
  writeFileSync(
    paths.config(),
    '[providers]\nsearch = ["down", "exa"]\n[source.board-search]\non = true\nmonth_credits = 100\n',
  );
  const by: string[] = [];
  const web = (name: string, fails = false) => ({
    name,
    label: name,
    key: name,
    cost: { search: 0 },
    search: async () => {
      by.push(name);
      if (fails) throw Object.assign(new Error("HTTP 402"), { status: 402 });
      return [];
    },
  });
  setProviders([web("contextdev"), web("down", true), web("exa")]);
  deleteSecret("contextdev");
  for (const k of ["down", "exa"]) setSecret(k, "k");
  await boardSearch.fetch(null, now);
  expect(by.slice(0, 2)).toEqual(["down", "exa"]);
  expect(by).not.toContain("contextdev");
});

import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { inMetro, loadFilters, passes } from "./filters.ts";
// @ts-expect-error plain JS module
import { googleDates, searchBoard } from "./search.mjs";

const data = tempData();
afterAll(data.cleanup);

test("profile filters apply to postings", () => {
  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: {} }));
  const f = { locations: ["London"], remote_ok: true, title_exclude: ["manager"] };
  expect(passes({ title: "Design Engineer", location: "London" }, f)).toBe(true);
  expect(passes({ title: "Design Engineer", location: "Remote (EU)" }, f)).toBe(true);
  expect(passes({ title: "Design Engineer", location: "Austin, TX" }, f)).toBe(false);
  expect(passes({ title: "Office Manager", location: "London" }, f)).toBe(false);
  expect(passes({ title: "Software Developer - WFH", location: "United States" }, f)).toBe(true);
  expect(passes({ title: "Design Engineer (Remote)", location: "United States" }, f)).toBe(true);
  expect(passes({ title: "Design Engineer - WFH", location: "Austin, TX" }, { ...f, remote_ok: false })).toBe(
    false,
  );
  // A profile that never said (first run saved none): remote is fine, as Settings shows it.
  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: { locations: ["Denver, CO"] } }));
  const role = { title: "Product Engineer", location: "North America · United States · Remote" };
  expect(passes(role, loadFilters())).toBe(true);
  expect(passes(role, { locations: ["Denver, CO"] })).toBe(true);
});

test("an American profile's remote roles must be open in the US (live locations, 2026-11-01)", () => {
  const f = { locations: ["Denver", "Boulder", "Colorado", "CO"], remote_ok: true };
  const fits = (location: string, title = "Design Engineer") => passes({ title, location }, f);
  for (const loc of [
    "Remote",
    "Remote (Any State)",
    "Remote Location - All States",
    "Remote-Massachusetts-110",
    "Remote, AMER",
    "SF or Remote (US/Canada)",
    "Remote, Canada; Remote, United States",
    "North America · United States · Remote",
    "Remote, Global",
    "US-NYC, US-SF, Remote",
    "Littleton, CO",
  ])
    expect([loc, fits(loc)]).toEqual([loc, true]);
  expect(fits("2 Locations", "Design Engineer (Remote)")).toBe(true);
  for (const loc of [
    "Remote Canada",
    "Germany · Remote",
    "London · United Kingdom · Remote",
    "Remote - Europe",
    "Canada - Remote (ON, AB, BC, or NS Only)",
  ])
    expect([loc, fits(loc)]).toEqual([loc, false]);
  expect(fits("Singapore, Singapore", "Design Engineer (Remote)")).toBe(false);
});

test("short filter words match whole words; longer ones match stems", () => {
  const f = { title_include: ["AR", "TPM", "Prototyp"], locations: ["US", "NYC"] };
  expect(passes({ title: "Software Engineer, AR/VR", location: "NYC" }, f)).toBe(true);
  expect(passes({ title: "Software Engineer", location: "NYC" }, f)).toBe(false);
  expect(passes({ title: "Hardware Partner Marketing", location: "NYC" }, f)).toBe(false);
  expect(passes({ title: "Senior TPM", location: "Remote, US" }, f)).toBe(true);
  expect(passes({ title: "Prototyping Engineer", location: "New York, NY (NYC)" }, f)).toBe(true);
  // A stem matches where a word starts, on the title alone.
  expect(passes({ title: "Prototype Engineer" }, { title_include: ["Prototyp"] })).toBe(true);
  expect(passes({ title: "Rapid prototyping lead" }, { title_include: ["Prototyp"] })).toBe(true);
  expect(passes({ title: "Unprototyped Engineer" }, { title_include: ["Prototyp"] })).toBe(false);
  // A title word that names no job counts only beside one that does.
  const mobile = { title_include: ["Mobile", "Developer", "Forward Deployed"] };
  expect(passes({ title: "Mobile Dog Groomer" }, mobile)).toBe(false);
  expect(passes({ title: "Senior Mobile Engineer" }, mobile)).toBe(true);
  expect(passes({ title: "Member of Technical Staff, Mobile" }, mobile)).toBe(true);
  expect(passes({ title: "Forward Deployed Banker" }, mobile)).toBe(false);
  expect(passes({ title: "Developer" }, mobile)).toBe(true);
});

test("a city's words match a location as the filter does; a code in capitals only in capitals", () => {
  const colorado = ["Denver", "Boulder", "Colorado", "CO"];
  expect(inMetro("Boulder, CO, USA Office (BOULDER) · RTP, North Carolina, USA Office", colorado)).toBe(true);
  expect(inMetro("San Jose, CA · Denver, CO", colorado)).toBe(true);
  expect(inMetro("Golden, CO", colorado)).toBe(true);
  expect(inMetro("Remote - Colorado", colorado)).toBe(true);
  expect(inMetro("Dublin, Co. Dublin, Ireland", colorado)).toBe(false);
  expect(inMetro("Costa Mesa, CA", colorado)).toBe(false);
  expect(inMetro("San Jose, CA", colorado)).toBe(false);
  // The location filter matches the same way: "Co. Dublin" isn't Colorado there either.
  expect(passes({ title: "Engineer", location: "Dublin, Co. Dublin" }, { locations: ["CO"] })).toBe(false);
  // With American places, a US city's name abroad is another place; a list counts any of its parts.
  const boston = { locations: ["Boston", "Cambridge", "MA"] };
  expect(passes({ title: "Engineer", location: "Cambridge, United Kingdom" }, boston)).toBe(false);
  expect(passes({ title: "Engineer", location: "London, UK; Cambridge, MA" }, boston)).toBe(true);
  expect(inMetro("Cambridge, England", ["Cambridge"], true)).toBe(false);
  expect(inMetro("Cambridge, England", ["Cambridge"], false)).toBe(true); // a profile in England
  // A place that names no city, only the US or how it's worked, passes as a blank one does.
  expect(passes({ title: "Engineer", location: "United States" }, boston)).toBe(true);
  expect(passes({ title: "Engineer", location: "Hybrid" }, boston)).toBe(true);
  expect(passes({ title: "Engineer", location: "Plano, TX, United States" }, boston)).toBe(false);
});

test("private hosts are refused before any request", async () => {
  // @ts-expect-error plain JS module
  const { assertPublic } = await import("./polite.mjs");
  for (const host of ["127.0.0.1", "localhost", "10.0.0.8", "169.254.169.254", "::1"]) {
    await expect(assertPublic(host)).rejects.toThrow();
  }
});

test("a robots.txt that redirects into the person's network is never asked there", async () => {
  // @ts-expect-error plain JS module
  const { readRobots } = await import("./polite.mjs");
  const asked: string[] = [];
  const fetchImpl = async (url: URL) => {
    asked.push(url.href);
    return url.hostname === "93.184.215.14"
      ? new Response(null, { status: 302, headers: { location: "http://192.168.1.1/robots.txt" } })
      : new Response("User-agent: *\nDisallow: /");
  };
  await expect(readRobots("https://93.184.215.14", "test", { fetchImpl })).rejects.toThrow(/blocked address/);
  expect(asked).toEqual(["https://93.184.215.14/robots.txt"]);
});

test("robots.txt rules are honoured", async () => {
  // @ts-expect-error plain JS module
  const { allowed, parseRobots, robotsMatch } = await import("./polite.mjs");
  const rules = parseRobots(
    "User-agent: *\nDisallow: /embed/\nAllow: /embed/ok\nCrawl-delay: 2\n\nUser-agent: other\nDisallow: /",
  );
  const t = performance.now();
  expect(robotsMatch(`/${"*a".repeat(20)}$`, `/${"a".repeat(60)}b`)).toBe(false);
  expect(performance.now() - t).toBeLessThan(50);
  expect(allowed(rules, "/v1/boards/x/jobs")).toBe(true);
  expect(allowed(rules, "/embed/job_board")).toBe(false);
  expect(allowed(rules, "/embed/ok")).toBe(true);
  expect(rules.delay).toBe(2000);
  expect(allowed(null, "/anything")).toBe(true);
});

test("each known board URL is claimed by exactly one career-ops provider, so their order doesn't matter", async () => {
  // @ts-expect-error plain JS module
  const { loadProviders } = await import("../vendor/career-ops/providers/_registry.mjs");
  const providers: Map<string, { id: string; detect?: (e: unknown) => unknown }> = await loadProviders(
    path.join(import.meta.dir, "../vendor/career-ops/providers"),
  );
  const urls = [
    "https://boards.greenhouse.io/tallowly",
    "https://job-boards.greenhouse.io/tallowly/jobs/123",
    "https://jobs.lever.co/quillmark/abc-123",
    "https://jobs.ashbyhq.com/brindle",
    "https://larkspur.wd1.myworkdayjobs.com/en-US/LarkspurCareers/job/x",
    "https://apply.workable.com/fennory",
    "https://jobs.smartrecruiters.com/Velmoor/123",
    "https://acme.recruitee.com",
    "https://acme.bamboohr.com/careers",
    "https://acme.breezy.hr",
    "https://acme.teamtailor.com/jobs",
    "https://ats.rippling.com/acme/jobs",
    "https://acme.pinpointhq.com",
    "https://careers-acme.icims.com/jobs/search",
    "https://acme.taleo.net/careersection/2/jobsearch.ftl",
    "https://jobs.jobvite.com/acme",
    "https://career4.successfactors.com/career?company=acme",
    "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/requisitions",
    "https://acme.eightfold.ai/careers",
    "https://acme.avature.net/careers",
    "https://recruiting.ultipro.com/ACM1000/JobBoard/abc",
    "https://www.atlassian.com/company/careers/all-jobs",
  ];
  for (const u of urls) {
    const claims = [...providers.values()].filter((p) => {
      try {
        return !!p.detect?.({ name: "x", careers_url: u });
      } catch {
        return false;
      }
    });
    expect([u, claims.length]).toEqual([u, 1]);
  }
});

test("a board on a host that serves every company is keyed by the company it names, and old keys are moved", async () => {
  const { boardKey } = await import("./reader.ts");
  const { open, MIGRATIONS } = await import("../core/db.ts");
  const keys: Record<string, [string, string]> = {
    // provider, link → key: two companies on one host are two boards (Gem merged Tallowly and Quillmark).
    "https://jobs.gem.com/tallowly": ["gem", "gem:jobs.gem.com/tallowly"],
    "https://jobs.gem.com/quillmark/cG9zdGluZzo3": ["gem", "gem:jobs.gem.com/quillmark"],
    "https://app.mokahr.com/social-recruitment/brindle-ai/230118": [
      "mokahr",
      "mokahr:app.mokahr.com/brindle-ai",
    ],
    "https://app.mokahr.com/apply/larkspur/251907": ["mokahr", "mokahr:app.mokahr.com/larkspur"],
    "https://join.com/companies/marrowfield": ["join", "join:join.com/marrowfield"],
    "https://jobs.jobvite.com/acme/jobs": ["jobvite", "jobvite:jobs.jobvite.com/acme"],
    "https://app.eightfold.ai/careers?domain=velmoor.com": [
      "eightfold",
      "eightfold:app.eightfold.ai/velmoor.com",
    ],
    "https://wd3.myworkdaysite.com/recruiting/acme/External": [
      "workday",
      "workday:wd3.myworkdaysite.com/acme/external",
    ],
    // A tenant's own host stays keyed as it was.
    "https://hollowpine.eightfold.ai/careers": ["eightfold", "eightfold:hollowpine"],
  };
  for (const [url, [provider, key]] of Object.entries(keys)) expect(boardKey(provider, url)).toBe(key);
  // Boards stored under the host alone before (the version before this key): moved to the new keys.
  const d = open();
  d.exec("INSERT INTO companies (id, name, created_at) VALUES (1, 'Acme', '2026-10-30')");
  const old: [string, string, string][] = [
    ["gem", "https://jobs.gem.com/tallowly", "gem:jobs.gem.com"],
    ["mokahr", "https://app.mokahr.com/social-recruitment/brindle-ai/230118", "mokahr:app.mokahr.com"],
    ["join", "https://join.com/companies/marrowfield", "join:join.com"],
    ["eightfold", "https://app.eightfold.ai/careers?domain=velmoor.com", "eightfold:app"],
    ["eightfold", "https://hollowpine.eightfold.ai/careers", "eightfold:hollowpine"],
  ];
  for (const [provider, url, key] of old)
    d.query(
      "INSERT INTO boards (company_id, provider, url, key, created_at) VALUES (1, ?, ?, ?, '2026-10-30')",
    ).run(provider, url, key);
  d.exec(MIGRATIONS.find((m) => m.includes("TENANT_IN_PATH"))!);
  const rows = d.query("SELECT provider, url, key FROM boards ORDER BY id").all() as {
    provider: string;
    url: string;
    key: string;
  }[];
  expect(rows.map((r) => r.key)).toEqual(rows.map((r) => boardKey(r.provider, r.url)));
});

test("a board is stored as its root, not a posting link (the 2026-10-28 measurement's cases)", async () => {
  const { atsRoot, boardSlug } = await import("./reader.ts");
  const cases: Record<string, string> = {
    "https://jobs.ashbyhq.com/tallowly/3f1c9a2e-7b44-4d0a-9e15-2c8d6b0a7f31/application":
      "https://jobs.ashbyhq.com/tallowly",
    "https://boards.greenhouse.io/brindlesec/jobs/481207": "https://boards.greenhouse.io/brindlesec",
    "https://job-boards.greenhouse.io/embed/job_app?for=larkspur&token=5521093":
      "https://job-boards.greenhouse.io/larkspur",
    "https://jobs.ashbyhq.com/fennory?utm_source=Xq7RkT2mVb": "https://jobs.ashbyhq.com/fennory",
    "https://jobs.ashbyhq.com/velmoor/embed": "https://jobs.ashbyhq.com/velmoor",
    "https://hollowpine.wd1.myworkdayjobs.com/en-US/Pinecart_Careers":
      "https://hollowpine.wd1.myworkdayjobs.com/Pinecart_Careers",
    "https://corvane.wd1.myworkdayjobs.com/MyCorvane": "https://corvane.wd1.myworkdayjobs.com/MyCorvane",
    // Not an ATS host: stored as found.
    "https://tallmere.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions":
      "https://tallmere.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions",
  };
  for (const [from, to] of Object.entries(cases)) expect(atsRoot(from)).toBe(to);
  expect(boardSlug("https://job-boards.greenhouse.io/embed/job_app?for=larkspur&token=1")).toBe("larkspur");
  // Enterprise boards: the tenant is the slug; the page path is the board, a posting tail is cut.
  expect(boardSlug("https://hollowpine.eightfold.ai/careers")).toBe("hollowpine");
  expect(boardSlug("https://ats.rippling.com/en-GB/orrery/jobs/1")).toBe("orrery");
  expect(boardSlug("https://boards-api.greenhouse.io/v1/boards/acme/jobs")).toBe("acme");
  expect(boardSlug("https://api.lever.co/v0/postings/acme")).toBe("acme");
  expect(
    boardSlug("https://tallmere.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions"),
  ).toBe("tallmere");
  expect(boardSlug("https://dunmarra.taleo.net/careersection/10300/jobsearch.ftl")).toBe("dunmarra");
  // ADP Workforce Now is one host for every company: its client id is the board (Corvel Sensors, 2026-10-29).
  const adp =
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=9c27e4d0&ccId=19000101_000001&lang=en_US&jobId=318640";
  expect(atsRoot(adp)).toBe(
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=9c27e4d0&ccId=19000101_000001",
  );
  expect(boardSlug(adp)).toBe("9c27e4d0");
  expect(atsRoot("https://brakmoor.eightfold.ai/careers/job/7710428835216")).toBe(
    "https://brakmoor.eightfold.ai/careers",
  );
  expect(atsRoot("https://quillnet.eightfold.ai/careers/join?domain=quillnet.com")).toBe(
    "https://quillnet.eightfold.ai/careers/join?domain=quillnet.com",
  );
});

test("a board's search takes each term's first page before any term's second, and stops at its budget", async () => {
  const asked: string[] = [];
  const page = (term: string, offset: number) => ({
    hits: 1000,
    jobs: Array.from({ length: 100 }, (_, i) => ({
      id_icims: `${term}-${offset + i}`,
      title: `${term} ${offset + i}`,
      job_path: `/en/jobs/${term}-${offset + i}`,
    })),
  });
  const ctx = {
    fetchJson: async (url: string) => {
      const u = new URL(url);
      const term = u.searchParams.get("base_query")!;
      const offset = Number(u.searchParams.get("offset"));
      asked.push(`${term}@${offset}`);
      return page(term, offset);
    },
  };
  const all = await searchBoard("amazon", {}, ["Engineer", "Developer"], ctx, 2);
  expect(asked).toEqual(["Engineer@0", "Developer@0", "Engineer@100", "Developer@100"]);
  expect(all).toMatchObject({ complete: false }); // stopped at its page cap
  expect(all.lists.map((l: string[]) => l.length)).toEqual([200, 200]); // each term's results, in order
  expect(all.jobs.length).toBe(400);
  asked.length = 0;
  const cut = await searchBoard("amazon", {}, ["Engineer", "Developer"], ctx, 10, 0);
  expect(asked).toEqual([]);
  expect(cut).toEqual({ jobs: [], complete: false, lists: [[], []] });
});

test("Google's results page says when each role was created and last published (ds:1), by the card's id", () => {
  const row = (id: string, created: number, published: number) => {
    const r: unknown[] = [id, `Role ${id}`];
    r[12] = [created, 0];
    r[13] = [published, 0];
    return r;
  };
  const data = JSON.stringify([
    [row("111", 1793180880, 1793212800), row("222", 1793223510, 1793223510), ["333"]],
  ]);
  const html = `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${data}, sideChannel: {}});</script>`;
  expect([...googleDates(html)]).toEqual([
    ["111", { postedAt: 1793180880000, updatedAt: 1793212800000 }],
    ["222", { postedAt: 1793223510000, updatedAt: 1793223510000 }],
  ]);
  expect(googleDates("<html>no data</html>").size).toBe(0);
});

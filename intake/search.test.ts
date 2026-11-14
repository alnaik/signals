import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
  pastDeadline,
  type RunnerCompany,
  type RunnerResult,
  runRunner,
  setPageReader,
  setRunner,
} from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { failures } from "../core/trace.ts";
import { adoptStandIns } from "../live/watcher.ts";
import { setProviders } from "../providers/registry.ts";
import type { Provider, SearchResult } from "../providers/types.ts";
import { isPost, parseComment } from "../sources/hn/index.ts";
import { getCompany, recordSignal, threadIdOf, upsertCompany } from "./companies.ts";
import { addBoard, applySearch, discoverDue } from "./discover.ts";
import { runBoardsStep } from "./run.ts";
import { searchBoards, searchDue, siteDue } from "./search.ts";

const data = tempData();
const realFetch = globalThis.fetch;
afterAll(() => {
  setRunner(runRunner);
  setProviders(null);
  globalThis.fetch = realFetch;
  data.cleanup();
});

// The small model, as the pick sees it: its prompt → its answer. The pick runs on the API key
// even on the subscription (the default here), so it is answered through fetch. Never a real call.
const config = (more = "") => writeFileSync(paths.config(), more);
type Pick = { pick?: number; domain?: string; query?: string; why?: string };
let model: (user: string) => Pick = () => ({ pick: 0 });
const prompts: string[] = [];
let slow = { model: 0, search: 0 }; // ms each takes to answer
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const user = JSON.parse(String(init?.body ?? "{}")).messages[0].content as string;
  prompts.push(user);
  if (slow.model) await Bun.sleep(slow.model);
  return Response.json({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [
      { type: "text", text: JSON.stringify({ pick: 0, domain: "", query: "", why: "", ...model(user) }) },
    ],
    usage: { input_tokens: 500, output_tokens: 30 },
  });
}) as unknown as typeof fetch;

// The web, as the fake search provider sees it: query → results.
let web: Record<string, SearchResult[]> = {};
const asked: string[] = [];
const search: Provider = {
  name: "contextdev",
  label: "Context.dev",
  key: "contextdev",
  cost: { search: 0 },
  search: async (q) => {
    asked.push(q);
    if (slow.search) await Bun.sleep(slow.search);
    return web[q] ?? [];
  },
};
setProviders([search]);
setSecret("contextdev", "k");
const hit = (url: string, title = ""): SearchResult => ({ url, title, snippet: "" });

// The runner, as boards and sites answer it.
type Answer = (mode: string, c: RunnerCompany) => RunnerResult | Promise<RunnerResult>;
let answer: Answer = (_m, c) => ({ domain: c.domain, ok: true, detect: { provider: null } });
const sent: { mode: string; c: RunnerCompany }[] = [];
const standIn = async (mode: "detect" | "scan", cs: RunnerCompany[]) =>
  Promise.all(
    cs.map((c) => {
      sent.push({ mode, c });
      return answer(mode, c);
    }),
  );
setRunner(standIn);

const now = new Date("2026-10-29T12:00:00Z");
beforeEach(() => {
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies; DELETE FROM web_searches; DELETE FROM meta;",
  );
  config();
  setSecret("anthropic", "sk-test");
  model = () => ({ pick: 0 });
  prompts.length = 0;
  slow = { model: 0, search: 0 };
  web = {};
  asked.length = 0;
  sent.length = 0;
});

/** A company a LinkedIn-style alert named, with these role titles. */
function seen(name: string, domain: string | null, titles: string[]): number {
  let id = 0;
  titles.forEach((title, i) => {
    id = recordSignal(
      {
        url: `https://linkedin.com/comm/jobs/view/${encodeURIComponent(name)}${i}`,
        company_hint: name,
        ...(domain ? { domain } : {}),
        title,
        source: "alert",
        source_tag: "Alert",
      },
      now,
    ).companyId!;
  });
  return id;
}
const none = (id: number) =>
  open()
    .query("UPDATE companies SET discovery = 'none', discovery_at = ? WHERE id = ?")
    .run(now.toISOString(), id);
const boards = () => open().query("SELECT company_id, provider, url, found_by FROM boards ORDER BY id").all();
/** The number the prompt gives this result. */
const numberOf = (user: string, url: string) => Number(user.match(new RegExp(`(\\d+)\\. ${url} `))?.[1] ?? 0);

/** Pages as the plain read sees them; the rest answer 404. */
const pagesAre = (pages: Record<string, string>) =>
  setPageReader(async (url) => {
    if (!(url in pages)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
    return { text: pages[url]!, url } as { text: string };
  });
const ashby = (name: string, site: string | null) =>
  `<script>window.__appData = {"organization":{"organizationId":"o","name":"${name}","publicWebsite":${site ? `"${site}"` : "null"},"hostedJobsPageSlug":"x"}}</script>`;

test("no domain: one search for its site, and the model's pick is kept only with proof; then its site, then its careers search", async () => {
  const tallow = recordSignal(
    {
      url: "https://x.com/worktallow/status/7",
      company_hint: "WorkTallow",
      text: "We're hiring founding engineers at WorkTallow. https://worktallow.ai/careers",
      author: "@worktallow",
      source: "x",
      source_tag: "X",
    },
    now,
  ).companyId!;
  none(tallow);
  pagesAre({ "https://jobs.ashbyhq.com/tallow?embed=js": ashby("Tallow", "https://worktallow.ai/") });
  web["WorkTallow engineering analytics"] = [hit("https://gettallow.com/", "Tallow communications")];
  // The company index's answer by name joins the results the pick sees.
  web.WorkTallow = [hit("https://worktallow.ai", "WorkTallow")];
  model = (user) =>
    user.includes("Domains the posts give")
      ? { domain: "worktallow.ai", why: "the site its post links" }
      : user.includes("Website:")
        ? { pick: numberOf(user, "https://jobs.ashbyhq.com/tallow"), why: "its own Ashby board" }
        : { query: "WorkTallow engineering analytics" };
  applySearch(await searchBoards(searchDue(now), now), now);
  // The query and the name in the company index, then the pick of its domain from both results
  // and the posts' own domains.
  expect(asked).toEqual(["WorkTallow engineering analytics", "WorkTallow"]);
  expect(prompts.length).toBe(2);
  expect(prompts[1]).toContain("Domains the posts give: worktallow.ai");
  expect(prompts[1]).toContain("https://worktallow.ai");
  // Its posts give it: proof. The company goes back to discovery for its site; the careers search waits.
  expect(getCompany(tallow)).toMatchObject({
    domain: "worktallow.ai",
    domain_from: "post",
    discovery: "queued",
    search_at: null,
  });
  // Its site gave nothing: the careers search, and the pick on Ashby is read as its board.
  none(tallow);
  web["worktallow.ai careers"] = [hit("https://jobs.ashbyhq.com/tallow", "Jobs at Tallow")];
  answer = (mode, c) =>
    mode === "detect" && c.pages?.[0]?.includes("ashbyhq")
      ? { domain: c.domain, ok: true, detect: { provider: "ashby", careers_url: c.pages[0] } }
      : { domain: c.domain, ok: true, detect: { provider: null } };
  applySearch(await searchBoards(searchDue(now), now), now);
  expect(asked.at(-1)).toBe("worktallow.ai careers");
  expect(boards()).toEqual([
    { company_id: tallow, provider: "ashby", url: "https://jobs.ashbyhq.com/tallow", found_by: "web search" },
  ]);
  expect(getCompany(tallow)).toMatchObject({
    discovery: "found",
    discovery_note: "web search: its own Ashby board",
  });
});

test("a search hit alone never sets a domain: a pick no post gives and no homepage names is dropped", async () => {
  const tamsel = seen("Tamsel", null, ["Backend Engineer"]);
  none(tamsel);
  pagesAre({ "https://tamselbot.com/": "<title>TamselBot AI</title>" });
  web.Tamsel = [hit("https://tamselbot.com/", "TamselBot"), hit("https://www.indeed.com/q-tamsel-jobs.html")];
  model = (user) =>
    user.includes("Domains the posts give") ? { domain: "tamsel.dev", why: "a guess" } : { query: "" };
  applySearch(await searchBoards(searchDue(now), now), now);
  expect(boards()).toEqual([]);
  expect(sent).toEqual([]); // nothing to read
  expect(getCompany(tamsel)).toMatchObject({ discovery: "none", domain: null, careers_url: null });
  expect(getCompany(tamsel)?.discovery_note).toContain("no site proven (tamsel.dev unproven)");
  expect(getCompany(tamsel)?.search_at).toBe(now.toISOString());
});

test("the company index decides a domain only for a company of that very name, and its pick never merges two companies", async () => {
  // Vantle has vantle.com, stated; asked for "Vantlegate", the index lists Vantle.
  const vantle = seen("Vantle", "vantle.com", ["Software Engineer"]);
  const vantlegate = seen("Vantlegate", null, ["Security Engineer"]);
  // Mossbank News has mossbank.tv, stated; the index lists a "Mossbank" there too.
  const news = seen("Mossbank News", "mossbank.tv", ["Engineer"]);
  const mossbank = seen("Mossbank", null, ["Engineer"]);
  for (const id of [vantlegate, mossbank]) none(id);
  pagesAre({}); // no homepage names either company: only the index could decide
  web.Vantlegate = [hit("https://vantle.com", "Vantle")];
  web.Mossbank = [hit("https://mossbank.tv", "Mossbank")];
  model = (user) =>
    user.includes("Domains the posts give")
      ? { domain: user.includes("Company: Vantlegate") ? "vantle.com" : "mossbank.tv", why: "the index" }
      : { query: user.includes("Company: Vantlegate") ? "Vantlegate security" : "Mossbank streaming" };
  applySearch(await searchBoards(searchDue(now), now), now);
  // Vantle isn't Vantlegate's name: no domain, and still its own company.
  expect(getCompany(vantlegate)).toMatchObject({ name: "Vantlegate", domain: null });
  expect(getCompany(vantlegate)?.discovery_note).toContain("no site proven (vantle.com unproven)");
  // Mossbank's pick is only looked up, and Mossbank News has it proven: still two companies.
  expect(getCompany(mossbank)).toMatchObject({ name: "Mossbank", domain: null });
  expect(getCompany(mossbank)?.discovery_note).toContain("Mossbank News has it");
  expect(getCompany(news)).toMatchObject({ domain: "mossbank.tv", domain_from: "stated" });
  expect(getCompany(vantle)).toMatchObject({ domain: "vantle.com", domain_from: "stated" });
});

test("with no model to pick, companies are left for another day", async () => {
  const ids = ["Ondrel", "Pyxtan"].map((n) => seen(n, `${n.toLowerCase()}.dev`, ["Engineer"]));
  for (const id of ids) none(id);
  web["ondrel.dev careers"] = [hit("https://ondrel.dev/careers", "Careers")];
  web["pyxtan.dev careers"] = [hit("https://pyxtan.dev/careers", "Careers")];
  // No key: nothing is searched.
  deleteSecret("anthropic");
  expect(await searchBoards(searchDue(now), now)).toEqual([]);
  expect(asked).toEqual([]);
  // The month's cap reached: the first is searched (cached from here) but never picked, and the
  // rest wait too.
  setSecret("anthropic", "sk-test");
  config("[caps]\nmonth_usd = 0\n");
  expect(await searchBoards(searchDue(now), now)).toEqual([]);
  expect(asked.length).toBe(1);
  expect(prompts).toEqual([]);
  for (const id of ids) expect(getCompany(id)).toMatchObject({ discovery: "none", search_at: null });
  expect(searchDue(now).length).toBe(2);
});

test("results are kept: a company is searched once, again after 30 days; a cached query costs nothing", async () => {
  const acme = seen("Acme Robotics", "acmerobotics.com", ["Robotics Engineer"]);
  none(acme);
  await searchBoards(searchDue(now), now);
  expect(asked).toEqual(["acmerobotics.com careers"]);
  expect(searchDue(now)).toEqual([]);
  // Asked again within 30 days (another company by the same name): from the database.
  await searchBoards([getCompany(acme)!], new Date("2026-11-10T00:00:00Z"));
  expect(asked.length).toBe(1);
  // A month on, still active, it's due again and asked afresh.
  const later = new Date("2026-12-11T13:00:00Z");
  recordSignal(
    {
      url: "https://linkedin.com/comm/jobs/view/9",
      company_hint: "Acme Robotics",
      source: "alert",
      source_tag: "Alert",
    },
    later,
  );
  expect(searchDue(later).map((c) => c.id)).toEqual([acme]);
  await searchBoards(searchDue(later), later);
  expect(asked.length).toBe(2);
});

test("at most search_daily companies a day; the rest wait for tomorrow; off means no search", async () => {
  config("[discovery]\nsearch_daily = 2\n");
  const ids = ["Alpha Co", "Beta Co", "Gamma Co"].map((n) => seen(n, null, ["Engineer"]));
  for (const id of ids) none(id);
  expect((await searchBoards(searchDue(now, 10), now)).length).toBe(2);
  expect((await searchBoards(searchDue(now, 10), now)).length).toBe(0);
  expect(searchDue(now, 10).length).toBe(1);
  const tomorrow = new Date("2026-10-30T18:00:00Z");
  expect((await searchBoards(searchDue(tomorrow, 10), tomorrow)).length).toBe(1);
  config("[discovery]\nsearch = false\n");
  const delta = seen("Delta Co", null, ["Engineer"]);
  none(delta);
  asked.length = 0;
  expect(await searchBoards(searchDue(tomorrow, 10), tomorrow)).toEqual([]);
  expect(asked).toEqual([]);
});

test("placeholder names never make a company; an HN comment that names none isn't a post", () => {
  const unknown = recordSignal(
    {
      url: "https://news.ycombinator.com/item?id=1",
      company_hint: "Unknown",
      source: "hn",
      source_tag: "HN",
    },
    now,
  );
  expect(unknown.result).toBe("pending");
  const stealth = recordSignal(
    {
      url: "https://alerts.example/s",
      company_hint: "Stealth Startup",
      domain: "quietco.dev",
      source: "alert",
      source_tag: "Alert",
    },
    now,
  );
  expect(getCompany(stealth.companyId!)?.name).toBe("quietco.dev");
  expect(() => upsertCompany({ name: "Confidential" })).toThrow();
  const comment = parseComment(
    "<p>I&#x27;m applying for the Growth Lead role, specifically the lifecycle piece.</p>",
  );
  expect(isPost(comment)).toBe(false);
  expect(isPost(parseComment("Acme | Backend Engineer | Remote"))).toBe(true);
});

test("discovery's budget is a hard bound: at it, what's in flight is dropped and stays queued", async () => {
  const ids = ["Slow A", "Slow B"].map((n) =>
    seen(n, `${n.replace(" ", "").toLowerCase()}.dev`, ["Engineer"]),
  );
  writeFileSync(paths.config(), "[discovery]\nsearch = false\n");
  let answered = 0;
  answer = async (_mode, c) => {
    await Bun.sleep(1500);
    answered++;
    return {
      domain: c.domain,
      ok: true,
      detect: { provider: null, problem: "pages fetched, no board found" },
    };
  };
  const t0 = Date.now();
  expect(await discoverDue(now, { budgetMs: 300 })).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(800);
  // The sites answer after the deadline: nothing is written, both wait for the next tick.
  await Bun.sleep(1500);
  expect(answered).toBe(2);
  expect(open().query("SELECT name, discovery, discovery_note FROM companies ORDER BY name").all()).toEqual([
    { name: "Slow A", discovery: "queued", discovery_note: null },
    { name: "Slow B", discovery: "queued", discovery_note: null },
  ]);
  // Each is traced: the step and the company left.
  expect(
    failures(new Date(t0))
      .filter((f) => f.area === "deadline" && ids.includes(f.context?.company as number))
      .map((f) => [f.what, f.context?.company]),
  ).toEqual(ids.map((id) => ["discover: detection", id]));
});

test("at discovery's deadline: a pick the model already made is kept and written; none is started past it, and a pick whose read was cut waits", async () => {
  const at = (id: number, last: string) =>
    open()
      .query("UPDATE companies SET discovery = 'none', discovery_at = ?, last_signal_at = ? WHERE id = ?")
      .run(now.toISOString(), last, id);
  const late = seen("Late", "late.dev", ["Engineer"]);
  const later = seen("Later", "later.dev", ["Engineer"]);
  at(late, now.toISOString());
  at(later, "2026-10-01T00:00:00Z");
  web["late.dev careers"] = [hit("https://late.dev/blog", "Late's blog")];
  // The model answers Late's pick after the deadline: the pick is written, Later isn't searched.
  slow.model = 400;
  const t0 = Date.now();
  expect(await discoverDue(now, { budgetMs: 150 })).toEqual([]);
  expect(Date.now() - t0).toBeLessThan(350);
  await Bun.sleep(500);
  expect(asked).toEqual(["late.dev careers"]);
  expect(prompts.length).toBe(1);
  expect(getCompany(late)).toMatchObject({ search_at: now.toISOString(), discovery: "none" });
  expect(getCompany(late)?.discovery_note).toStartWith("web search");
  expect(getCompany(later)?.search_at).toBeNull();

  // A search still waiting when the deadline passes: its results are kept, no model call is made,
  // and nothing is held against the company.
  slow = { model: 0, search: 400 };
  prompts.length = 0;
  web["later.dev careers"] = [hit("https://jobs.ashbyhq.com/later", "Later jobs")];
  expect(await discoverDue(now, { budgetMs: 150 })).toEqual([]);
  await Bun.sleep(500);
  expect(prompts).toEqual([]);
  expect(getCompany(later)).toMatchObject({ search_at: null, discovery_note: null });
  expect(
    open().query("SELECT count(*) AS n FROM web_searches WHERE query = 'later.dev careers'").get(),
  ).toEqual({
    n: 1,
  });

  // Picked in time, but the reader checking the pick is cut at the deadline: not written.
  slow = { model: 0, search: 0 };
  model = (user) => ({ pick: numberOf(user, "https://jobs.ashbyhq.com/later") });
  setRunner(async (mode, cs) => {
    await Bun.sleep(400);
    return pastDeadline() ? [] : standIn(mode, cs);
  });
  try {
    expect(await discoverDue(now, { budgetMs: 150 })).toEqual([]);
    await Bun.sleep(500);
  } finally {
    setRunner(standIn);
  }
  expect(prompts.length).toBe(1);
  expect(getCompany(later)).toMatchObject({ search_at: null, discovery: "none", discovery_note: null });
  expect(boards()).toEqual([]);
  expect(
    failures(new Date(t0))
      .filter((f) => f.area === "deadline" && f.context?.company === later)
      .map((f) => f.what),
  ).toEqual(["web search", "web search: readers on its pick"]);
});

test("the boards step ends only once the discovery steps its deadline left going have written", async () => {
  const tamsel = seen("Tamsel", null, ["Engineer"]);
  none(tamsel);
  config("[discovery]\ntick_seconds = 0.1\n");
  model = (user) =>
    user.includes("Domains the posts give")
      ? { domain: "", why: "none is clearly its own" }
      : { query: "Tamsel note app" };
  slow.model = 300;
  await runBoardsStep(now, () => {});
  // The query's model call outlived the deadline; its search was made before the step ended.
  expect(asked).toEqual(["Tamsel note app", "Tamsel"]);
});

// --- a website for a company that came with a board ------------------------------------------

/** A company a board search lead named: its posting on its board, the board found from it, no website. */
function lead(name: string, board: string, provider = "greenhouse"): number {
  const id = recordSignal(
    {
      url: `${board}/jobs/1`,
      company_hint: name,
      title: "Software Engineer",
      kind: "posting",
      source: "board-search",
      source_tag: "Board search",
    },
    now,
  ).companyId!;
  addBoard(id, provider, board, "lead", now);
  return id;
}
/** The site search's two model calls: its query, then its pick from the results. */
const sitePick = (query: string, domain: string) => (user: string) =>
  user.includes("Domains the posts give") ? { domain, why: "its own site" } : { query };

test("a company that came with a board and no website gets one with proof: it keeps its board, and its stand-in thread moves to the real one", async () => {
  const quillmark = lead("Quillmark, Inc.", "https://job-boards.greenhouse.io/quillmark");
  const standIn = threadIdOf(getCompany(quillmark)!);
  expect(standIn).toBe("quillmark-inc.no-domain");
  append(standIn, {
    actor: "ats",
    kind: "signal",
    data: { company: "Quillmark, Inc.", title: "Software Engineer" },
  });
  expect(siteDue(now).map((c) => c.id)).toEqual([quillmark]);
  // Never the board search: it has a board.
  expect(searchDue(now)).toEqual([]);
  pagesAre({
    "https://quillmark.com/": "<title>Quillmark: Payroll, Benefits, and HR for Small Businesses</title>",
  });
  web["Quillmark payroll HR"] = [
    hit("https://quillmark.com/", "Quillmark"),
    hit("https://www.linkedin.com/company/quillmark"),
  ];
  model = sitePick("Quillmark payroll HR", "quillmark.com");
  // Its site's careers pages give its own board.
  answer = (_m, c) =>
    c.site === "quillmark.com"
      ? {
          domain: c.domain,
          ok: true,
          detect: {
            provider: "greenhouse",
            careers_url: "https://job-boards.greenhouse.io/quillmark/jobs/7",
          },
        }
      : { domain: c.domain, ok: true, detect: { provider: null } };
  const found = await discoverDue(now, { budgetMs: 10_000 });
  expect(found).toEqual([
    { companyId: quillmark, how: expect.stringContaining("its site quillmark.com (homepage)") },
  ]);
  expect(asked).toEqual(["Quillmark payroll HR", "Quillmark, Inc."]);
  expect(getCompany(quillmark)).toMatchObject({
    domain: "quillmark.com",
    domain_from: "homepage",
    discovery: "found",
    discovery_note: "lead",
    search_at: now.toISOString(),
  });
  expect(boards()).toEqual([
    {
      company_id: quillmark,
      provider: "greenhouse",
      url: "https://job-boards.greenhouse.io/quillmark",
      found_by: "lead",
    },
  ]);
  expect(siteDue(now)).toEqual([]);
  adoptStandIns();
  expect(existsSync(paths.thread(standIn))).toBe(false);
  expect(read("quillmark.com").map((e) => e.data.company)).toEqual(["Quillmark, Inc."]);
  answer = (_m, c) => ({ domain: c.domain, ok: true, detect: { provider: null } });
});

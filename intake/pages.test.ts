// Reading a careers page no reader reads from its plain HTML: a board the rendered page names, else
// the small model on the rendered page; and that page's refresh, with its limits. The browser,
// the runner, the plain page and the model are stand-ins here; never a real call.
import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { plainText, textHash } from "../ats/read-page.ts";
import { deadline, type RunnerCompany, runRunner, setPageReader, setRunner } from "../ats/reader.ts";
import { openRenderer, type Rendered, setRenderer } from "../ats/render.ts";
import { pickSitemap, sitemapLocs } from "../ats/sitemap.ts";
import { DAY, open } from "../core/db.ts";
import { politeGet } from "../core/http.ts";
import { setSecret } from "../core/keychain.ts";
import { entries } from "../core/ledger.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { getCompany, upsertCompany } from "./companies.ts";
import { addBoard } from "./discover.ts";
import { pagesDue, readPages } from "./pages.ts";
import { type Board, readBoards } from "./refresh.ts";

const data = tempData();
const realFetch = globalThis.fetch;
afterAll(() => {
  setRunner(runRunner);
  setRenderer(openRenderer);
  // The plain page as read for real: the stand-ins below move the test clock on every read.
  setPageReader((u, v = {}) => politeGet(u, { accept: "text/html", ...v }));
  setSystemTime();
  globalThis.fetch = realFetch;
  data.cleanup();
});

type Answer = {
  roles: { title: string; url: string }[];
  employers: string[];
  board: string;
  listing?: string;
  note: string;
};
let answer: Answer = { roles: [], employers: [], board: "", note: "no openings listed" };
let answers: Record<string, Answer> = {}; // by the page the model is asked to read
let asked = 0;
let slow = 0; // ms the model takes to answer
// The model (on the API key) and robots.txt, through fetch.
let refuses: string[] = []; // hosts whose robots.txt refuses everything
const robots: Record<string, string> = {}; // other robots.txt files, by host
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = new URL(String(url));
  if (u.pathname === "/robots.txt")
    return new Response(
      refuses.includes(u.hostname) ? "User-agent: *\nDisallow: /" : (robots[u.hostname] ?? ""),
    );
  asked++;
  if (slow) await Bun.sleep(slow);
  const user = String(JSON.parse(String(init?.body ?? "{}")).messages?.[0]?.content ?? "");
  const pageUrl = user.match(/\nPage: (\S+)/)?.[1] ?? "";
  return Response.json({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(answers[pageUrl] ?? answer) }],
    usage: { input_tokens: 2000, output_tokens: 300 },
  });
}) as unknown as typeof fetch;

// The plain page, the rendered page and the runner, as each site answers.
let plain: (url: string) => string | Error = () => "<html><body><div id=app></div></body></html>";
setPageReader(async (url) => {
  const p = plain(url);
  if (p instanceof Error) throw p;
  return { text: p };
});
const page = (o: Partial<Rendered> = {}): Rendered => ({
  url: "https://acme.dev/careers",
  status: 200,
  text: "Careers at Acme\nOpen roles\nFounding Engineer\nSan Francisco\nApply",
  links: [{ href: "https://acme.dev/careers/founding-engineer", text: "Founding Engineer" }],
  requests: [],
  frames: [],
  html: "<div></div>",
  ...o,
});
let rendered: (url: string) => Rendered = () => page();
let renders = 0;
setRenderer(async () => ({
  render: async (url) => {
    renders++;
    return rendered(url);
  },
  close: async () => {},
}));
let detect: (c: RunnerCompany) => Record<string, unknown> = () => ({ provider: null });
setRunner(async (_mode, cs) => cs.map((c) => ({ domain: c.domain, ok: true, detect: detect(c) })));

const now = new Date("2026-10-30T12:00:00Z");
const hours = (iso: string | null) => (Date.parse(iso!) - now.getTime()) / 3_600_000;
beforeEach(() => {
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies;",
  );
  setSecret("anthropic", "sk-test");
  writeFileSync(paths.config(), "");
  answer = { roles: [], employers: [], board: "", note: "no openings listed" };
  answers = {};
  asked = 0;
  slow = 0;
  renders = 0;
  refuses = [];
  plain = () => "<html><body><div id=app></div></body></html>";
  rendered = () => page();
  detect = () => ({ provider: null });
});

/** A company discovery left with a careers page no reader read. */
function unreadable(name = "Acme", url = "https://acme.dev/careers"): number {
  const id = upsertCompany({ name, domain: new URL(url).hostname.replace(/^(www|help)\./, "") });
  open()
    .query("UPDATE companies SET discovery = 'unreadable', careers_url = ?, last_signal_at = ? WHERE id = ?")
    .run(url, now.toISOString(), id);
  return id;
}
const boardsOf = (id: number) => open().query("SELECT * FROM boards WHERE company_id = ?").all(id) as Board[];
const rolesOf = (id: number) =>
  open()
    .query("SELECT title, url FROM roles WHERE company_id = ? AND closed_at IS NULL ORDER BY title")
    .all(id);

test("a job board the rendered page calls is read by its provider; the model isn't asked", async () => {
  const id = unreadable();
  rendered = () => page({ requests: ["https://api.greenhouse.io/v1/boards/acme98/jobs?content=true"] });
  detect = (c) =>
    c.links?.some((l) => l.includes("api.greenhouse.io/v1/boards/acme98"))
      ? {
          provider: "greenhouse",
          careers_url: "https://boards.greenhouse.io/acme98",
          method: "rendered page",
        }
      : { provider: null };
  await readPages(pagesDue(), now);
  expect(boardsOf(id).map((b) => [b.provider, b.url, b.found_by])).toEqual([
    ["greenhouse", "https://boards.greenhouse.io/acme98", "rendered page"],
  ]);
  expect(getCompany(id)?.discovery).toBe("found");
  expect(asked).toBe(0);
});

test("a board the page only links to counts when it bears the company's name", async () => {
  const id = unreadable();
  rendered = () =>
    page({
      links: [
        { href: "https://jobs.lever.co/otherco", text: "Jobs at OtherCo" },
        { href: "https://jobs.lever.co/acme", text: "Our openings" },
      ],
    });
  const sent: string[][] = [];
  detect = (c) => {
    sent.push(c.links ?? []);
    const lever = c.links?.find((l) => l.includes("jobs.lever.co"));
    return lever ? { provider: "lever", careers_url: lever } : { provider: null };
  };
  await readPages(pagesDue(), now);
  expect(sent[0]).not.toContain("https://jobs.lever.co/otherco");
  expect(boardsOf(id).map((b) => b.url)).toEqual(["https://jobs.lever.co/acme"]);
});

test("the model reads the rendered page: only roles the page shows, read plain when the plain page shows them", async () => {
  const id = unreadable();
  answer = {
    roles: [
      { title: "Founding Engineer", url: "https://acme.dev/careers/founding-engineer" },
      { title: "Head of Growth", url: "https://acme.dev/careers/head-of-growth" }, // not on the page
    ],
    employers: ["Acme"],
    board: "",
    note: "",
  };
  plain = () =>
    '<h1>Open roles</h1><a href="/careers/founding-engineer">Founding Engineer</a><p>San Francisco</p>';
  await readPages(pagesDue(), now);
  const [b] = boardsOf(id);
  expect(b).toMatchObject({ provider: "careers-page", url: "https://acme.dev/careers", render: 0 });
  expect(rolesOf(id)).toEqual([
    { title: "Founding Engineer", url: "https://acme.dev/careers/founding-engineer" },
  ]);
  // The model reads it again once a day at most: it is read daily.
  expect(hours(b!.next_read_at)).toBeGreaterThan(23);
  expect(getCompany(id)?.discovery).toBe("found");
});

test("at discovery's deadline: a page the model is reading is kept when it answers; no model call or page is started past it", async () => {
  const acme = unreadable();
  const beta = unreadable("Beta", "https://beta.dev/careers");
  open().query("UPDATE companies SET last_signal_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(beta);
  answer = {
    roles: [{ title: "Founding Engineer", url: "https://acme.dev/careers/founding-engineer" }],
    employers: ["Acme"],
    board: "",
    note: "",
  };
  // The deadline passes while the model reads Acme's page: its answer is written, Beta's page waits.
  slow = 300;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  const done = await deadline.run(ctl.signal, () => readPages(pagesDue(), now));
  expect(done.map((f) => f.companyId)).toEqual([acme]);
  expect(asked).toBe(1);
  expect(renders).toBe(1);
  expect(rolesOf(acme)).toEqual([
    { title: "Founding Engineer", url: "https://acme.dev/careers/founding-engineer" },
  ]);
  expect(getCompany(acme)?.discovery).toBe("found");
  expect(getCompany(beta)).toMatchObject({
    discovery: "unreadable",
    careers_url: "https://beta.dev/careers",
  });
  // Past it already when the page is rendered: the model isn't asked, and the page stays unreadable.
  slow = 0;
  const past = new AbortController();
  rendered = (url) => {
    past.abort();
    return page({ url });
  };
  expect(await deadline.run(past.signal, () => readPages([getCompany(beta)!], now))).toEqual([]);
  expect(asked).toBe(1);
  expect(getCompany(beta)?.discovery).toBe("unreadable");
});

test("two companies whose careers pages share a host: the second's roles are never written onto the first's board, and the refusal stays its note", async () => {
  const alpha = upsertCompany({ name: "Alpha", domain: "alpha.dev" });
  addBoard(alpha, "careers-page", "https://sites.google.com/view/alpha/jobs", "careers page", now);
  const beta = upsertCompany({ name: "Beta" });
  open()
    .query("UPDATE companies SET discovery = 'unreadable', careers_url = ?, last_signal_at = ? WHERE id = ?")
    .run("https://sites.google.com/view/beta/jobs", now.toISOString(), beta);
  rendered = (url) => page({ url, text: "Beta is hiring\nFounding Engineer" });
  answer = {
    roles: [{ title: "Founding Engineer", url: "https://sites.google.com/view/beta/jobs" }],
    employers: ["Beta"],
    board: "",
    note: "",
  };
  const [found] = await readPages(pagesDue(), now);
  expect(found).toEqual({ companyId: beta, how: expect.stringContaining("is Alpha's board") });
  expect(open().query("SELECT count(*) AS n FROM roles").get()).toEqual({ n: 0 });
  expect(boardsOf(alpha)).toEqual([
    expect.objectContaining({
      url: "https://sites.google.com/view/alpha/jobs",
      text_hash: null,
      model_at: null,
    }),
  ]);
  expect(boardsOf(beta)).toEqual([]);
  expect(getCompany(beta)).toMatchObject({
    discovery: "none",
    discovery_note: expect.stringContaining("is Alpha's board"),
  });
});

/** A company with this proven domain whose careers page discovery found on another site. */
function elsewhere(name: string, domain: string, url: string): number {
  const id = upsertCompany({ name, domain });
  open()
    .query("UPDATE companies SET discovery = 'unreadable', careers_url = ?, last_signal_at = ? WHERE id = ?")
    .run(url, now.toISOString(), id);
  return id;
}

test("a careers page on another site is read only when it links back to the proven domain and names the company (Tallowly's lifeattallowly.com)", async () => {
  const tallowly = elsewhere("Tallowly", "tallowly.com", "https://www.lifeattallowly.com/en/jobs");
  const jobs = {
    text: "Jobs\nSenior Backend Engineer\nSydney",
    links: [
      {
        href: "https://www.lifeattallowly.com/en/jobs/senior-backend-engineer",
        text: "Senior Backend Engineer",
      },
      { href: "https://www.tallowly.com/", text: "Tallowly" },
    ],
  };
  rendered = (url) =>
    page({ url, ...jobs, html: "<title>Jobs | Life at Tallowly</title><footer>tallowly.com</footer>" });
  answer = {
    roles: [{ title: "Senior Backend Engineer", url: jobs.links[0]!.href }],
    employers: ["Tallowly"],
    board: "",
    note: "",
  };
  await readPages(pagesDue(), now);
  expect(getCompany(tallowly)?.discovery).toBe("found");
  expect(rolesOf(tallowly)).toEqual([{ title: "Senior Backend Engineer", url: jobs.links[0]!.href }]);
  // Another company's page: it names the company (a short name many share) but doesn't link back.
  const vantle = elsewhere("Vantle", "vantle.xyz", "https://vantleexchange.com/careers");
  rendered = (url) =>
    page({ url, ...jobs, links: [jobs.links[0]!], html: "<title>Vantle Exchange careers</title>" });
  const asked0 = asked;
  await readPages(pagesDue(), now);
  // And one that links back but whose title names another company (Skimmer's pick on skimmerfi.com).
  const skimmer = elsewhere("Skimmer", "skimmer.fi", "https://www.skimmerfi.com/careers");
  rendered = (url) =>
    page({
      url,
      ...jobs,
      links: [...jobs.links, { href: "https://skimmer.fi/", text: "partner" }],
      html: "<title>LoanSkim | Careers</title>",
    });
  await readPages(pagesDue(), now);
  for (const id of [vantle, skimmer]) {
    expect(getCompany(id)?.discovery).toBe("none");
    expect(getCompany(id)?.discovery_note).toContain("is another site's");
    expect(boardsOf(id)).toEqual([]);
  }
  expect(asked).toBe(asked0); // the model never read them
});

test("a front page that links to its full listing on the same site has that one page read, and the listing is kept as its careers page", async () => {
  const front = "https://acme.dev/careers";
  const list = "https://acme.dev/careers/open-positions";
  const id = unreadable("Acme", front);
  const role = (n: number) => ({ title: `Engineer ${n}`, url: `${list}/${n}` });
  rendered = (url) =>
    url.startsWith(list)
      ? page({
          url,
          text: `Open positions\n${[1, 2, 3].map((n) => `Engineer ${n}`).join("\n")}`,
          links: [1, 2, 3].map((n) => ({ href: role(n).url, text: role(n).title })),
        })
      : page({
          url,
          text: "Careers at Acme\nFeatured: Engineer 1\nSee open jobs",
          links: [
            { href: role(1).url, text: "Engineer 1" },
            { href: `${list}?utm_source=careers`, text: "See open jobs" },
            { href: "https://elsewhere.com/jobs", text: "Partner jobs" },
          ],
        });
  answers[front] = {
    roles: [role(1)],
    employers: ["Acme"],
    board: "",
    listing: `${list}?utm_source=careers`,
    note: "one featured role",
  };
  answers[`${list}?utm_source=careers`] = {
    roles: [1, 2, 3].map(role),
    employers: ["Acme"],
    board: "",
    listing: "",
    note: "",
  };
  answers[list] = answers[`${list}?utm_source=careers`]!;
  // It had the front page as its board (as Tallowly's did): one careers-page board a host, now the listing.
  addBoard(id, "careers-page", front, "careers page, read by the model", now);
  open().query("UPDATE companies SET discovery = 'unreadable' WHERE id = ?").run(id);
  await readPages(pagesDue(), now);
  expect(rolesOf(id)).toHaveLength(3);
  expect(boardsOf(id).map((b) => b.url)).toEqual([`${list}?utm_source=careers`]);
  expect(getCompany(id)?.careers_url).toBe(`${list}?utm_source=careers`);
  expect(asked).toBe(2); // the front page, then the listing; never a third
});

test("robots.txt refusing the page, or the board it names, leaves the company blocked", async () => {
  const id = unreadable();
  plain = () => new Error("robots.txt disallows https://acme.dev/careers");
  await readPages(pagesDue(), now);
  expect(getCompany(id)?.discovery).toBe("blocked");
  expect(renders).toBe(0);
  // Ondrel's: the page sends people to a board whose robots.txt refuses readers.
  const ondrel = unreadable("Ondrel", "https://help.ondrel.com/ondrel/company/hiring-ondrel.html");
  plain = () => "<p>See our current openings</p>";
  rendered = (url) =>
    page({
      url,
      links: [{ href: "https://ondrel.peopleforce.io/careers", text: "current openings" }],
      text: "current openings",
    });
  answer = {
    roles: [],
    employers: [],
    board: "https://ondrel.peopleforce.io/careers",
    note: "roles are on the linked board",
  };
  refuses = ["ondrel.peopleforce.io"];
  await readPages(pagesDue(), now);
  expect(getCompany(ondrel)).toMatchObject({ discovery: "blocked" });
  expect(getCompany(ondrel)?.discovery_note).toContain("ondrel.peopleforce.io");
});

test("past the page cap, pages wait untouched: nothing is rendered", async () => {
  const id = unreadable();
  writeFileSync(paths.config(), "[caps]\npages_month_usd = 0\n");
  expect(await readPages(pagesDue(), now)).toEqual([]);
  expect(renders).toBe(0);
  expect(getCompany(id)?.discovery).toBe("unreadable");
});

// --- refresh --------------------------------------------------------------------------------

/** A careers page the model read, `ago` hours ago, with this text and one role. */
function modelPage(o: { text: string; ago: number; render?: number }): Board {
  const id = upsertCompany({ name: "Acme", domain: "acme.dev" });
  const board = addBoard(
    id,
    "careers-page",
    "https://acme.dev/careers",
    "careers page, read by the model",
    now,
  ).board!;
  const at = new Date(now.getTime() - o.ago * 3_600_000).toISOString();
  open()
    .query("UPDATE boards SET render = ?, text_hash = ?, model_at = ?, last_read_at = ? WHERE id = ?")
    .run(o.render ?? 0, textHash(o.text), at, at, board.id);
  return open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as Board;
}

test("refresh: the same text isn't read by the model again; changed text waits a day, then is read", async () => {
  const html = '<p>Open roles</p><a href="/careers/founding-engineer">Founding Engineer</a>';
  plain = () => html;
  let b = modelPage({ text: plainText(html, "https://acme.dev/careers").text, ago: 30 });
  expect((await readBoards([b], now))[0]?.status).toBe("unchanged");
  expect(asked).toBe(0);
  // Changed, read by the model two hours ago: it waits for its next read, as it was.
  open().exec("DELETE FROM boards");
  b = modelPage({ text: "an older page", ago: 2 });
  expect((await readBoards([b], now))[0]?.status).toBe("unchanged");
  expect(asked).toBe(0);
  expect(
    hours((open().query("SELECT next_read_at FROM boards").get() as Board).next_read_at),
  ).toBeGreaterThan(23);
  // A day on: the model reads it.
  open().exec("DELETE FROM boards");
  b = modelPage({ text: "an older page", ago: 25 });
  answer = {
    roles: [{ title: "Founding Engineer", url: "https://acme.dev/careers/founding-engineer" }],
    employers: ["Acme"],
    board: "",
    note: "",
  };
  expect((await readBoards([b], now))[0]).toMatchObject({ status: "changed", listed: 1 });
  expect(asked).toBe(1);
  // Its ledger line names the board it read for.
  expect(entries().at(-1)).toMatchObject({ station: "read-page", board: b.id });
});

test("refresh: a job site's feed held as a company's board, its roles at many employers, is refused: out of use, its roles out of the Inbox", async () => {
  // An HN post by a job site, under one of its employers' names, stated the job site's feed.
  const id = upsertCompany({ name: "Quillmore", domain: "postwork.dev" });
  const board = addBoard(id, "careers-page", "https://postwork.dev/rss", "careers page", now).board!;
  const feed = (employers: string[]) =>
    `<?xml version="1.0"?><rss><channel>${employers
      .map(
        (e, i) =>
          `<item><title>Engineer ${i} @ ${e} [$90,000 - 120,000]</title><link>https://postwork.dev/jobs/${i}</link></item>`,
      )
      .join("")}</channel></rss>`;
  const insert = open().query(
    `INSERT INTO roles (board_id, company_id, ext_id, url, title, first_seen, last_seen, fits, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  for (const [n, state] of [
    [0, "new"],
    [1, "new"],
    [2, "applied"],
  ] as const)
    insert.run(
      board.id,
      id,
      `https://postwork.dev/jobs/${n}`,
      `https://postwork.dev/jobs/${n}`,
      `Engineer ${n} @ Brackenfield`,
      now.toISOString(),
      now.toISOString(),
      state,
    );
  plain = (url) =>
    url === "https://postwork.dev/rss"
      ? feed(["Brackenfield", "Ostrava Labs", "Pellwick", "Tamsin & Co"])
      : "<html></html>";
  const row = () => open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as Board;
  expect((await readBoards([row()], now))[0]).toMatchObject({ status: "failed", closed: 3, listed: 0 });
  expect(row()).toMatchObject({
    status: "broken",
    next_read_at: null,
    role_count: 0,
    last_error:
      "no roles on the page: its roles aren't Quillmore's: Brackenfield, Ostrava Labs, Pellwick, Tamsin & Co",
  });
  // Its roles close, so none is in the Inbox; one you applied to keeps its state.
  expect(open().query("SELECT state, closed_at IS NOT NULL AS closed FROM roles ORDER BY id").all()).toEqual([
    { state: "new", closed: 1 },
    { state: "new", closed: 1 },
    { state: "applied", closed: 1 },
  ]);
  expect(getCompany(id)).toMatchObject({
    discovery: "none",
    discovery_note:
      "its careers page, checked: its roles aren't Quillmore's: Brackenfield, Ostrava Labs, Pellwick, Tamsin & Co",
  });
  // One company's own feed is still read.
  open().exec("DELETE FROM roles; DELETE FROM boards;");
  const own = addBoard(id, "careers-page", "https://postwork.dev/rss", "careers page", now).board!;
  plain = (url) =>
    url === "https://postwork.dev/rss"
      ? feed(["Quillmore", "Quillmore", "Quillmore", "Quillmore"])
      : "<html></html>";
  const ownRow = open().query("SELECT * FROM boards WHERE id = ?").get(own.id) as Board;
  expect((await readBoards([ownRow], now))[0]).toMatchObject({ status: "changed", listed: 4 });
});

test("no browser on this Mac: a rendered page's read isn't a failure, and discovery leaves its page waiting", async () => {
  rendered = () => {
    throw new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell\n╔══════╗");
  };
  const b = modelPage({ text: "an older page", ago: 30, render: 1 });
  expect(await readBoards([b], now)).toEqual([]);
  expect(open().query("SELECT status, fails, next_read_at FROM boards").get()).toEqual({
    status: "ok",
    fails: 0,
    next_read_at: b.next_read_at,
  });
  const id = unreadable("Beta", "https://beta.dev/careers");
  expect(await readPages(pagesDue(), now)).toEqual([]);
  expect(getCompany(id)?.discovery).toBe("unreadable");
});

test("a careers page whose robots.txt names its roles' sitemap is read from it: new pages once, the model's rows filled, a role it drops closes", async () => {
  expect(
    pickSitemap("https://www.tallowlycareers.com/jobsearch/", [
      "https://www.tallowlycareers.com/sitemap/www_tallowlycareers_com_sitemap.xml.gz",
      "https://www.tallowlycareers.com/jobsearch/sitemap.xml",
    ]),
  ).toBe("https://www.tallowlycareers.com/jobsearch/sitemap.xml");
  expect(pickSitemap("https://careers.acme.dev/", ["https://careers.acme.dev/sitemap.xml"])).toBeNull();
  expect(pickSitemap("https://acme.dev/careers", ["https://acme.dev/jobs-sitemap.xml"])).toBe(
    "https://acme.dev/jobs-sitemap.xml",
  );
  expect(
    sitemapLocs("<sitemapindex><sitemap><loc>https://a.dev/s1.xml</loc></sitemap></sitemapindex>"),
  ).toEqual([]);

  // robots.txt is fetched only from a host that resolves to a public address.
  robots["example.org"] =
    "User-agent: *\nDisallow: /ajax/\n\nSitemap: https://example.org/jobsearch/sitemap.xml\n";
  const id = upsertCompany({ name: "Example", domain: "example.org" });
  const board = addBoard(id, "careers-page", "https://example.org/jobsearch/", "careers site", now).board!;
  // A role the model read: no place (so it fits), no date, its link without the sitemap's trailing slash.
  open()
    .query(
      `INSERT INTO roles (board_id, company_id, ext_id, url, title, location, first_seen, last_seen, fits, state)
       VALUES (?, ?, 'https://example.org/jobs/1', 'https://example.org/jobs/1', 'Engineer', '', ?, ?, 1, 'archived')`,
    )
    .run(board.id, id, now.toISOString(), now.toISOString());
  const day = (n: number) => new Date(now.getTime() - n * DAY).toISOString();
  const posting = (n: number, title: string, posted: string) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title,
      datePosted: posted,
      identifier: { "@type": "PropertyValue", value: `req-${n}` },
      jobLocation: [{ "@type": "Place", address: { addressLocality: "Denver", addressRegion: "CO" } }],
      description: "<p>Build &amp; ship</p>",
    })}</script>`;
  let listed = [1, 2, 3];
  const read: string[] = [];
  plain = (url) => {
    if (url === "https://example.org/jobsearch/sitemap.xml")
      return `<urlset>${listed.map((n) => `<url><loc>https://example.org/jobs/${n}/</loc></url>`).join("")}</urlset>`;
    const n = Number(url.match(/\/jobs\/(\d+)\//)?.[1]);
    if (!n) return "<html></html>";
    read.push(url);
    return posting(n, n === 1 ? "Engineer" : `Engineer ${n}`, n === 3 ? day(40) : day(1));
  };
  const b = () => open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as Board;
  expect((await readBoards([b()], now))[0]).toMatchObject({ status: "changed" });
  expect(b().sitemap).toBe("https://example.org/jobsearch/sitemap.xml");
  const rows = () =>
    open()
      .query(
        "SELECT url, title, location, posted_at IS NOT NULL AS dated, state, closed_at FROM roles ORDER BY url",
      )
      .all();
  expect(rows()).toEqual([
    {
      url: "https://example.org/jobs/1/",
      title: "Engineer",
      location: "Denver, CO",
      dated: 1,
      state: "archived",
      closed_at: null,
    },
    {
      url: "https://example.org/jobs/2/",
      title: "Engineer 2",
      location: "Denver, CO",
      dated: 1,
      state: "new",
      closed_at: null,
    },
    {
      url: "https://example.org/jobs/3/",
      title: "Engineer 3",
      location: "Denver, CO",
      dated: 1,
      state: "archived",
      closed_at: null,
    },
  ]);
  // Read again with role 3 gone from the sitemap: no page is read twice; role 3 closes on its second miss.
  read.length = 0;
  listed = [1, 2];
  await readBoards([b()], new Date(now.getTime() + 7 * 3_600_000));
  await readBoards([b()], new Date(now.getTime() + 14 * 3_600_000));
  expect(read).toEqual([]);
  expect((rows() as { closed_at: string | null }[]).map((r) => r.closed_at !== null)).toEqual([
    false,
    false,
    true,
  ]);
});

// A careers page whose sitemap is known; its role pages each take a minute of the test's clock
// (Date.now() stands still otherwise), so a pass's time is counted in pages.
function sitemapBoard(name: string, host: string): number {
  const id = upsertCompany({ name, domain: host });
  const board = addBoard(id, "careers-page", `https://${host}/jobs/`, "careers site", now).board!;
  open()
    .query("UPDATE boards SET sitemap = ? WHERE id = ?")
    .run(`https://${host}/jobs/sitemap.xml`, board.id);
  return board.id;
}
const boardRow = (id: number) => open().query("SELECT * FROM boards WHERE id = ?").get(id) as Board;
const urlset = (host: string, ns: number[]) =>
  `<urlset>${ns.map((n) => `<url><loc>https://${host}/jobs/${n}/</loc></url>`).join("")}</urlset>`;
const roleHtml = (n: number) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: `Engineer ${n}`,
    datePosted: now.toISOString(),
    jobLocation: [{ "@type": "Place", address: { addressLocality: "Denver", addressRegion: "CO" } }],
  })}</script>`;
let clock = 0;
const aMinutePasses = () => {
  clock += 60_000;
  setSystemTime(new Date(clock));
};

test("sitemap boards read in one pass share its time; a board whose lease another read took meanwhile is left to it", async () => {
  const { setSitemapBudget } = await import("./refresh.ts");
  const hosts = ["one.example.com", "two.example.com", "three.example.com"];
  const ids = hosts.map((h, i) => sitemapBoard(`Board ${i + 1}`, h));
  const read: string[] = [];
  let onSitemap = (_host: string) => {};
  plain = (url) => {
    const host = new URL(url).hostname;
    if (url.endsWith("/sitemap.xml")) {
      onSitemap(host);
      return urlset(host, [1, 2, 3]);
    }
    const n = Number(url.match(/\/jobs\/(\d+)\//)?.[1]);
    read.push(`${host.split(".")[0]} ${n}`);
    aMinutePasses();
    return roleHtml(n);
  };
  clock = Date.now();
  setSystemTime(new Date(clock));
  setSitemapBudget(3.5 * 60_000); // four pages a pass
  try {
    // Four pages in all, not four a board.
    await readBoards(ids.map(boardRow), now);
    expect(read).toEqual(["one 1", "one 2", "one 3", "two 1"]);
    // The next pass: while it reads the second board, another read takes the third's lease (it
    // had run out). The third is that read's: this pass neither reads it nor lets it go.
    read.length = 0;
    const theirs = new Date(now.getTime() + 60 * 60_000).toISOString();
    onSitemap = (host) => {
      if (host === hosts[1])
        open().query("UPDATE boards SET lease_until = ? WHERE id = ?").run(theirs, ids[2]!);
    };
    const outcomes = await readBoards(ids.map(boardRow), new Date(now.getTime() + 20 * 60_000));
    expect(read).toEqual(["two 2", "two 3"]);
    expect(outcomes.map((o) => o.board)).toEqual(ids.slice(0, 2));
    expect(boardRow(ids[2]!).lease_until).toBe(theirs);
  } finally {
    setSitemapBudget(null);
    setSystemTime();
  }
});

import { afterAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import {
  dismissCompany,
  getCompany,
  recordSignal,
  upsertCompany,
  watchCompany,
} from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { applyRead, type Board } from "../intake/refresh.ts";
import { chooseCompany, chooseRole } from "./choose.ts";
import {
  companyRoles,
  inboxCompany,
  inboxCount,
  inboxMetros,
  inboxPage,
  inboxSources,
  inCity,
  otherCompany,
  othersCount,
  othersPage,
  PAGE,
} from "./query.ts";

const data = tempData();
afterAll(data.cleanup);
beforeEach(() => {
  index.close();
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies;",
  );
  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: { title_include: ["Engineer"] } }));
});

const now = new Date("2026-10-28T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const job = (id: string, title: string, location = "Remote") => ({
  id,
  title,
  url: `https://jobs.lever.co/acme/${id}`,
  location,
  postedAt: null as string | null,
});
/** A company with a board already read once, then read again with these jobs: they are news. */
function withRoles(name: string, domain: string, jobs: ReturnType<typeof job>[], at = now) {
  const id = upsertCompany({ name, domain });
  const board = addBoard(id, "lever", `https://jobs.lever.co/${domain}`, "test", at).board!;
  applyRead(board, { ok: true, jobs: [] }, at);
  applyRead(open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as Board, { ok: true, jobs }, at);
  return id;
}

test("the Inbox is companies with new roles that fit; one a signal named with nothing that fits, watched and dismissed ones aren't in it", () => {
  const acme = withRoles("Acme", "acme.dev", [
    job("1", "Backend Engineer"),
    job("2", "Recruiter"),
    job("3", "Data Engineer", "Denver, CO"),
  ]);
  const hn = (id: number, name: string, domain: string, at: Date) =>
    recordSignal(
      {
        url: `https://news.ycombinator.com/item?id=${id}`,
        company_hint: name,
        domain,
        title: "Founding Engineer",
        source: "hn",
        source_tag: "HN",
      },
      at,
    ).companyId!;
  hn(1, "Acme", "acme.dev", ago(1));
  // A signal alone, nothing open that fits: that company is on the Signals screen, not here.
  const orbit = hn(2, "Orbit", "orbit.health", ago(1));
  const old = hn(3, "Stale", "stale.dev", ago(30));
  // Watched after its roles were seen: none is new since, so it isn't in the Inbox.
  const watched = withRoles("Watched", "watched.dev", [job("w", "Engineer")], ago(1));
  watchCompany(watched, "manual", now);
  const page = inboxPage({}, now);
  expect(page.companies.map((c) => [c.name, c.roles])).toEqual([["Acme", 2]]);
  expect(page.companies[0]?.signals).toEqual([
    {
      source: "hn",
      tag: "HN",
      title: "Founding Engineer",
      url: "https://news.ycombinator.com/item?id=1",
      at: ago(1).toISOString(),
    },
  ]);
  expect(inboxCount({}, now)).toBe(1);
  expect(page.companies.map((c) => c.id)).not.toContain(orbit);
  expect(page.companies.map((c) => c.id)).not.toContain(old);
  // Remote only: Acme's Denver role doesn't count.
  expect(inboxPage({ remote: true }, now).companies.map((c) => [c.name, c.roles])).toEqual([["Acme", 1]]);
  // The source switch: companies a signal from that source named.
  expect(inboxSources(now)).toEqual([{ source: "hn", tag: "HN" }]);
  expect(inboxPage({ source: "hn" }, now).companies.map((c) => c.id)).toEqual([acme]);
  // 21 days on, untouched roles and signals have left by themselves.
  expect(inboxPage({}, new Date(now.getTime() + 22 * 86_400_000)).companies).toEqual([]);
  dismissCompany(acme, now);
  expect(inboxCompany(acme, {}, now)).toBeNull();
});

test("Dismiss, Apply and Watch are one UPDATE each; Apply opens the thread with the role", () => {
  const acme = withRoles("Acme", "acme.dev", [job("1", "Backend Engineer"), job("2", "Platform Engineer")]);
  const { roles } = companyRoles(acme, {}, now);
  expect(roles.map((r) => r.title).sort()).toEqual(["Backend Engineer", "Platform Engineer"]);
  const [a, b] = roles;
  expect(chooseRole(a!.id, "dismiss", now)).toMatchObject({ ok: true, company: acme });
  expect(inboxCompany(acme, {}, now)?.roles).toBe(1);
  const r = chooseRole(b!.id, "apply", now);
  expect(r).toMatchObject({ ok: true, thread: "acme.dev", url: b!.url });
  expect(read("acme.dev").map((e) => e.kind)).toEqual(["signal", "decision"]);
  expect(chooseRole(b!.id, "apply", now)).toMatchObject({ ok: false, status: 409 });
  expect(inboxCompany(acme, {}, now)).toBeNull(); // nothing new left, no signal
  // The Watchlist's view still lists them, with what you did.
  expect(
    companyRoles(acme, { view: "fit" }, now)
      .roles.map((x) => x.state)
      .sort(),
  ).toEqual(["applied", "dismissed"]);
  // Watch: off the Inbox, on the Watchlist.
  const orbit = recordSignal(
    {
      url: "https://news.ycombinator.com/item?id=1",
      company_hint: "Orbit",
      domain: "orbit.health",
      source: "hn",
      source_tag: "HN",
    },
    now,
  ).companyId!;
  expect(chooseCompany(orbit, "watch", now)).toMatchObject({ ok: true });
  expect(getCompany(orbit)?.watched_at).toBe(now.toISOString());
  expect(inboxPage({}, now).companies).toEqual([]);
});

test("a company whose new roles you applied to or dismissed leaves the Inbox though the signal that brought it is recent; a newer signal brings it back", () => {
  const hn = (id: number, at: Date) =>
    recordSignal(
      {
        url: `https://news.ycombinator.com/item?id=${id}`,
        company_hint: "Span",
        domain: "span.io",
        title: "Backend Engineer",
        source: "hn",
        source_tag: "HN",
      },
      at,
    ).companyId!;
  const span = withRoles(
    "Span",
    "span.io",
    [job("1", "Backend Engineer"), job("2", "Platform Engineer")],
    ago(3),
  );
  hn(1, ago(2));
  // A third role that fits, kept back as not news: still open, never new.
  open()
    .query(
      "INSERT INTO roles (board_id, company_id, ext_id, url, title, first_seen, last_seen, fits, state) SELECT id, company_id, '3', 'https://jobs.lever.co/acme/3', 'Data Engineer', ?, ?, 1, 'archived' FROM boards WHERE company_id = ?",
    )
    .run(ago(40).toISOString(), now.toISOString(), span);
  const [a, b] = companyRoles(span, {}, now).roles;
  chooseRole(a!.id, "apply", ago(1));
  expect(inboxCompany(span, {}, now)).toMatchObject({ roles: 1 }); // one role still new
  chooseRole(b!.id, "dismiss", ago(1));
  expect(inboxCompany(span, {}, now)).toBeNull();
  expect(inboxCount({}, now)).toBe(0);
  expect(inboxCount({ source: "hn" }, now)).toBe(0);
  expect(inboxSources(now)).toEqual([]);
  // Not in "Everything else" either until it's out of the Inbox: it has a board, so now it is.
  expect(otherCompany(span, {}, now)?.name).toBe("Span");
  // A signal after the decision brings it back, with no roles new: it opens to the one that fits.
  hn(2, now);
  expect(inboxCompany(span, {}, now)).toMatchObject({ roles: 0, fit: 3, at: now.toISOString() });
  expect(inboxCount({ source: "hn" }, now)).toBe(1);
  expect(inboxSources(now).map((s) => s.source)).toEqual(["hn"]);
  expect(otherCompany(span, {}, now)).toBeNull();
});

test("a watched company is in the Inbox, marked, with only the roles first seen since you watched it; Clear keeps it watched", () => {
  const id = withRoles("Watched", "watched.dev", [job("w1", "Backend Engineer")], ago(3));
  watchCompany(id, "manual", ago(2));
  // A signal alone doesn't bring it back.
  recordSignal(
    {
      url: "https://news.ycombinator.com/item?id=5",
      company_hint: "Watched",
      domain: "watched.dev",
      source: "hn",
      source_tag: "HN",
    },
    ago(1),
  );
  expect(inboxCompany(id, {}, now)).toBeNull();
  // Its board posts two more roles, one that fits.
  const board = open().query("SELECT * FROM boards WHERE company_id = ?").get(id) as Board;
  applyRead(
    board,
    {
      ok: true,
      jobs: [job("w1", "Backend Engineer"), job("w2", "Platform Engineer"), job("w3", "Recruiter")],
    },
    now,
  );
  expect(inboxCompany(id, {}, now)).toMatchObject({
    watched: true,
    roles: 1,
    week: 1,
    at: now.toISOString(),
  });
  expect(inboxCount({}, now)).toBe(1);
  expect(companyRoles(id, {}, now).roles.map((r) => r.title)).toEqual(["Platform Engineer"]);
  expect(inboxPage({ source: "hn" }, now).companies).toEqual([]); // the source switch leaves watched ones out
  // Clear: out of the Inbox, still open and choosable on its Watchlist page, still watched.
  expect(chooseCompany(id, "dismiss", now)).toMatchObject({
    ok: true,
    toast: "Cleared 1 new role · still watching Watched",
  });
  expect(inboxCompany(id, {}, now)).toBeNull();
  expect(getCompany(id)?.dismissed_at).toBeNull();
  expect(getCompany(id)?.watched_at).toBe(ago(2).toISOString());
  expect(
    companyRoles(id, { view: "fit" }, now)
      .roles.map((r) => [r.title, r.state])
      .sort(),
  ).toEqual([
    ["Backend Engineer", "new"],
    ["Platform Engineer", "archived"],
  ]);
});

test("Work on a company with no role: its thread opens with what named it and no role", () => {
  const id = recordSignal(
    {
      url: "https://x.com/loom/status/1",
      company_hint: "Loom",
      domain: "loom.dev",
      title: "Senior Engineer",
      text: "Loom is hiring a Senior Engineer",
      source: "hn",
      source_tag: "HN",
      kind: "posting",
    },
    now,
  ).companyId!;
  expect(chooseCompany(id, "work", now)).toMatchObject({ ok: true, thread: "loom.dev" });
  const log = read("loom.dev");
  expect(log.map((e) => e.kind)).toEqual(["signal"]);
  expect(log[0]).toMatchObject({
    data: { company: "Loom", kind: "post" },
    source: { url: "https://x.com/loom/status/1" },
  });
  expect(index.get("loom.dev")).toMatchObject({ company: "Loom", roles: [], status: null, needsYou: false });
  chooseCompany(id, "work", now); // again: the same thread, nothing added
  expect(read("loom.dev")).toHaveLength(1);
  // With no signal at all, the thread still names the company.
  const quiet = upsertCompany({ name: "Quiet", domain: "quiet.dev" });
  expect(chooseCompany(quiet, "work", now)).toMatchObject({ ok: true, thread: "quiet.dev" });
  expect(read("quiet.dev")[0]).toMatchObject({
    kind: "signal",
    data: { company: "Quiet" },
    source: { url: "https://quiet.dev" },
  });
});

test("Work on it, on a role: the role joins the thread as a posting, nothing is chosen, and twice adds it once", () => {
  const id = withRoles("Pellucid", "pellucid.dev", [job("7", "Platform Engineer", "Denver, CO")]);
  const role = open().query("SELECT id FROM roles WHERE company_id = ?").get(id) as { id: number };
  expect(chooseRole(role.id, "work", now)).toMatchObject({ ok: true, thread: "pellucid.dev", work: true });
  const log = read("pellucid.dev");
  expect(log.map((e) => e.kind)).toEqual(["signal"]);
  expect(log[0]).toMatchObject({
    data: { company: "Pellucid", kind: "posting", title: "Platform Engineer", location: "Denver, CO" },
    source: { url: "https://jobs.lever.co/acme/7" },
  });
  // Not applied: the role is still new and in the Inbox; the thread shows it to apply to.
  expect(open().query("SELECT state FROM roles WHERE id = ?").get(role.id)).toEqual({ state: "new" });
  expect(index.get("pellucid.dev")?.roles.map((r) => r.status)).toEqual(["apply"]);
  chooseRole(role.id, "work", now);
  expect(read("pellucid.dev")).toHaveLength(1);
});

test("Everything else: every company with a board the Inbox doesn't list, all its open roles, those that fit first", () => {
  const acme = withRoles("Acme", "acme.dev", [job("1", "Backend Engineer")]);
  const quiet = withRoles(
    "Quiet",
    "quiet.dev",
    [job("q1", "Recruiter"), job("q2", "Backend Engineer"), job("q3", "Data Engineer")],
    ago(30),
  );
  const nofit = withRoles("Nofit", "nofit.dev", [job("n1", "Recruiter")], ago(30));
  const empty = withRoles("Empty", "empty.dev", [], ago(30));
  const watched = withRoles("Watched", "watched.dev", [job("w", "Engineer")], ago(30));
  watchCompany(watched, "manual", now);
  recordSignal(
    {
      url: "https://news.ycombinator.com/item?id=3",
      company_hint: "Boardless",
      source: "hn",
      source_tag: "HN",
    },
    ago(30),
  );
  expect(othersPage({}, now).companies.map((c) => [c.name, c.roles, c.held])).toEqual([
    ["Quiet", 2, 3],
    ["Empty", 0, 0],
    ["Nofit", 0, 1],
  ]);
  expect(othersCount({}, now)).toBe(3);
  expect(otherCompany(acme, {}, now)).toBeNull(); // in the Inbox
  const roles = companyRoles(quiet, { view: "all" }, now).roles;
  expect(roles.map((r) => [r.title, r.fits])).toEqual([
    ["Data Engineer", true],
    ["Backend Engineer", true],
    ["Recruiter", false],
  ]);
  expect(companyRoles(nofit, { view: "all" }, now).roles.map((r) => r.title)).toEqual(["Recruiter"]);
  dismissCompany(empty, now);
  expect(otherCompany(empty, {}, now)).toBeNull();
  expect(otherCompany(quiet, {}, now)?.held).toBe(3);
});

test("the city switch: both lists keep the companies with an open role that fits there, each role read on its own", () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({
      filters: {
        title_include: ["Engineer"],
        metros: { Colorado: ["Denver", "Boulder", "CO"], "Bay Area": ["San Francisco", "San Jose"] },
      },
    }),
  );
  withRoles("Acme", "acme.dev", [job("1", "Backend Engineer", "Boulder, CO · San Jose, CA")]);
  withRoles("Bayco", "bayco.dev", [job("2", "Backend Engineer", "San Francisco, CA")]);
  recordSignal(
    { url: "https://news.ycombinator.com/item?id=4", company_hint: "Orbit", source: "hn", source_tag: "HN" },
    now,
  );
  withRoles("Quiet", "quiet.dev", [job("q", "Data Engineer", "Denver, CO")], ago(30));
  withRoles("Sales", "sales.dev", [job("s", "Recruiter", "Denver, CO")], ago(30)); // doesn't fit
  withRoles("Irish", "irish.dev", [job("i", "Backend Engineer", "Dublin, Co. Dublin")], ago(30));
  withRoles("Far", "far.dev", [job("f", "Backend Engineer", "Remote")], ago(30));
  const names = (cs: { name: string }[]) => cs.map((c) => c.name).sort();
  expect(inboxMetros()).toEqual(["Colorado", "Bay Area"]);
  expect(names(inboxPage({ metro: "Colorado" }, now).companies)).toEqual(["Acme"]);
  expect(names(inboxPage({ metro: "Bay Area" }, now).companies)).toEqual(["Acme", "Bayco"]);
  expect(inboxCount({ metro: "Bay Area" }, now)).toBe(2);
  expect(names(othersPage({ metro: "Colorado" }, now).companies)).toEqual(["Quiet"]);
  expect(othersCount({ metro: "Colorado" }, now)).toBe(1);
  // The first page carries the same count; the city's companies found once and passed in, the same.
  expect(inboxPage({ metro: "Bay Area" }, now).count).toBe(2);
  expect(othersPage({ metro: "Colorado", city: inCity("Colorado") }, now).count).toBe(1);
  expect(othersPage({ metro: "Nowhere" }, now).companies).toEqual([]);
  // Remote only narrows "Everything else" as it does the Inbox: remote roles only count.
  expect(othersPage({ remote: true }, now).companies.map((c) => [c.name, c.roles, c.held])).toEqual([
    ["Far", 1, 1],
  ]);
  expect(names(othersPage({}, now).companies)).toEqual(["Far", "Irish", "Quiet", "Sales"]);
});

test("Everything else and a company's roles page by keyset too", () => {
  for (let i = 0; i < PAGE + 2; i++) withRoles(`Co ${String(i).padStart(2, "0")}`, `co${i}.dev`, [], ago(30));
  const jobs = Array.from({ length: PAGE + 10 }, (_, i) =>
    job(`r${i}`, i % 2 ? "Recruiter" : "Backend Engineer"),
  );
  const big = withRoles("Big", "big.dev", jobs, ago(30));
  const first = othersPage({}, now);
  expect(first.companies.slice(0, 2).map((c) => c.name)).toEqual(["Big", "Co 00"]);
  const second = othersPage({ cursor: first.next }, now);
  expect(second.companies.map((c) => c.name)).toEqual(["Co 49", "Co 50", "Co 51"]);
  expect([first.count, second.count]).toEqual([othersCount({}, now), undefined]);
  const a = companyRoles(big, { view: "all" }, now);
  const b = companyRoles(big, { view: "all", cursor: a.next }, now);
  const all = [...a.roles, ...b.roles];
  expect(new Set(all.map((r) => r.id)).size).toBe(PAGE + 10);
  expect(all.findIndex((r) => !r.fits)).toBe((PAGE + 10) / 2);
  expect(all.slice((PAGE + 10) / 2).every((r) => !r.fits)).toBe(true);
});

test("pages are 50 companies, keyset-paged, newest first", () => {
  for (let i = 0; i < PAGE + 5; i++)
    withRoles(
      `Co ${i}`,
      `co${i}.dev`,
      [job(String(i), "Backend Engineer")],
      new Date(now.getTime() - i * 60_000),
    );
  const first = inboxPage({}, now);
  expect(first.companies).toHaveLength(PAGE);
  expect(first.companies[0]?.name).toBe("Co 0");
  const second = inboxPage({ cursor: first.next }, now);
  expect(second.companies.map((c) => c.name)).toEqual(["Co 50", "Co 51", "Co 52", "Co 53", "Co 54"]);
  expect(second.next).toBeNull();
  expect([first.count, second.count]).toEqual([PAGE + 5, undefined]); // the count rides on the first page
});

test("search: every word somewhere in any open role, fitting first; a word that finds nothing says so", async () => {
  const tamlo = withRoles("Tamlo", "tamlo.com", [job("1", "Backend Engineer", "Denver, CO")]);
  const acme = withRoles("Acme", "acme.ai", [
    job("2", "Forward Deployed Engineer"),
    job("3", "Platform Engineer"),
    job("6", "Data Analyst", "Boulder, Colorado"), // doesn't fit: no title word
  ]);
  withRoles("Bayco", "bayco.dev", [job("4", "Trust Engineer")]);
  withRoles("Oldco", "oldco.dev", [job("5", "Full-Stack Engineer (C#)")], ago(30));
  const { search } = await import("./search.ts");
  const { searchPage } = await import("./query.ts");
  const names = (q: string) => searchPage(q, {}, now).companies.map((c) => c.name);
  const role = (title: string) =>
    (open().query("SELECT id FROM roles WHERE title = ?").get(title) as { id: number }).id;
  expect(names("tamlo")).toEqual(["Tamlo"]);
  expect(names("forward deployed")).toEqual(["Acme"]);
  expect(names("rust")).toEqual([]); // "Trust" doesn't start with it
  expect(names("full stack c#")).toEqual(["Oldco"]); // however it's written, old or not
  expect(names("fullstack")).toEqual(["Oldco"]);
  expect(names("engineer -platform -forward -trust -full")).toEqual(["Tamlo"]);
  expect(names("-clearance")).toEqual([]); // nothing to look for
  // A state's name finds its code in a place, and the code typed in capitals its name.
  expect(names("engineer colorado")).toEqual(["Tamlo"]);
  expect(names("analyst CO")).toEqual(["Acme"]);

  // Descriptions: kept in step with role_text, whatever writes it.
  const text = (id: number, t: string) =>
    open()
      .query(
        "INSERT INTO role_text (role_id, text, fetched_at) VALUES (?, ?, '') ON CONFLICT(role_id) DO UPDATE SET text = excluded.text",
      )
      .run(id, t);
  text(role("Platform Engineer"), "Join the AI & Data team.");
  text(role("Data Analyst"), "Pay range for Colorado: $1.");
  const markText = () =>
    open().query("UPDATE meta SET value = value || '.' WHERE key = 'intake_changed_at'").run();
  markText();
  expect(names("acme ai data")).toEqual(["Acme"]);
  const found = search("acme ai data", now);
  expect(found.roles.get(acme)).toContain(role("Platform Engineer"));
  expect(names('"ai & data"')).toEqual(["Acme"]);
  expect(names("analyst colorado")).toEqual(["Acme"]); // its place, not its pay note
  text(role("Platform Engineer"), "Join the platform team.");
  markText();
  expect(names("acme ai data")).toEqual([]);
  open()
    .query("UPDATE role_text SET role_id = ? WHERE role_id = ?")
    .run(role("Forward Deployed Engineer"), role("Platform Engineer"));
  open().query("DELETE FROM role_text WHERE role_id = ?").run(role("Data Analyst"));
  markText();
  expect(search("platform team", now).roles.get(acme)).toEqual([role("Forward Deployed Engineer")]);
  expect(names("pay range")).toEqual([]);

  // Fitting first, and a role that doesn't fit says why.
  const rows = companyRoles(acme, { found: search("acme", now) }, now).roles;
  expect(rows.map((r) => r.fits)).toEqual([true, true, false]);
  expect(rows[2]!.title).toBe("Data Analyst");
  expect(rows[2]!.why).toBe("title has none of your words");

  // A word that finds nothing: how many without it, and a company it may have meant.
  expect(search("tamloo", now).missing).toEqual({
    word: "tamloo",
    anywhere: false,
    without: 0,
    meant: "Tamlo",
  });
  expect(search("backend engineer zanzibar", now).missing).toEqual({
    word: "zanzibar",
    anywhere: false,
    without: 1,
    meant: null,
  });
  expect(search("backend engineer acme", now).missing).toMatchObject({ word: "backend", anywhere: true });

  // Through the route.
  const { feature } = await import("./server.ts");
  const route = feature.routes!["/api/inbox/search"] as { GET: (req: Request) => Response };
  const body = (await route.GET(new Request("http://x/api/inbox/search?q=%20Tamlo%20")).json()) as {
    companies: { id: number; hitRoles: number }[];
    count: number;
  };
  expect([body.companies.map((c) => [c.id, c.hitRoles]), body.count]).toEqual([[[tamlo, 1]], 1]);
});

test("nothing writes role_text with REPLACE: its delete fires no trigger, and the search would keep old words", async () => {
  const { Glob } = await import("bun");
  const root = new URL("..", import.meta.url).pathname;
  const bad: string[] = [];
  for await (const f of new Glob("*/**/*.ts").scan({ cwd: root }))
    if (!f.startsWith("node_modules/") && !f.startsWith("vendor/") && !f.endsWith(".test.ts"))
      for (const line of (await Bun.file(`${root}${f}`).text()).split("\n"))
        if (!/^\s*(--|\/\/|\*)/.test(line) && /REPLACE\s+INTO\s+role_text/i.test(line)) bad.push(f);
  expect(bad).toEqual([]);
});

test("Review titles: an opened group lists its roles, newest first; one role's own Add takes its exact title, and it leaves", async () => {
  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: { title_include: ["AI Engineer"] } }));
  const brightwell = withRoles(
    "Brightwell",
    "brightwell.dev",
    [job("b1", "AI Security Research & Red Team Engineer", "Remote - US")],
    ago(1),
  );
  withRoles(
    "Quillon",
    "quillon.dev",
    [job("q1", "Senior Recruiter, AI & Engineering", "Austin, TX")],
    ago(3),
  );
  const gone = withRoles("Gone", "gone.dev", [job("g1", "Engineer, Applied AI")], ago(2));
  dismissCompany(gone, now);
  const key = "AI Engineer (any order)";
  const { groupRoles } = await import("./titles.ts");
  const got = groupRoles(key);
  expect(got.total).toBe(2);
  expect(got.roles.map((r) => [r.title, r.company, r.place, r.mode])).toEqual([
    ["AI Security Research & Red Team Engineer", "Brightwell", "US", "remote"],
    ["Senior Recruiter, AI & Engineering", "Quillon", "Austin, TX", "unknown"],
  ]);
  const { feature } = await import("./server.ts");
  const route = feature.routes!["/api/review-titles"] as { POST: (req: Request) => Promise<Response> };
  const add = (phrase: string) =>
    route.POST(
      new Request("http://x/api/review-titles", {
        method: "POST",
        body: JSON.stringify({ action: "add", key, phrase }),
      }),
    );
  expect(
    ((await (await add("AI Security Research & Red Team Engineer")).json()) as { toast: string }).toast,
  ).toBe("Added “AI Security Research & Red Team Engineer” to your title words · 1 more role fit");
  expect(groupRoles(key).roles.map((r) => r.title)).toEqual(["Senior Recruiter, AI & Engineering"]);
  expect(companyRoles(brightwell, { view: "fit" }, now).roles.map((r) => r.title)).toEqual([
    "AI Security Research & Red Team Engineer",
  ]);
});

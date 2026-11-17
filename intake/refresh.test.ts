import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Job, runRunner, setPageReader, setRunner } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { politeGet } from "../core/http.ts";
import { setOnline } from "../core/online.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { failure, failuresFile } from "../core/trace.ts";
import { inboxCount } from "../inbox/query.ts";
import { problems } from "../report/report.ts";
import { getCompany, recordSignal, upsertCompany } from "./companies.ts";
import { addBoard } from "./discover.ts";
import { repairOffline } from "./offline.ts";
import {
  applyRead,
  type Board,
  dueBoards,
  ensureScored,
  makeAllDue,
  readBoards,
  readPlan,
  refreshDue,
} from "./refresh.ts";

const data = tempData();
const plainReader: Parameters<typeof setPageReader>[0] = (u, v = {}) =>
  politeGet(u, { accept: "text/html", ...v });
afterAll(() => {
  setOnline(true);
  setRunner(runRunner);
  setPageReader(plainReader);
  data.cleanup();
});

const T = (h: number) => new Date(Date.UTC(2026, 9, 20, h));
const job = (id: string, title = `Engineer ${id}`, location = "Remote", extra: Partial<Job> = {}): Job => ({
  id,
  title,
  url: `https://jobs.lever.co/acme/${id}`,
  location,
  postedAt: "2026-10-19T00:00:00.000Z",
  ...extra,
});
const boardRow = (id: number) => open().query("SELECT * FROM boards WHERE id = ?").get(id) as Board;
const roles = (boardId: number) =>
  open()
    .query(
      "SELECT ext_id, misses, closed_at, last_seen, state, fits, matched FROM roles WHERE board_id = ? ORDER BY ext_id",
    )
    .all(boardId) as {
    ext_id: string;
    misses: number;
    closed_at: string | null;
    last_seen: string;
    state: string;
    fits: number;
    matched: string | null;
  }[];

let board: Board;
beforeEach(() => {
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies;",
  );
  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: {} }));
  setPageReader(async () => ({ text: "" })); // a board's own page answers
  const id = upsertCompany({ name: "Acme", domain: "acme.dev" });
  board = addBoard(id, "lever", "https://jobs.lever.co/acme", "test", T(0)).board!;
});
/** Read the board with these jobs (or this result) at hour h, from its row as it stands. */
const read = (h: number, r: Parameters<typeof applyRead>[1] | Job[], o?: Parameters<typeof applyRead>[3]) =>
  applyRead(boardRow(board.id), Array.isArray(r) ? { ok: true, jobs: r } : r, T(h), o);

test("a read inserts new roles, touches listed ones, and closes a role on its second miss", () => {
  expect(read(1, [job("a"), job("b"), job("c")])).toMatchObject({ status: "changed", added: 3, closed: 0 });
  expect(read(2, [job("a"), job("b")])).toMatchObject({ status: "changed", added: 0, closed: 0 });
  expect(roles(board.id).find((r) => r.ext_id === "c")).toMatchObject({ misses: 1, closed_at: null });
  // The same list again: the hash says nothing changed, and the missing role's second miss closes it.
  expect(read(3, [job("b"), job("a")])).toMatchObject({ status: "unchanged", closed: 1 });
  expect(roles(board.id).find((r) => r.ext_id === "c")?.closed_at).toBe(T(3).toISOString());
  // Back on the board: open again.
  expect(read(4, [job("a"), job("b"), job("c")])).toMatchObject({ status: "changed", added: 0 });
  expect(roles(board.id).find((r) => r.ext_id === "c")).toMatchObject({ misses: 0, closed_at: null });
  // A new role whose title an earlier closed one had is marked reposted.
  read(5, [job("a"), job("b")]);
  read(6, [job("a"), job("b"), job("d")]); // c: second miss
  read(7, [job("a"), job("b"), job("e", "Engineer c")]);
  const e = open().query("SELECT reposted FROM roles WHERE ext_id = 'e'").get() as {
    reposted: string | null;
  };
  expect(e.reposted).toBe(T(1).toISOString());
});

test("a role whose link is a file or another app's scheme is never stored, and misses nothing", () => {
  const urls = () =>
    (
      open().query("SELECT ext_id, url FROM roles WHERE board_id = ? ORDER BY ext_id").all(board.id) as {
        ext_id: string;
        url: string;
      }[]
    ).map((r) => `${r.ext_id} ${r.url}`);
  const mail = "mailto:jobs@acme.dev?subject=Engineer%20m";
  expect(
    read(1, [
      job("a"),
      job("f", undefined, undefined, { url: "file:///etc/passwd" }),
      job("v", undefined, undefined, { url: "vscode://file/x" }),
      job("m", undefined, undefined, { url: mail }),
      job("n", undefined, undefined, { url: "not a link" }),
    ]),
  ).toMatchObject({ added: 2 });
  // A web link and a mail link are kept as they came.
  expect(urls()).toEqual(["a https://jobs.lever.co/acme/a", `m ${mail}`]);
  // A kept role whose link turns into a file link keeps its link, and isn't missed for it.
  read(2, [
    job("a", undefined, undefined, { url: "file:///etc/passwd" }),
    job("m", undefined, undefined, { url: mail }),
  ]);
  read(3, [
    job("a", undefined, undefined, { url: "file:///etc/hosts" }),
    job("m", undefined, undefined, { url: mail }),
  ]);
  expect(urls()).toEqual(["a https://jobs.lever.co/acme/a", `m ${mail}`]);
  expect(roles(board.id).every((r) => r.misses === 0 && r.closed_at === null)).toBe(true);
});

test("a failed, cut-off or unparsed read closes nothing; three failures in a row send the company back to discovery", () => {
  read(1, [job("a"), job("b")]);
  expect(read(2, { ok: false, error: "HTTP 503" })).toMatchObject({ status: "failed", closed: 0 });
  expect(read(3, { ok: true })).toMatchObject({ status: "failed" }); // no job list: didn't parse
  // A search cut off at its page cap: partial, so a role it didn't list may still be open.
  read(4, { ok: true, jobs: [job("a")], complete: false });
  read(5, { ok: true, jobs: [job("a")], complete: false });
  expect(roles(board.id).every((r) => r.closed_at === null && r.misses === 0)).toBe(true);
  // The board is as big as its last whole read said, so it stays searched.
  expect(boardRow(board.id)).toMatchObject({ status: "ok", fails: 0, partial: 1, role_count: 2 });
  read(6, { ok: false, error: "timeout" });
  read(7, { ok: false, error: "timeout" });
  expect(boardRow(board.id)).toMatchObject({ status: "ok", fails: 2 });
  read(8, { ok: false, error: "timeout" });
  expect(boardRow(board.id)).toMatchObject({ status: "broken", fails: 3, last_error: "timeout" });
  expect(getCompany(board.company_id)?.discovery).toBe("queued");
  expect(roles(board.id).every((r) => r.closed_at === null)).toBe(true);
  // A company with another board that works isn't sent back: it stays found.
  open().query("UPDATE companies SET discovery = 'found' WHERE id = ?").run(board.company_id);
  const other = addBoard(
    board.company_id,
    "greenhouse",
    "https://job-boards.greenhouse.io/acme",
    "test",
    T(9),
  ).board!;
  for (const h of [10, 11, 12]) applyRead(boardRow(other.id), { ok: false, error: "timeout" }, T(h));
  expect(boardRow(other.id)).toMatchObject({ status: "broken", fails: 3 });
  expect(getCompany(board.company_id)?.discovery).toBe("queued"); // its first board is broken too
  open().query("UPDATE boards SET status = 'ok', fails = 0 WHERE id = ?").run(board.id);
  open().query("UPDATE boards SET status = 'ok', fails = 0 WHERE id = ?").run(other.id);
  open().query("UPDATE companies SET discovery = 'found' WHERE id = ?").run(board.company_id);
  for (const h of [13, 14, 15]) applyRead(boardRow(other.id), { ok: false, error: "timeout" }, T(h));
  expect(boardRow(other.id)).toMatchObject({ status: "broken" });
  expect(getCompany(board.company_id)?.discovery).toBe("found");
});

test("a site in trouble (5xx, 429) backs off but isn't broken until it has failed for three days", () => {
  read(1, [job("a")]);
  for (const h of [2, 3, 4, 5]) read(h, { ok: false, error: "HTTP 521 <none>" });
  read(6, { ok: false, error: "timed out after 120s" }); // as it ends
  expect(boardRow(board.id)).toMatchObject({ status: "ok", fails: 5, last_error: "timed out after 120s" });
  read(7, { ok: false, error: "HTTP 429 TOO MANY REQUESTS" });
  expect(Date.parse(boardRow(board.id).next_read_at!) - T(7).getTime()).toBe(6 * 3_600_000);
  expect(getCompany(board.company_id)?.discovery).not.toBe("queued");
  expect(roles(board.id)[0]?.closed_at).toBeNull();
  read(1 + 72, { ok: false, error: "HTTP 503 for https://jobs.lever.co/acme" });
  expect(boardRow(board.id).status).toBe("broken");
  expect(getCompany(board.company_id)?.discovery).toBe("queued");
});

test("a read under half of a board of 20 or more is suspect, and an empty one fails: nothing closes", () => {
  const many = Array.from({ length: 30 }, (_, i) => job(`r${i}`));
  read(1, many);
  expect(read(2, many.slice(0, 10))).toMatchObject({ status: "suspect", closed: 0 });
  expect(roles(board.id).filter((r) => r.misses > 0)).toEqual([]);
  expect(readFileSync(failuresFile(), "utf8")).toContain("suspect read: 10 roles where the last read had 30");
  // Empty where there were roles: a failed read, nothing closed; the third in a row closes the
  // board's roles and sends the company back to discovery.
  read(3, many);
  expect(read(4, [])).toMatchObject({ status: "failed", closed: 0 });
  expect(read(5, [])).toMatchObject({ status: "failed", closed: 0 });
  expect(roles(board.id).filter((r) => r.misses > 0 || r.closed_at)).toEqual([]);
  expect(read(6, [])).toMatchObject({ status: "failed", closed: 30 });
  expect(boardRow(board.id)).toMatchObject({ status: "broken", fails: 3, role_count: 0 });
  expect(getCompany(board.company_id)?.discovery).toBe("queued");
});

test("whether a role fits is decided when it's inserted, and again for every open role when the filters change", () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ filters: { title_include: ["Engineer"], locations: ["Denver"], remote_ok: false } }),
  );
  ensureScored();
  read(1, [
    job("a", "Backend Engineer", "Denver, CO", { description: "<p>Own the sync &amp; storage engine.</p>" }),
    job("b", "Backend Engineer", "Remote"),
    job("c", "Recruiter", "Denver, CO", { description: "Hire people." }),
  ]);
  // The text of a role that fits is kept when the list carries it, as plain text; not for one that doesn't.
  expect(open().query("SELECT text FROM role_text").all()).toEqual([
    { text: "Own the sync & storage engine." },
  ]);
  // A near miss (the title's word, not the place) keeps its word; the Signals screen lists it first.
  expect(roles(board.id).map((r) => [r.ext_id, r.fits, r.matched])).toEqual([
    ["a", 1, "Engineer · Denver"],
    ["b", 0, "Engineer"],
    ["c", 0, null],
  ]);
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ filters: { title_include: ["Engineer"], locations: ["Denver"], remote_ok: true } }),
  );
  expect(ensureScored()).toBe(1);
  expect(ensureScored()).toBe(0); // the same filters: nothing to do
  expect(roles(board.id).map((r) => [r.ext_id, r.fits])).toEqual([
    ["a", 1],
    ["b", 1],
    ["c", 0],
  ]);
});

test("a title in your places with none of your words waits in Review titles; one that starts to fit is new from then", () => {
  const filters = (f: Record<string, unknown>) =>
    writeFileSync(
      paths.me("profile.json"),
      JSON.stringify({ filters: { locations: ["Denver", "Boulder"], ...f } }),
    );
  filters({ title_include: ["Backend Engineer"] });
  ensureScored();
  read(1, [
    job("a", "Backend Engineer", "Denver, CO"),
    job("b", "Senior Data Platform Engineer", "Denver, CO"),
    job("c", "Office Assistant", "Denver, CO"),
    job("d", "Data Platform Engineer", "Lisbon"),
    job("e", "Data Platform Engineer", "Boulder, CO", { postedAt: "2025-01-02T00:00:00.000Z" }), // filed: old
  ]);
  const rows = () =>
    open().query("SELECT ext_id, fits, review, fit_at, state FROM roles ORDER BY ext_id").all() as {
      ext_id: string;
      fits: number;
      review: string | null;
      fit_at: string | null;
      state: string;
    }[];
  expect(rows().map((r) => [r.ext_id, r.fits, r.review])).toEqual([
    ["a", 1, null],
    ["b", 0, "data platform engineer"],
    ["c", 0, null], // names no job
    ["d", 0, null], // not in your places
    ["e", 0, "data platform engineer"],
  ]);
  expect(rows().find((r) => r.ext_id === "e")!.state).toBe("archived");
  // Not mine changes no score: nothing is scored again.
  filters({ title_include: ["Backend Engineer"], title_skip: ["data platform engineer"] });
  expect(ensureScored()).toBe(0);
  // Added: it fits from now, and is new in the Inbox, though first seen weeks ago.
  expect(inboxCount()).toBe(0);
  filters({ title_include: ["Backend Engineer", "Data Platform Engineer"] });
  expect(ensureScored()).toBe(3); // b and e fit; d, in Lisbon, now has your word (a near miss)
  const b = rows().find((r) => r.ext_id === "b")!;
  expect([b.fits, b.review, !!b.fit_at]).toEqual([1, null, true]);
  // Filed when the board was first read, never touched: new now, as one just posted.
  expect(rows().find((r) => r.ext_id === "e")).toMatchObject({ fits: 1, state: "new" });
  expect(rows().find((r) => r.ext_id === "a")!.fit_at).toBeNull(); // fit from the start
  expect(inboxCount()).toBe(1);
  // Taken away again: it stops fitting, waits in Review titles, and its fit_at goes.
  filters({ title_include: ["Backend Engineer"] });
  ensureScored();
  expect(rows().find((r) => r.ext_id === "b")).toMatchObject({
    fits: 0,
    review: "data platform engineer",
    fit_at: null,
  });
});

test("a role arrives new only when it's news: posted lately, undated on a later read that saw everything since, or named by a signal", () => {
  const recent = (i: number) =>
    job(`n${i}`, `Engineer ${i}`, "Remote", { postedAt: `2026-10-1${i}T00:00:00Z` }); // within 10 days of T
  const old = (i: number) =>
    job(`o${i}`, `Engineer old ${i}`, "Remote", { postedAt: "2026-06-01T00:00:00Z" });
  const undated = (i: number) => job(`u${i}`, `Engineer undated ${i}`, "Remote", { postedAt: null });
  open()
    .query(
      "INSERT INTO signals (source, source_tag, ref, company_id, title, url, received_at) VALUES ('linkedin', 'LinkedIn alert', 'r1', ?, 'Engineer (old) 2', 'https://linkedin.com/jobs/view/1', ?)",
    )
    .run(board.company_id, T(0).toISOString());
  const state = () => Object.fromEntries(roles(board.id).map((r) => [r.ext_id, r.state]));
  // First read: the recent role, and the old one a signal named; the rest is backlog.
  expect(read(1, [recent(1), old(1), old(2), undated(1)])).toMatchObject({ added: 2 });
  expect(state()).toEqual({ n1: "new", o1: "archived", o2: "new", u1: "archived" });
  // A later whole read: an undated role that shows up now is news; an old one still isn't.
  expect(read(2, [recent(1), old(1), old(2), undated(1), undated(2), old(3)])).toMatchObject({ added: 1 });
  expect(state()).toMatchObject({ u2: "new", o3: "archived" });
  // A search asks the board something its whole reads didn't: what it shows first is backlog.
  const search = { partial: true, terms: ["Engineer"] };
  read(3, [recent(1), undated(3)], search);
  // The same search read only so far by relevance may surface old roles: filed.
  read(4, { ok: true, jobs: [recent(1), undated(3), undated(4)], complete: false }, search);
  expect(state()).toMatchObject({ u3: "archived", u4: "archived" });
  // The same search read to the end: a role that wasn't there before is news.
  read(5, { ok: true, jobs: [recent(1), undated(3), undated(5)], complete: true }, search);
  expect(state()).toMatchObject({ u5: "new" });
  // Newest first, read part way: a role ahead of every known one is news; one further down
  // (an old role moving up as others close) isn't.
  const newest = [undated(6), undated(5), undated(3), undated(7)];
  read(6, { ok: true, jobs: newest, complete: false, order: [[0, 1, 2, 3]] }, search);
  expect(state()).toMatchObject({ u6: "new", u7: "archived" });
  // Other terms are a new question: what they surface is backlog.
  read(7, { ok: true, jobs: [undated(8)], complete: true }, { partial: true, terms: ["Data"] });
  expect(state()).toMatchObject({ u8: "archived" });
  // Only arrivals are judged: the backlog filed before stays filed.
  expect(state()).toMatchObject({ u1: "archived", u3: "archived", u4: "archived" });
});

test("a searched board can't show a role is gone: one it hasn't listed in 30 days is closed", () => {
  read(1, [job("a"), job("b")]);
  const later = (days: number) => new Date(T(1).getTime() + days * 86_400_000);
  applyRead(boardRow(board.id), { ok: true, jobs: [job("a")] }, later(10), { partial: true });
  expect(roles(board.id).map((r) => [r.ext_id, r.closed_at])).toEqual([
    ["a", null],
    ["b", null],
  ]);
  const out = applyRead(boardRow(board.id), { ok: true, jobs: [job("a")] }, later(31), { partial: true });
  expect(out.closed).toBe(1);
  expect(roles(board.id).find((r) => r.ext_id === "b")?.closed_at).toBe(later(31).toISOString());
});

test("refresh reads due boards through the runner, with validators and a lease", async () => {
  const sent: unknown[] = [];
  setRunner(async (_mode, cs) => {
    sent.push(...cs);
    // Posted just now: a first read files older roles away (see above), and this test runs on real time.
    const fresh = job("a", undefined, undefined, { postedAt: new Date().toISOString() });
    return cs.map((c) => ({ domain: c.domain, ok: true, jobs: [fresh], validators: { etag: '"v1"' } }));
  });
  open().query("UPDATE companies SET last_signal_at = ?").run(new Date().toISOString());
  const first = await refreshDue();
  expect(first.map((o) => [o.name, o.status, o.added])).toEqual([["Acme", "changed", 1]]);
  expect(boardRow(board.id).etag).toBe('"v1"');
  // Not due again for six hours (give or take half an hour).
  expect(await refreshDue()).toEqual([]);
  const later = new Date(Date.now() + 7 * 3_600_000);
  await refreshDue(later);
  expect(sent.at(-1)).toMatchObject({ ats: { provider: "lever" }, validators: { etag: '"v1"' } });
  // A board being read elsewhere is skipped.
  open()
    .query("UPDATE boards SET lease_until = ?")
    .run(new Date(later.getTime() + 60_000).toISOString());
  expect(await readBoards([boardRow(board.id)], later)).toEqual([]);
});

test("a pass that starts long after its tick began holds its boards from when it starts", async () => {
  let reads = 0;
  setRunner(async (_mode, cs) => {
    reads += cs.length;
    await Bun.sleep(50);
    return cs.map((c) => ({ domain: c.domain, ok: true, jobs: [job("a")] }));
  });
  // The tick began 11 minutes ago (its sources and discovery took that); a Refresh comes while its read goes.
  const tickStart = new Date(Date.now() - 11 * 60_000);
  const late = readBoards([boardRow(board.id)], tickStart);
  await Bun.sleep(10);
  expect(await readBoards([boardRow(board.id)])).toEqual([]);
  await late;
  expect(reads).toBe(1);
});

test("a role keeps its row when a reader names its id differently: matched by its link", () => {
  read(1, [{ ...job("a1"), id: "https://jobs.lever.co/acme/a1" }]); // an older reader's id: the link
  read(2, [job("a1")]); // same posting, same link, its own id now
  expect(roles(board.id)).toMatchObject([{ ext_id: "a1", misses: 0, closed_at: null }]);
});

test("a searchable board's first read: its own count says whether it's read whole or through its search", async () => {
  const f = { title_include: ["Software Engineer"] };
  // Never read: the runner asks the board's count first; read whole only up to what reads in ~30s.
  expect(readPlan({ provider: "workday", role_count: null }, f)).toEqual({
    search: ["Engineer"],
    searchAbove: 1000,
  });
  expect(readPlan({ provider: "eightfold", role_count: null }, f)).toEqual({
    search: ["Engineer"],
    searchAbove: 545,
  });
  expect(readPlan({ provider: "greenhouse", role_count: null }, f)).toEqual({});
  // Google Careers: always its own results page per saved-search title, newest first.
  expect(readPlan({ provider: "google", role_count: 20 }, f)).toEqual({ search: ["Software Engineer"] });
  expect(readPlan({ provider: "workday", role_count: 200, partial: 0 }, f)).toEqual({});
  expect(readPlan({ provider: "workday", role_count: 200, partial: 1 }, f)).toEqual({ search: ["Engineer"] });

  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: f }));
  const id = upsertCompany({ name: "Bigco", domain: "bigco.com" });
  const big = addBoard(id, "workday", "https://bigco.wd1.myworkdayjobs.com/Ext", "test", T(0)).board!;
  const sent: { search?: string[]; searchAbove?: number }[] = [];
  // The board says it has 2,400 roles: the runner searched it.
  setRunner(async (_mode, cs) => {
    sent.push(...cs);
    return cs.map((c) => ({ domain: c.domain, ok: true, jobs: [job("a")], searched: true, boardSize: 2400 }));
  });
  await readBoards([boardRow(big.id)], T(1));
  expect(sent[0]).toMatchObject({ search: ["Engineer"], searchAbove: 1000 });
  expect(boardRow(big.id)).toMatchObject({ partial: 1, role_count: 2400 });
  // From then on it's searched, without asking its count.
  await readBoards([boardRow(big.id)], T(8));
  expect(sent[1]).toEqual(expect.objectContaining({ search: ["Engineer"] }));
  expect(sent[1]?.searchAbove).toBeUndefined();
  // A small one says so and is read whole: its roles can close.
  const small = addBoard(id, "workday", "https://bigco.wd1.myworkdayjobs.com/Small", "test", T(0)).board!;
  setRunner(async (_mode, cs) =>
    cs.map((c) => ({ domain: c.domain, ok: true, jobs: [job("b")], searched: false })),
  );
  await readBoards([boardRow(small.id)], T(1));
  expect(boardRow(small.id)).toMatchObject({ partial: 0, role_count: 1 });
  expect(readPlan(boardRow(small.id), f)).toEqual({});
});

test("a board is read every 6 hours while its company is active, daily once its last signal is 60 days old, never once dismissed", () => {
  const DAY = 86_400_000;
  const at = T(12);
  const make = (name: string, signalDaysAgo: number, dismissed = false) => {
    const id = upsertCompany({ name, domain: `${name.toLowerCase()}.dev` });
    open()
      .query("UPDATE companies SET last_signal_at = ?, dismissed_at = ? WHERE id = ?")
      .run(
        new Date(at.getTime() - signalDaysAgo * DAY).toISOString(),
        dismissed ? at.toISOString() : null,
        id,
      );
    return addBoard(id, "lever", `https://jobs.lever.co/${name.toLowerCase()}`, "test", T(0)).board!;
  };
  const active = make("Fresh", 1);
  const old = make("Elder", 90);
  const gone = make("Gone", 1, true);
  const hoursOn = (b: Board) => (Date.parse(boardRow(b.id).next_read_at!) - at.getTime()) / 3_600_000;
  for (const b of [board, active, old]) applyRead(boardRow(b.id), { ok: true, jobs: [job("a")] }, at);
  expect(Math.abs(hoursOn(active) - 6)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(hoursOn(old) - 24)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(hoursOn(board) - 24)).toBeLessThanOrEqual(0.5); // Acme: no signal at all
  // A dismissed company's board is never due; Refresh all makes only the 6-hour boards due.
  const ids = (bs: Board[]) => bs.map((b) => b.id).sort();
  const dayOn = new Date(at.getTime() + 2 * DAY);
  expect(ids(dueBoards(dayOn))).toEqual(ids([board, active, old]));
  expect(ids(dueBoards(at))).toEqual([]);
  expect(dueBoards(new Date(at.getTime() + 7 * 3_600_000)).map((b) => b.id)).toEqual([active.id]);
  makeAllDue(at);
  expect(ids(dueBoards(at))).toEqual([active.id]);
  expect(dueBoards(dayOn).map((b) => b.id)).not.toContain(gone.id);
  // A new signal for the old company wakes its board now, and that read sets six hours again.
  const later = new Date(at.getTime() + 3_600_000);
  recordSignal(
    { url: "https://elder.dev/blog/hiring", domain: "elder.dev", source: "drop", source_tag: "drop" },
    later,
  );
  expect(dueBoards(later).map((b) => b.id)).toContain(old.id);
  applyRead(boardRow(old.id), { ok: true, unchanged: true }, later);
  expect(
    Math.abs((Date.parse(boardRow(old.id).next_read_at!) - later.getTime()) / 3_600_000 - 6),
  ).toBeLessThanOrEqual(0.5);
});

test("a read that fails for want of internet counts nothing; the same error while online counts as before", async () => {
  setRunner(async (_mode, cs) =>
    cs.map((c) => ({ domain: c.domain, ok: false, error: "getaddrinfo ENOTFOUND" })),
  );
  const before = boardRow(board.id);
  const lines = () =>
    existsSync(failuresFile()) ? readFileSync(failuresFile(), "utf8").split("\n").filter(Boolean).length : 0;
  const logged = lines();
  setOnline(false);
  try {
    expect(await readBoards([before])).toEqual([]);
  } finally {
    setOnline(true);
  }
  const after = boardRow(board.id);
  expect([after.fails, after.status, after.next_read_at, after.lease_until]).toEqual([
    before.fails,
    "ok",
    before.next_read_at,
    null,
  ]);
  expect(lines()).toBe(logged);
  expect((await readBoards([after])).map((o) => o.status)).toEqual(["failed"]);
  expect(boardRow(board.id).fails).toBe(before.fails + 1);
});

test("repair offline reads again what a time with no internet marked, and only that", () => {
  const from = new Date(Date.now() + 1);
  Bun.sleepSync(2);
  const other = upsertCompany({ name: "Gone", domain: "gone.dev" });
  const gone = addBoard(other, "lever", "https://jobs.lever.co/gone", "test", T(0)).board!;
  const d = open();
  const broke = (b: Board, error: string) => {
    d.query("UPDATE boards SET status = 'broken', fails = 3, last_error = ? WHERE id = ?").run(error, b.id);
    failure("refresh", b.url, error, { board: b.id, fails: 3 });
  };
  broke(board, "getaddrinfo ENOTFOUND");
  d.query("UPDATE companies SET discovery = 'queued', discovery_note = ? WHERE id = ?").run(
    "board failed 3 reads: getaddrinfo ENOTFOUND",
    board.company_id,
  );
  broke(gone, "HTTP 404 for https://jobs.lever.co/gone");
  const [none, old] = ["Quiet", "Older"].map((name) => upsertCompany({ name, domain: `${name}.dev` }));
  d.query("UPDATE companies SET discovery = 'none', discovery_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    none!,
  );
  d.query("UPDATE companies SET discovery = 'none', discovery_at = ? WHERE id = ?").run(
    T(0).toISOString(),
    old!,
  );
  const to = new Date(Date.now() + 1000);
  const shown = () => problems(from).map((p) => p.what);
  expect(shown().sort()).toEqual([board.url, gone.url].sort());
  const counts = { boards: 1, broken: 1, kept: 1, companies: 1, theirs: 0 };
  expect(repairOffline(from, to, { dry: true })).toEqual(counts);
  expect(boardRow(board.id).status).toBe("broken");
  expect(repairOffline(from, to)).toEqual(counts);
  expect(boardRow(board.id)).toMatchObject({ status: "ok", fails: 0, last_error: null });
  expect(boardRow(gone.id)).toMatchObject({ status: "broken", fails: 3 });
  expect(getCompany(board.company_id)?.discovery).toBe("found");
  expect(getCompany(none!)?.discovery).toBe("queued");
  expect(getCompany(old!)?.discovery).toBe("none");
  expect(shown()).toEqual([gone.url]);
});

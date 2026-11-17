// Refresh: read a board's job list and fold it into the roles table. Cheap and frequent. It
// never decides which board a company has: only three failed reads in a row send the company
// back to discovery. One read, one transaction: new roles go in (scored against the profile's
// filters once, here), roles still listed are touched, and a role missing from two good reads
// in a row closes. A read that failed, was cut off or came back suspiciously small closes nothing.
import { createHash } from "node:crypto";
import { careersJobs } from "../ats/careers.ts";
import { workdayDetail } from "../ats/detail.ts";
import { loadFilters, type PostingFilters, SCORE_RULES, score, stems, workMode } from "../ats/filters.ts";
// @ts-expect-error plain JS module
import { isFeed } from "../ats/links.mjs";
import { canReadPages, type PageText, plainText, readPage, textHash } from "../ats/read-page.ts";
import {
  ashbyEmbedView,
  getPage,
  type Job,
  listHash,
  postingId,
  type RunnerResult,
  runBoards,
  sameTitle,
} from "../ats/reader.ts";
import { noBrowser, type Renderer, renderer } from "../ats/render.ts";
// @ts-expect-error plain JS module
import { QUERIED, SEARCHABLE } from "../ats/search.mjs";
import { pickSitemap, rolePage, sitemapLocs } from "../ats/sitemap.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, getMeta, markChanged, open, setMeta, tx } from "../core/db.ts";
import { htmlToText, roleLinkOk, sitemapsFor } from "../core/http.ts";
import { NoModelKey, OverCap } from "../core/model.ts";
import { countsAsFailure, networkError } from "../core/online.ts";
import { failure } from "../core/trace.ts";
// @ts-expect-error plain JS module
import { isMultiLocationPlaceholder } from "../vendor/career-ops/providers/workday.mjs";
import type { DomainFrom } from "./companies.ts";
import { boardStates, leverPageGone, ownSite } from "./domain.ts";
import { normalizeUrl } from "./leads.ts";

export type Board = {
  id: number;
  company_id: number;
  provider: string;
  url: string;
  key: string;
  status: "ok" | "broken";
  partial: number;
  found_by: string | null;
  list_hash: string | null;
  etag: string | null;
  last_modified: string | null;
  last_read_at: string | null;
  next_read_at: string | null;
  fails: number;
  role_count: number | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  read_terms: string | null; // what its last read asked: "" the whole list, else the search terms
  render: number; // a careers page read rendered (1), else from its plain HTML
  text_hash: string | null; // a careers page the model reads: its text when the model last read it
  model_at: string | null; // and when that was
  sitemap?: string | null; // a careers page read from its sitemap: its address, or "none <when>"
  sitemap_misses?: string | null; // its listed pages with no role on them: JSON {page: {at, n}}
  own_page?: string | null; // Ashby, hosted pages off: the company's own careers page; Lever: GONE when its page answers 404; "" on; null unchecked
  own_page_at?: string | null; // when that was checked
};

const HOUR = 3_600_000;
export const EVERY_HOURS = 6; // an active board is read this often
export const OLD_EVERY_HOURS = 24; // a board of a company not active (no signal in ACTIVE_DAYS), this often
export const ACTIVE_DAYS = 60; // a company a signal named this recently has active boards
export const FAILS_BEFORE_BROKEN = 3;
const PAGE_GIVE_UP_DAYS = 30; // a careers page failing this long sends its company back to discovery
// A board whose site answers 5xx or 429 this long, since its last good read, is broken: long past a
// real outage (Workday's 521s of 2026-11-13 lasted about ten hours) or a weekend's maintenance.
const OUTAGE_GIVE_UP_DAYS = 3;
const MAX_BACKOFF_HOURS = EVERY_HOURS; // a failing board waits an hour, then two, … up to this
export const MISSES_TO_CLOSE = 2;
export const SEARCHED_STALE_DAYS = 30; // a searched board's role unseen this long is closed
const SUSPECT_FROM = 20; // a read under half of a board this big is suspect
const LEASE_MS = 10 * 60_000;
// Seconds a whole read would take; past this a searchable board is read through its search, so
// one board can't hold Refresh all past a minute. Measured 2026-10-28 on the full refresh: an Oracle
// page of 200 took 2.6s (JPMorganChase's 25 pages: 66s), an Eightfold page of 10 took 0.55s.
const SEARCH_ABOVE_SECONDS = 30;
const PAGE_SIZE: Record<string, number> = {
  workday: 20,
  eightfold: 10,
  oraclecloud: 200,
  amazon: 100,
  jibeapply: 10,
};
// A Jibe site's page answers in under a second, but sites set a crawl-delay (GEO's: 5s).
const PAGE_SECONDS: Record<string, number> = {
  workday: 0.6,
  eightfold: 0.55,
  oraclecloud: 2.6,
  jibeapply: 2,
};

export type ReadOutcome = {
  board: number;
  company: number;
  name: string;
  status: "changed" | "unchanged" | "failed" | "suspect";
  added: number;
  closed: number;
  listed: number;
  error?: string;
};
export type Progress = (o: ReadOutcome & { done: number; total: number }) => void;

// --- scoring ------------------------------------------------------------------------

const filtersKey = (f: PostingFilters) =>
  createHash("sha256")
    .update(`${SCORE_RULES}:${JSON.stringify(f)}`)
    .digest("hex")
    .slice(0, 16);

/**
 * Score every open role again when the profile's filters changed since the last scoring: one pass
 * over the table, no re-reads. Called before reads and before the Inbox is shown, so an edit in
 * Settings (or by hand in profile.json) is in effect at once.
 */
export function ensureScored(filters = loadFilters()): number {
  const key = filtersKey(filters);
  if (getMeta("filters") === key) return 0;
  const n = rescore(filters);
  setMeta("filters", key);
  return n;
}

/** Re-score all open roles against these filters; returns how many changed. */
export function rescore(filters = loadFilters()): number {
  const d = open();
  const rows = d
    .query("SELECT id, title, location, fits, matched FROM roles WHERE closed_at IS NULL")
    .all() as {
    id: number;
    title: string;
    location: string;
    fits: number;
    matched: string | null;
  }[];
  const set = d.query("UPDATE roles SET fits = ?, matched = ? WHERE id = ?");
  let n = 0;
  tx(() => {
    for (const r of rows) {
      const s = score(r, filters);
      const fits = s.fits ? 1 : 0;
      if (fits === r.fits && s.matched === r.matched) continue;
      set.run(fits, s.matched, r.id);
      n++;
    }
    if (n) markChanged();
  });
  return n;
}

// --- which boards, when ---------------------------------------------------------------

// A company read every six hours: watched, or named by a signal in the last ACTIVE_DAYS.
const ACTIVE = `(c.watched_at IS NOT NULL OR (c.dismissed_at IS NULL AND c.last_signal_at >= $active))`;
// A board read at all: working, of a company not dismissed. Those not ACTIVE are read daily.
const READ = `b.status = 'ok' AND (c.watched_at IS NOT NULL OR c.dismissed_at IS NULL)`;

/** When a board is next read: `hours` on (six for an active one), give or take half an hour. */
export function nextRead(now: Date, hours = EVERY_HOURS): string {
  const jitter = (Math.random() - 0.5) * HOUR;
  return new Date(now.getTime() + hours * HOUR + jitter).toISOString();
}

const activeSince = (now: Date) => new Date(now.getTime() - ACTIVE_DAYS * DAY).toISOString();

/**
 * How many hours until a company's boards are read again: six while it's active, a day once its
 * last signal is older. A new signal wakes its boards (`wake`), and that read sets six again.
 */
export function readEvery(companyId: number, now = new Date()): number {
  const active = open()
    .query(`SELECT 1 FROM companies c WHERE c.id = $id AND ${ACTIVE}`)
    .get({ id: companyId, active: activeSince(now) });
  return active ? EVERY_HOURS : OLD_EVERY_HOURS;
}

/**
 * Boards due a read: of a company not dismissed, never read or past their time, and not being
 * read right now. The
 * biggest first: their reads are the long ones, so they start while the small ones fill the slots.
 */
export function dueBoards(now = new Date()): Board[] {
  return open()
    .query(
      `SELECT b.* FROM boards b JOIN companies c ON c.id = b.company_id
       WHERE ${READ} AND (b.next_read_at IS NULL OR b.next_read_at <= $now)
         AND (b.lease_until IS NULL OR b.lease_until < $now)
       ORDER BY coalesce(b.role_count, 0) DESC, b.next_read_at`,
    )
    .all({ now: now.toISOString() }) as Board[];
}

/** Every active board due now (Refresh all, `tick --now`); the daily ones keep their time. */
export function makeAllDue(now = new Date()): number {
  return open()
    .query(
      `UPDATE boards SET next_read_at = $now WHERE id IN (
         SELECT b.id FROM boards b JOIN companies c ON c.id = b.company_id WHERE ${READ} AND ${ACTIVE})`,
    )
    .run({ active: activeSince(now), now: now.toISOString() }).changes;
}

/** Take the board for one read; false when a read of it is already going (here or in the tick). */
function lease(id: number, now: Date): boolean {
  return (
    open()
      .query(
        "UPDATE boards SET lease_until = $until WHERE id = $id AND (lease_until IS NULL OR lease_until < $now)",
      )
      .run({ id, now: now.toISOString(), until: new Date(now.getTime() + LEASE_MS).toISOString() }).changes >
    0
  );
}
const unlease = (id: number) => open().query("UPDATE boards SET lease_until = NULL WHERE id = ?").run(id);
/**
 * Hold a board the pass took at `now` for LEASE_MS more from `elapsed` into the pass; false when
 * its lease ran out meanwhile and another read took it (the board is that read's now).
 */
function renew(id: number, now: Date, elapsed: number): boolean {
  const ours = new Date(now.getTime() + LEASE_MS).toISOString();
  const until = new Date(now.getTime() + elapsed + LEASE_MS).toISOString();
  return (
    open()
      .query("UPDATE boards SET lease_until = $until WHERE id = $id AND lease_until = $ours")
      .run({ id, ours, until }).changes > 0
  );
}

/**
 * The saved-search terms a big board's own search is asked for, or null to read it whole. Big:
 * its size says so; or its last whole read ran out of time (a board too big to read whole the
 * first time has no size yet, and would time out on every read); or it was searched last time.
 */
export function searchTerms(
  b: Pick<Board, "provider" | "role_count"> & Partial<Pick<Board, "partial" | "last_error">>,
  filters = loadFilters(),
): string[] | null {
  // Google Careers: one results page per query, so its queries are the titles themselves.
  if (QUERIED.includes(b.provider)) return filters.title_include?.length ? filters.title_include : null;
  if (!SEARCHABLE.includes(b.provider)) return null;
  const pages = Math.ceil((b.role_count ?? 0) / (PAGE_SIZE[b.provider] ?? 20));
  const big =
    b.provider === "amazon" || // all of Amazon (100,000+ roles): only ever searched
    b.provider === "avature" || // its list stops at a page cap with nothing saying so (search.mjs)
    pages * (PAGE_SECONDS[b.provider] ?? 1) > SEARCH_ABOVE_SECONDS ||
    !!b.partial ||
    /timed out/.test(b.last_error ?? "");
  if (!big) return null;
  return termsFor(filters);
}

// The search terms for a big board: the title words' stems. With no title words, one empty
// term: the board's own list from its first pages, partial, rather than a whole read that can't
// end in time (Publicis' Jibe site: 3,270 roles ten a page under a 5 s crawl-delay, about four
// and a half minutes, so every read of it hit the 120 s limit).
const termsFor = (filters: PostingFilters) => {
  const terms = stems(filters.title_include ?? []);
  return terms.length ? terms : [""];
};

/** The most roles a board of this provider is read whole: past it, its search is quicker. */
const wholeUpTo = (provider: string) =>
  Math.floor((SEARCH_ABOVE_SECONDS / (PAGE_SECONDS[provider] ?? 1)) * (PAGE_SIZE[provider] ?? 20));

/**
 * How a board is read: whole, or through its search (searchTerms). A searchable board never read
 * has no size yet: the runner asks its search for its count first and reads it whole only up
 * to wholeUpTo, so a big board's first read doesn't run out of time to find out.
 */
export function readPlan(
  b: Pick<Board, "provider" | "role_count"> & Partial<Pick<Board, "partial" | "last_error">>,
  filters = loadFilters(),
): { search?: string[]; searchAbove?: number } {
  const search = searchTerms(b, filters);
  if (search) return { search };
  if (b.role_count !== null || !SEARCHABLE.includes(b.provider)) return {};
  return { search: termsFor(filters), searchAbove: wholeUpTo(b.provider) };
}

// --- one read into the table -------------------------------------------------------------

type RoleRow = {
  id: number;
  ext_id: string | null;
  url: string;
  title: string;
  location: string;
  posted_at: string | null;
  updated_at: string | null;
  misses: number;
  closed_at: string | null;
  first_seen: string;
};

/**
 * Trouble on the site's side, not a sign the board has gone: an HTTP 5xx (Cloudflare's 52x
 * included) or 429, as the providers say it ("HTTP 521 <none>", "HTTP 429 TOO MANY REQUESTS") and
 * as a page read says it ("HTTP 503 for https://…"); and Workday's job API redirecting, as it does
 * to its maintenance page.
 */
const serverTrouble = (provider: string, error: string): boolean =>
  /\bHTTP (429|5\d\d)\b/.test(error) || (provider === "workday" && /^UnexpectedRedirect\b/.test(error));

function failRead(b: Board, error: string, now: Date): void {
  const fails = b.fails + 1;
  // A company's own careers page that keeps failing (or shows no roles) is read weekly after three
  // failed reads, and looked for again only after a month with nothing.
  const page = b.provider === "careers-page";
  // A board whose site is in trouble (this read, or the one before: a timeout as it ends) is tried
  // again on the usual back-off, and taken as broken only once it has failed for
  // OUTAGE_GIVE_UP_DAYS since its last good read.
  const outage =
    !page &&
    (serverTrouble(b.provider, error) || (b.fails > 0 && serverTrouble(b.provider, b.last_error ?? "")));
  const since = Date.parse(b.last_read_at ?? b.created_at);
  const days = page ? PAGE_GIVE_UP_DAYS : outage ? OUTAGE_GIVE_UP_DAYS : 0;
  const broken = fails >= FAILS_BEFORE_BROKEN && (!days || now.getTime() - since >= days * DAY);
  const wait =
    page && fails >= FAILS_BEFORE_BROKEN ? 7 * 24 * HOUR : Math.min(fails, MAX_BACKOFF_HOURS) * HOUR;
  tx(() => {
    open()
      .query(
        `UPDATE boards SET fails = $fails, last_error = $error, status = $status, lease_until = NULL,
           next_read_at = $next WHERE id = $id`,
      )
      .run({
        id: b.id,
        fails,
        error: error.slice(0, 300),
        status: broken ? "broken" : "ok",
        // Back off: an hour, then two, then broken (a careers page: weekly; a site in trouble: up
        // to six hours, until OUTAGE_GIVE_UP_DAYS).
        next: new Date(now.getTime() + wait).toISOString(),
      });
    // Three failed reads in a row: the company's board is looked for again, unless it has
    // another that works.
    if (broken)
      open()
        .query(
          `UPDATE companies SET discovery = 'queued', discovery_note = ? WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM boards WHERE company_id = companies.id AND status = 'ok')`,
        )
        .run(`board failed ${fails} reads: ${error.slice(0, 120)}`, b.company_id);
  });
  failure("refresh", b.url, error, { board: b.id, fails });
}

/**
 * A board that failed (failRead) for the third time with nothing to read: its roles close. Only
 * once failRead has marked it broken: a site in trouble keeps its roles meanwhile.
 */
function closeOnThird(b: Board, now: Date): number {
  if (b.fails + 1 < FAILS_BEFORE_BROKEN) return 0;
  return tx(() => {
    const d = open();
    const { status } = d.query("SELECT status FROM boards WHERE id = ?").get(b.id) as { status: string };
    if (status !== "broken") return 0;
    const closed = d
      .query("UPDATE roles SET closed_at = ? WHERE board_id = ? AND closed_at IS NULL")
      .run(now.toISOString(), b.id).changes;
    d.query("UPDATE boards SET role_count = 0 WHERE id = ?").run(b.id);
    if (closed) markChanged(now);
    return closed;
  });
}

/**
 * Fold one read of a board into the roles table, in one transaction. `partial`: the read came
 * from the board's search, so a role missing from it may still be open.
 */
export function applyRead(
  b: Board,
  r: Pick<
    RunnerResult,
    "ok" | "error" | "jobs" | "unchanged" | "validators" | "complete" | "order" | "boardSize"
  >,
  now = new Date(),
  // hours: when it is read next (a careers page the model reads: daily), else readEvery's.
  o: { partial?: boolean; terms?: string[]; filters?: PostingFilters; hours?: number } = {},
): Omit<ReadOutcome, "name"> {
  const base = { board: b.id, company: b.company_id, added: 0, closed: 0, listed: 0 };
  const d = open();
  const iso = now.toISOString();
  if (!r.ok || (!r.unchanged && !r.jobs)) {
    failRead(b, r.error ?? "the read didn't parse", now);
    return { ...base, status: "failed", error: r.error ?? "the read didn't parse" };
  }
  const touchBoard = (asked: string | null = null) =>
    d
      .query(
        `UPDATE boards SET last_read_at = $now, next_read_at = $next, fails = 0, last_error = NULL,
           lease_until = NULL, status = 'ok', read_terms = COALESCE($asked, read_terms) WHERE id = $id`,
      )
      .run({ id: b.id, now: iso, next: nextRead(now, o.hours ?? readEvery(b.company_id, now)), asked });
  // A searched read can't show a role is gone: one it hasn't listed in 30 days is taken as closed.
  const closeStale = () =>
    d
      .query("UPDATE roles SET closed_at = ? WHERE board_id = ? AND closed_at IS NULL AND last_seen < ?")
      .run(iso, b.id, new Date(now.getTime() - SEARCHED_STALE_DAYS * DAY).toISOString()).changes;
  // The same list as last time: a role missing from it is still missing (its second miss closes it).
  const sameList = (partial: boolean, asked: string | null = null) => {
    let closed = 0;
    tx(() => {
      touchBoard(asked);
      if (partial) {
        closed = closeStale();
        if (closed) markChanged(now);
        return;
      }
      d.query(
        "UPDATE roles SET misses = misses + 1 WHERE board_id = ? AND closed_at IS NULL AND misses > 0",
      ).run(b.id);
      closed = d
        .query("UPDATE roles SET closed_at = ? WHERE board_id = ? AND closed_at IS NULL AND misses >= ?")
        .run(iso, b.id, MISSES_TO_CLOSE).changes;
      if (closed) markChanged(now);
    });
    return closed;
  };
  if (r.unchanged) {
    const closed = sameList(!!b.partial);
    return { ...base, status: "unchanged", closed, listed: b.role_count ?? 0 };
  }
  // One id per posting however it was read (a snapshot's link, a reader's number).
  const jobs = dedupe(r.jobs!.map((j) => ({ ...j, id: postingId(b.provider, j.url, j.id) })));
  const partial = !!o.partial || r.complete === false;
  // What this read asked the board: its whole list, or its search for these terms.
  const asked = partial ? JSON.stringify(o.terms ?? []) : "";
  const prev = b.role_count ?? 0;
  // Nothing where there were roles is a failed read: a gone board's API may answer an empty list
  // (a JSON 404 reads as one), and Libra's board stayed "ok" with its old roles. Nothing closes on
  // one; the third in a row closes the board's roles and sends the company back to discovery,
  // as three failures do, and an empty board found again reads as empty from then on.
  // A careers page keeps its own rule for reads with no roles (careersJobs, weekly).
  if (!partial && prev > 0 && jobs.length === 0 && b.provider !== "careers-page") {
    const error = `listed no roles where the last read had ${prev}`;
    failRead(b, error, now);
    return { ...base, status: "failed", error, closed: closeOnThird(b, now) };
  }
  // Under half of what the board held (from 20 up): more likely a block page or a broken list than
  // a hiring freeze. Nothing closes on it.
  const suspect = !partial && prev >= SUSPECT_FROM && jobs.length < prev / 2;
  const hash = listHash(jobs);
  if (hash === b.list_hash && !suspect) {
    const closed = sameList(partial, asked);
    return { ...base, status: "unchanged", closed, listed: jobs.length };
  }
  const filters = o.filters ?? loadFilters();
  let added = 0;
  let inserted = 0;
  let closed = 0;
  tx(() => {
    const rows = d
      .query(
        "SELECT id, ext_id, url, title, location, posted_at, updated_at, misses, closed_at, first_seen FROM roles WHERE board_id = ?",
      )
      .all(b.id) as RoleRow[];
    const byExt = new Map<string, RoleRow>();
    const byUrl = new Map<string, RoleRow>(); // imported rows with no board id yet
    const closedByTitle = new Map<string, RoleRow>();
    for (const row of rows) {
      if (row.ext_id) byExt.set(row.ext_id, row);
      // By link too: an imported row has no board id yet, and a reader may name ids differently.
      byUrl.set(normalizeUrl(row.url), row);
      if (row.closed_at) closedByTitle.set(sameTitle(row.title, row.location), row);
    }
    const insert = d.query(
      `INSERT INTO roles (board_id, company_id, ext_id, url, title, location, mode, posted_at, updated_at,
         first_seen, last_seen, reposted, fits, matched, state)
       VALUES ($board, $company, $ext, $url, $title, $location, $mode, $posted, $updated,
         $now, $now, $reposted, $fits, $matched, $state) RETURNING id`,
    );
    const touch = d.query(
      "UPDATE roles SET last_seen = $now, misses = 0, closed_at = NULL, ext_id = $ext, url = $url WHERE id = $id",
    );
    const change = d.query(
      `UPDATE roles SET title = $title, location = $location, mode = $mode, posted_at = $posted,
         updated_at = $updated, fits = $fits, matched = $matched WHERE id = $id`,
    );
    const text = d.query(
      "INSERT INTO role_text (role_id, text, fetched_at) VALUES (?, ?, ?) ON CONFLICT(role_id) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at",
    );
    const seen = new Set<number>();
    // In a search newest first (r.order: each term's results in order), a role ahead of every
    // role the board already had was posted after all of them. One further down may be an old
    // role moving up as others close, or one a shorter read didn't reach.
    const ahead = new Set<string>();
    for (const list of r.order ?? []) {
      const head: string[] = [];
      for (const i of list) {
        const j = r.jobs?.[i];
        if (!j) break;
        const id = postingId(b.provider, j.url, j.id);
        if (byExt.has(id) || byUrl.has(normalizeUrl(j.url))) {
          for (const h of head) ahead.add(h);
          break;
        }
        head.push(id);
      }
    }
    // A role arrives new when it's news: posted in the last postings.max_age_days; with no date,
    // when it first shows on a read that asked the board what its last read asked, and couldn't
    // have missed it then: a whole read, a search read to the end, or ahead of every known role
    // in a search newest first. On a first read, or one asking something new (other terms,
    // another order), it's backlog; so is one surfacing partway down a search. And always when
    // a signal named it (the LinkedIn alert that brought the company in). The rest are filed:
    // on the company page, not in the Inbox.
    const named = new Set(
      (
        d.query("SELECT title FROM signals WHERE company_id = ? AND title IS NOT NULL").all(b.company_id) as {
          title: string;
        }[]
      ).map((x) => sameTitle(x.title, "")),
    );
    const maxAge = loadConfig().postings.max_age_days * DAY;
    const arrives = (j: Job) =>
      named.has(sameTitle(j.title, "")) ||
      (j.postedAt
        ? now.getTime() - Date.parse(j.postedAt) <= maxAge
        : b.read_terms === asked && (!partial || r.complete === true || ahead.has(j.id)));
    for (const listed of jobs) {
      const byLink = byUrl.get(normalizeUrl(listed.url));
      const row = byExt.get(listed.id) ?? (byLink && !seen.has(byLink.id) ? byLink : undefined);
      // A link that isn't a web page or a mail link is never stored. A role already kept under
      // that id stays as it is and counts as listed, so it isn't missed for it.
      if (!roleLinkOk(listed.url)) {
        if (row) seen.add(row.id);
        continue;
      }
      // Workday's list says "3 Locations" where the detail named the places (resolvePlaces):
      // the places stay.
      const j =
        row &&
        isMultiLocationPlaceholder(listed.location) &&
        row.location &&
        !isMultiLocationPlaceholder(row.location)
          ? { ...listed, location: row.location }
          : listed;
      const s = score(j, filters);
      const mode = workMode(j).mode;
      const news = arrives(j);
      let id: number;
      if (row) {
        id = row.id;
        seen.add(id);
        touch.run({ id, now: iso, ext: j.id, url: j.url });
        if (
          row.title !== j.title ||
          row.location !== j.location ||
          (j.updatedAt && j.updatedAt !== row.updated_at)
        )
          change.run({
            id,
            title: j.title,
            location: j.location,
            mode,
            posted: j.postedAt,
            updated: j.updatedAt ?? null,
            fits: s.fits ? 1 : 0,
            matched: s.matched,
          });
      } else {
        const before = closedByTitle.get(sameTitle(j.title, j.location));
        id = (
          insert.get({
            board: b.id,
            company: b.company_id,
            ext: j.id,
            url: j.url,
            title: j.title,
            location: j.location,
            mode,
            posted: j.postedAt,
            updated: j.updatedAt ?? null,
            now: iso,
            reposted: before ? (before.first_seen ?? null) : null,
            fits: s.fits ? 1 : 0,
            matched: s.matched,
            state: news ? "new" : "archived",
          }) as { id: number }
        ).id;
        seen.add(id);
        inserted++;
        if (news && s.fits) added++; // what reaches the Inbox
      }
      // Lever's and Ashby's lists carry the text anyway: kept for the roles that fit, as plain
      // text as ats/detail.ts keeps it (amazon.jobs sends HTML: "<p>Design &amp; build").
      if (s.fits && j.description) text.run(id, htmlToText(j.description), iso);
    }
    if (partial) closed += closeStale();
    if (!partial && !suspect) {
      const miss = d.query("UPDATE roles SET misses = $misses, closed_at = $closed WHERE id = $id");
      for (const row of rows) {
        if (row.closed_at || seen.has(row.id)) continue;
        const misses = row.misses + 1;
        const close = misses >= MISSES_TO_CLOSE;
        miss.run({ id: row.id, misses, closed: close ? iso : null });
        if (close) closed++;
      }
    }
    touchBoard(asked);
    d.query(
      `UPDATE boards SET role_count = $count, partial = $partial, etag = $etag, last_modified = $lm${
        suspect ? "" : ", list_hash = $hash"
      } WHERE id = $id`,
    ).run({
      id: b.id,
      // A searched read lists part of the board: the board is still as big as it was, so the next
      // read is searched too (searchTerms) rather than read whole at a minute's cost.
      count: partial ? Math.max(prev, jobs.length, r.boardSize ?? 0) : jobs.length,
      partial: partial ? 1 : 0,
      etag: r.validators?.etag ?? null,
      lm: r.validators?.lastModified ?? null,
      ...(suspect ? {} : { hash }),
    });
    if (inserted || closed) markChanged(now);
  });
  if (suspect)
    failure(
      "refresh",
      b.url,
      `suspect read: ${jobs.length} roles where the last read had ${prev}; nothing closed`,
      {
        board: b.id,
      },
    );
  return { ...base, status: suspect ? "suspect" : "changed", added, closed, listed: jobs.length };
}

/** One row per board id: a board that lists a role twice (two locations) keeps the first. */
function dedupe(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  });
}

// --- reading boards ---------------------------------------------------------------------

// A careers page or jobs feed is read whole up to this: ServiceNow's feed, with every posting's
// text, is 6.4 MB.
const CAREERS_PAGE_BYTES = 20_000_000;

const RENDERS_PER_PASS = 6;
const NO_ROLES = "no roles on the page";

// A pass reads new role pages for at most this long, its sitemap boards together (about 120 at one
// a second, inside the boards' 10-minute leases); while pages are left, the board is due again at
// the next tick, so a big company's backlog clears in about an hour rather than a few days.
let sitemapMs = 4 * 60_000;
const SITEMAP_AGAIN_MS = 10 * 60_000; // after this tick's second refreshDue, before the next tick
/** The reading time a pass gets, swappable in tests. */
export function setSitemapBudget(ms: number | null): void {
  sitemapMs = ms ?? 4 * 60_000;
}
const SITEMAP_RECHECK_DAYS = 30;
// A listed page read with no role on it (gone, or not a role's page) is tried again after a day,
// then twice as long each time it still has none, up to a month: not read again every pass.
const MISS_RETRY_MAX_DAYS = 30;
type Miss = { at: string; n: number };

/** A careers page's sitemap, if its robots.txt names one whose role pages carry JobPosting (2 of 3 tried). */
async function findSitemap(careersUrl: string): Promise<string | null> {
  const url = pickSitemap(careersUrl, await sitemapsFor(careersUrl));
  if (!url) return null;
  const locs = sitemapLocs(
    (await getPage(url, { accept: "application/xml", maxBytes: CAREERS_PAGE_BYTES })).text,
  );
  if (locs.length < 3) return null;
  let ok = 0;
  for (const loc of [locs[0]!, locs[Math.floor(locs.length / 2)]!, locs.at(-1)!]) {
    const html = await getPage(loc, { accept: "text/html" }).then(
      (r) => r.text,
      () => "",
    );
    if (rolePage(html, loc)) ok++;
  }
  return ok >= 2 ? url : null;
}

/**
 * A careers page read from its sitemap, or null to read the page as before. The sitemap lists every
 * open role, so a role it no longer lists closes as on any whole read. A role already stored is
 * listed from its row; a new one's page is read once for its JobPosting, until the pass's sitemap
 * time is up at `until` (the rest come next pass, closing nothing meanwhile). A page with no role
 * on it waits (MISS_RETRY_MAX_DAYS). When a board first takes its sitemap, its rows the model read
 * (no date, no place) have their pages read first.
 */
async function readSitemap(
  b: Board,
  now: Date,
  filters: PostingFilters,
  until: number,
): Promise<Omit<ReadOutcome, "name"> | null> {
  const d = open();
  let switched = false;
  const stale = b.sitemap?.startsWith("none ")
    ? now.getTime() - Date.parse(b.sitemap.slice(5)) > SITEMAP_RECHECK_DAYS * DAY
    : !b.sitemap;
  if (stale) {
    const found = await findSitemap(b.url).catch(() => null);
    b.sitemap = found ?? `none ${now.toISOString()}`;
    d.query("UPDATE boards SET sitemap = ? WHERE id = ?").run(b.sitemap, b.id);
    switched = !!found;
  }
  if (!b.sitemap || b.sitemap.startsWith("none ")) return null;
  const locs = sitemapLocs(
    (await getPage(b.sitemap, { accept: "application/xml", maxBytes: CAREERS_PAGE_BYTES })).text,
  );
  // An empty or unreadable list would close every role: a failed read instead.
  if (!locs.length) throw new Error(`the sitemap ${b.sitemap} lists no pages`);
  type Row = {
    ext_id: string | null;
    url: string;
    title: string;
    location: string;
    posted_at: string | null;
  };
  const rows = new Map(
    (
      d
        .query(
          "SELECT ext_id, url, title, location, posted_at FROM roles WHERE board_id = ? AND closed_at IS NULL",
        )
        .all(b.id) as Row[]
    ).map((r) => [normalizeUrl(r.url), r]),
  );
  const fromRow = (r: Row): Job => ({
    id: r.ext_id ?? r.url,
    title: r.title,
    url: r.url,
    location: r.location,
    postedAt: r.posted_at,
  });
  // Pages read before with no role on them, each waiting longer after each miss.
  const misses = JSON.parse(b.sitemap_misses ?? "{}") as Record<string, Miss>;
  const waiting = (key: string) => {
    const m = misses[key];
    return !!m && now.getTime() - Date.parse(m.at) < Math.min(2 ** (m.n - 1), MISS_RETRY_MAX_DAYS) * DAY;
  };
  const unread = (r: Row | undefined, key: string) =>
    r ? switched && !r.posted_at && !r.location : !waiting(key);
  // The model's rows first (only on the switch), then new pages, as the sitemap lists them.
  const order = [...new Set(locs)].sort(
    (x, y) => Number(!rows.has(normalizeUrl(x))) - Number(!rows.has(normalizeUrl(y))),
  );
  const jobs: Job[] = [];
  let left = 0; // pages this pass had no time for (not ones it read and found no role on)
  for (const loc of order) {
    const key = normalizeUrl(loc);
    const row = rows.get(key);
    const late = unread(row, key) && Date.now() >= until;
    if (late) left++;
    if (!unread(row, key) || late) {
      if (row) jobs.push(fromRow(row));
      continue;
    }
    const job = await getPage(loc, { accept: "text/html" }).then(
      (r) => rolePage(r.text, loc),
      () => null,
    );
    if (job) {
      jobs.push(job);
      delete misses[key];
    } else if (row) jobs.push(fromRow(row));
    else misses[key] = { at: now.toISOString(), n: (misses[key]?.n ?? 0) + 1 };
  }
  // Kept for the pages the sitemap still lists.
  const listed = new Set(locs.map(normalizeUrl));
  const kept = Object.entries(misses).filter(([k]) => listed.has(k));
  d.query("UPDATE boards SET sitemap_misses = ? WHERE id = ?").run(
    kept.length ? JSON.stringify(Object.fromEntries(kept)) : null,
    b.id,
  );
  const out = applyRead(b, { ok: true, jobs }, now, { filters });
  if (left)
    d.query("UPDATE boards SET next_read_at = ? WHERE id = ?").run(
      new Date(now.getTime() + SITEMAP_AGAIN_MS).toISOString(),
      b.id,
    );
  return out;
}

/**
 * One read of a company's own careers page: plain (with its ETag) or rendered, as discovery found
 * it reads. Its JobPosting data, own job list or feed are read free. Else the small model reads
 * it, only when its text changed since the model last read it, at most once a day, and inside the
 * page cap; until then it stays as it was. A page that shows no roles counts as a failed read.
 */
async function readCareersPage(
  b: Board,
  browser: () => Promise<Renderer>,
  now: Date,
  filters: PostingFilters,
  sitemapUntil: number,
): Promise<Omit<ReadOutcome, "name">> {
  const listed = await readSitemap(b, now, filters, sitemapUntil);
  if (listed) return listed;
  let html: string;
  let page: PageText | null = null;
  let validators: { etag?: string; lastModified?: string } | undefined;
  if (b.render) {
    const r = await (await browser()).render(b.url);
    if (r.blocked) throw new Error(`robots.txt disallows ${r.blocked}`);
    if (r.status && r.status >= 400) throw new Error(`HTTP ${r.status} for ${b.url}`);
    html = r.html;
    page = r;
  } else {
    const got = await getPage(b.url, {
      ...(b.etag ? { etag: b.etag } : {}),
      ...(b.last_modified ? { lastModified: b.last_modified } : {}),
      maxBytes: CAREERS_PAGE_BYTES,
    });
    // Cut short, a list would close every role past the cut: not read.
    if (Buffer.byteLength(got.text) >= CAREERS_PAGE_BYTES)
      throw new Error(`the page is larger than ${CAREERS_PAGE_BYTES / 1e6} MB`);
    if (got.notModified) return applyRead(b, { ok: true, unchanged: true }, now, { filters });
    validators = { etag: got.etag, lastModified: got.lastModified };
    html = got.text;
  }
  const free = careersJobs(html, b.url);
  if (free.length || isFeed(html))
    return applyRead(b, { ok: true, jobs: free, validators }, now, { filters });
  page ??= plainText(html, b.url);
  const hours = OLD_EVERY_HOURS;
  const hash = textHash(page.text);
  if (hash === b.text_hash)
    return b.last_error?.startsWith(NO_ROLES)
      ? applyRead(b, { ok: false, error: b.last_error }, now, { filters })
      : applyRead(b, { ok: true, unchanged: true }, now, { filters, hours });
  // Changed, but read by the model within a day, or no model to read it (no key, past a cap): it
  // waits as it was, for its next read.
  const wait = () => {
    open()
      .query("UPDATE boards SET next_read_at = ?, lease_until = NULL WHERE id = ?")
      .run(nextRead(now, hours), b.id);
    return {
      board: b.id,
      company: b.company_id,
      status: "unchanged" as const,
      added: 0,
      closed: 0,
      listed: b.role_count ?? 0,
    };
  };
  if (now.getTime() - Date.parse(b.model_at ?? "1970-01-01") < DAY || !canReadPages(now)) return wait();
  // Counted from the attempt: a model that fails isn't asked again for a day.
  open().query("UPDATE boards SET model_at = ? WHERE id = ?").run(now.toISOString(), b.id);
  const c = open()
    .query("SELECT name, domain, domain_from FROM companies WHERE id = ?")
    .get(b.company_id) as {
    name: string;
    domain: string | null;
    domain_from: DomainFrom | null;
  };
  // On its own site (or its second site), the employer the page names is the company.
  const own = ownSite(c, { url: page.url, html, links: page.links.map((l) => l.href) }) !== null;
  let read: Awaited<ReturnType<typeof readPage>>;
  try {
    read = await readPage(c, page, own, b.id);
  } catch (err) {
    if (err instanceof NoModelKey || err instanceof OverCap) return wait();
    throw err;
  }
  open().query("UPDATE boards SET text_hash = ? WHERE id = ?").run(hash, b.id);
  if (!read.jobs.length)
    return applyRead(b, { ok: false, error: `${NO_ROLES}: ${read.note}` }, now, { filters });
  // The model's first read of a page another reader read before (role cards, until 2026-10-30):
  // what it adds is backlog, as on any board's first read, not news.
  const first = b.model_at ? b : { ...b, read_terms: null };
  return applyRead(first, { ok: true, jobs: read.jobs, validators }, now, { filters, hours });
}

export const OWN_PAGE_DAYS = 7;
// A Lever board whose page answers 404: the company has left it, though Lever's API lists its roles.
export const GONE = "gone";

/**
 * Has the company turned Ashby's hosted pages off? Checked weekly from the board's embed view
 * (boardStates): Cursor's jobs.ashbyhq.com pages all answer 404 while the posting API lists its
 * roles, and the embed view then states its own careers page. Its roles open in the embed view
 * (ashbyEmbedView), which still answers. A change clears the list's hash and validators, so this
 * pass reads the whole list and writes each role's link; a read that failed changes nothing.
 * A company with no careers page saved gets that one. A Lever board is checked for its page
 * answering 404 (leverPageGone): its reads fail while it does, and the third sends the company
 * back to discovery.
 */
async function ownPages(boards: Board[], now: Date): Promise<void> {
  // A Lever board is first checked a week after it was found: it was found from its roles.
  const since = (b: Board) => b.own_page_at ?? (b.provider === "lever" ? b.created_at : null);
  const due = boards.filter((b) => {
    const at = since(b);
    return (
      (b.provider === "ashby" || b.provider === "lever") &&
      (!at || now.getTime() - Date.parse(at) >= OWN_PAGE_DAYS * DAY)
    );
  });
  const iso = now.toISOString();
  for (let i = 0; i < due.length; i += 4)
    await Promise.all(
      due.slice(i, i + 4).map(async (b) => {
        let page: string;
        if (b.provider === "lever") {
          const gone = await leverPageGone(b.url);
          if (gone === null) return;
          page = gone ? GONE : "";
        } else {
          const said = await boardStates(b.url, { fresh: true });
          if (!said) return;
          page = said.page ?? "";
        }
        const changed = page !== (b.own_page ?? "");
        tx(() => {
          open()
            .query(
              `UPDATE boards SET own_page = $page, own_page_at = $now${
                changed ? ", list_hash = NULL, etag = NULL, last_modified = NULL" : ""
              } WHERE id = $id`,
            )
            .run({ id: b.id, page, now: iso });
          if (page && page !== GONE)
            open()
              .query("UPDATE companies SET careers_url = ? WHERE id = ? AND careers_url IS NULL")
              .run(page, b.company_id);
        });
        Object.assign(b, { own_page: page, own_page_at: iso });
        if (changed) Object.assign(b, { list_hash: null, etag: null, last_modified: null });
      }),
    );
}

const nameOf = (companyId: number) =>
  (open().query("SELECT name FROM companies WHERE id = ?").get(companyId) as { name: string } | null)?.name ??
  "";

/**
 * Read these boards now, up to 8 at once (the runner's own limits per host), each saved as it
 * comes back. A board already being read elsewhere is skipped.
 */
export async function readBoards(
  boards: Board[],
  now = new Date(),
  progress: Progress = () => {},
): Promise<ReadOutcome[]> {
  ensureScored();
  const filters = loadFilters();
  const started = Date.now();
  // One reading time for the pass's sitemap pages, all its boards together: the pass ends inside
  // the leases it took.
  const sitemapUntil = started + sitemapMs;
  // A rendered careers page takes up to RENDER_MS: at most RENDERS_PER_PASS a pass, the rest next time.
  const rendered = boards.filter((b) => b.provider === "careers-page" && b.render);
  const later = new Set(rendered.slice(RENDERS_PER_PASS));
  // Held from when the pass starts: a tick's pass can start long after the tick's `now` (its
  // sources, then discovery's time), and a lease from then would have run out already.
  const held = new Date(Math.max(now.getTime(), started));
  const mine = boards.filter((b) => !later.has(b) && lease(b.id, held));
  const total = mine.length;
  const out: ReadOutcome[] = [];
  const lost = new Set<number>(); // boards another read took while this pass ran
  const done = (o: Omit<ReadOutcome, "name">) => {
    const full = { ...o, name: nameOf(o.company) };
    out.push(full);
    progress({ ...full, done: out.length, total });
  };
  const byId = new Map(mine.map((b) => [String(b.id), b]));
  const searched = new Map<string, boolean>();
  const terms = new Map<string, string[] | undefined>();
  try {
    // A company's own careers page (no job board behind it): read here while the runner reads the
    // job boards, in one browser for those read rendered.
    const pages = async () => {
      let browser: Renderer | null = null;
      const render = async () => {
        browser ??= await renderer(loadConfig().polling.user_agent);
        return browser;
      };
      try {
        for (const b of mine.filter((x) => x.provider === "careers-page")) {
          // Read one after another, a page can start long after the pass took its lease: held anew
          // from here, unless its lease ran out and another read took it.
          if (!renew(b.id, held, Date.now() - started)) {
            lost.add(b.id);
            continue;
          }
          try {
            done(await readCareersPage(b, render, now, filters, sitemapUntil));
          } catch (err) {
            // No internet, or no browser on this Mac to render it: not counted, the board stays due
            // (let go below, with no outcome). The Problems list says the browser is missing.
            const message = (err as Error).message;
            if (!noBrowser(message) && (await countsAsFailure(message)))
              done(applyRead(b, { ok: false, error: message }, now, { filters }));
          }
        }
      } finally {
        await (browser as Renderer | null)?.close();
      }
    };
    const boardsToRun = mine.filter((x) => x.provider !== "careers-page");
    // A read that failed at the network level is counted only once it's known the internet is up.
    const asking: Promise<void>[] = [];
    // The hosted-page checks run while the careers pages are read; the job boards after them.
    const jobBoards = ownPages(boardsToRun, now).then(async () => {
      const left = boardsToRun.filter((b) => b.own_page === GONE);
      for (const b of left) {
        const o = applyRead(
          b,
          { ok: false, error: "its Lever page answers 404: the company has left it" },
          now,
        );
        done({ ...o, closed: closeOnThird(b, now) });
      }
      await runBoards(
        "scan",
        boardsToRun
          .filter((b) => b.own_page !== GONE)
          .map((b) => {
            const plan = readPlan(b, filters);
            searched.set(String(b.id), !!plan.search && plan.searchAbove === undefined);
            terms.set(String(b.id), plan.search);
            return {
              domain: String(b.id),
              name: nameOf(b.company_id),
              ats: { provider: b.provider, careers_url: b.url },
              ...(b.etag || b.last_modified
                ? { validators: { etag: b.etag ?? undefined, lastModified: b.last_modified ?? undefined } }
                : {}),
              ...plan,
            };
          }),
        (r) => {
          const b = byId.get(r.domain);
          // Hosted pages off: each role's link is its embed view.
          const read =
            b?.provider === "ashby" && b.own_page && r.jobs
              ? { ...r, jobs: r.jobs.map((j) => ({ ...j, url: ashbyEmbedView(j.url) })) }
              : r;
          const apply = (b: Board) =>
            done(
              applyRead(b, read, now, {
                partial: r.searched ?? searched.get(r.domain),
                terms: terms.get(r.domain),
                filters,
              }),
            );
          if (b && !read.ok && networkError(read.error))
            asking.push(countsAsFailure(read.error).then((counts) => (counts ? apply(b) : undefined)));
          else if (b) apply(b);
        },
      );
      await Promise.all(asking);
    });
    await Promise.all([pages(), jobBoards]);
  } finally {
    // Whatever didn't come back (the runner died) is free for the next read; not one another read
    // holds now.
    for (const b of mine) if (!lost.has(b.id) && !out.some((o) => o.board === b.id)) unlease(b.id);
  }
  return out;
}

/** The tick's read: every board that's due. */
export async function refreshDue(now = new Date(), progress?: Progress): Promise<ReadOutcome[]> {
  return readBoards(dueBoards(now), now, progress);
}

/** Refresh all: every active board due now, then read. */
export async function refreshAll(now = new Date(), progress?: Progress): Promise<ReadOutcome[]> {
  makeAllDue(now);
  return refreshDue(now, progress);
}

/** One company's boards, now (the Refresh button on its row). */
export async function refreshCompany(companyId: number, now = new Date(), progress?: Progress) {
  const boards = open()
    .query("SELECT * FROM boards WHERE company_id = ? AND status = 'ok'")
    .all(companyId) as Board[];
  return readBoards(boards, now, progress);
}

/** A line for the rail: what a pass of reads did. */
export const PLACES_PER_TICK = 100;

/**
 * Workday lists a role in several places as "3 Locations"; the vendored provider names them only
 * on a whole read and spends a GET per role on every read. Here each open role with a wanted title
 * (and the placeholder) has its detail read once, newest first, at most `limit` a tick: its places,
 * work mode and fit are set, and its text kept when it now fits. A read that fails is tried next
 * tick; the list's placeholder never overwrites the places again (applyRead).
 */
export async function resolvePlaces(now = new Date(), limit = PLACES_PER_TICK): Promise<number> {
  const d = open();
  const filters = loadFilters();
  const rows = (
    d
      .query(
        `SELECT r.id, r.url, r.title, r.location FROM roles r JOIN boards b ON b.id = r.board_id
         WHERE b.provider = 'workday' AND r.closed_at IS NULL AND r.location GLOB '[0-9]* Location*'
         ORDER BY r.first_seen DESC`,
      )
      .all() as { id: number; url: string; title: string; location: string }[]
  ).filter(
    (r) => isMultiLocationPlaceholder(r.location) && score({ title: r.title, location: "" }, filters).fits,
  );
  let resolved = 0;
  for (const r of rows.slice(0, limit)) {
    const got = await workdayDetail(r.url).catch(() => null);
    if (!got?.places) continue;
    const job = { title: r.title, location: got.places, description: got.text };
    const s = score(job, filters);
    tx(() => {
      d.query("UPDATE roles SET location = ?, mode = ?, fits = ?, matched = ? WHERE id = ?").run(
        got.places,
        workMode(job).mode,
        s.fits ? 1 : 0,
        s.matched,
        r.id,
      );
      if (s.fits && got.text)
        d.query(
          "INSERT INTO role_text (role_id, text, fetched_at) VALUES (?, ?, ?) ON CONFLICT(role_id) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at",
        ).run(r.id, got.text, now.toISOString());
    });
    resolved++;
  }
  if (resolved) markChanged(now);
  return resolved;
}

export function summary(outcomes: ReadOutcome[]): string {
  const sum = (k: "added" | "closed") => outcomes.reduce((n, o) => n + o[k], 0);
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const changed = outcomes.filter((o) => o.status === "changed").length;
  return `${outcomes.length} boards read · ${changed} changed · ${sum("added")} new roles · ${sum("closed")} closed${
    failed ? ` · ${failed} failed` : ""
  }`;
}

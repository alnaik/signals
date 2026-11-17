// The Inbox read path. A page is 50 companies from one indexed query (keyset paging): the
// company, how many open roles that fit are new, its newest, its signals and its board. A
// company's roles load when it's opened, a role's text when the role is. Nothing here reads a
// file per row.
import { inMetro, loadFilters, missed, usPlaces, workMode } from "../ats/filters.ts";
import { registrable } from "../ats/reader.ts";
import { DAY, open } from "../core/db.ts";
import { applyEmailOf, type Company, fundingOf } from "../intake/companies.ts";
import { ensureScored } from "../intake/refresh.ts";
import { type Found, search } from "./search.ts";

export const EXPIRE_DAYS = 21; // an untouched role, or a signal about a company with roles that fit, leaves after this
export const PAGE = 50;
export const WEEK_DAYS = 7; // "new" on a watched company's label: first seen this week

/**
 * A role new to you at a watched company is one first seen since you watched it (at the same
 * moment counts: Add reads the board with the time it watched the company); at any other company,
 * every role is. The Inbox, a company's Inbox roles, Clear and the Watchlist's count all use it.
 */
export const sinceWatched = (firstSeen: string, watchedAt: string) =>
  `${firstSeen} >= coalesce(${watchedAt}, '')`;

/**
 * When a role became one for you: first seen, or later, when it started to fit (`fit_at`: a title
 * word added, the title rules changed, its place read from its page). "New", the 21 days and
 * sinceWatched count from here, so a role that starts to fit reaches the Inbox like one just posted.
 */
export const cameAt = (r = "") => `max(${r}first_seen, coalesce(${r}fit_at, ''))`;

export type InboxSignal = { source: string; tag: string; title: string | null; url: string; at: string };
export type InboxCompany = {
  id: number;
  name: string;
  domain: string | null;
  at: string; // newest: a role first seen, or a signal
  roles: number; // open roles that fit, new to you
  fit: number; // open roles that fit, new or not (a signal's company with none new opens to these)
  watched: boolean; // on the Watchlist: in the Inbox only while it has roles new since you watched it
  week: number; // watched: of those, first seen in the last 7 days (what "new" means on its label)
  partial: boolean; // its board is read through its own search
  board: { url: string; provider: string; status: string } | null;
  link: string | null; // where the name links: the careers page saved, when it's on the company's own site; else the board
  discovery: string | null; // "none": no board found (with careers_url when one was seen); "unreadable": careers site only
  careers_url: string | null;
  email: string | null; // takes applications by email
  funding: { date: string; url: string } | null;
  signals: InboxSignal[]; // newest per source
  held?: number; // "Everything else" only: open roles, fitting or not (`roles` is those that fit)
  // With a search: the titles that matched, how many of its roles did and how many of those fit
  // (its row opens to them), and whether you dismissed it.
  hits?: string[];
  hitRoles?: number;
  hitFits?: number;
  dismissed?: boolean;
};

type Cursor = { at: string; id: number; n?: number; m?: number };
/**
 * The careers page saved for a company, when it's on the company's own site (cursor.com/careers,
 * careers.gradient.network): the page its roles show on, which its board may not be (Cursor's
 * Ashby pages answer 404). One on a job board or a page host (Notion, Built In) isn't.
 */
function ownPage(c: { domain: string | null; careers_url: string | null }): string | null {
  if (!c.domain || !c.careers_url) return null;
  try {
    return registrable(new URL(c.careers_url).hostname) === registrable(c.domain) ? c.careers_url : null;
  } catch {
    return null;
  }
}

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString()) as Cursor;
    return typeof c.at === "string" &&
      Number.isInteger(c.id) &&
      (c.n === undefined || Number.isInteger(c.n)) &&
      (c.m === undefined || Number.isInteger(c.m))
      ? c
      : null;
  } catch {
    return null;
  }
}

export type InboxQuery = {
  cursor?: string | null;
  source?: string | null;
  remote?: boolean;
  metro?: string | null;
  city?: number[] | null; // the city's companies (inCity), found once per request; else found here
  only?: number;
};

const cutoff = (now: Date) => new Date(now.getTime() - EXPIRE_DAYS * DAY).toISOString();

/**
 * One page of the Inbox. A company is in it while it has new roles that fit (first seen in the
 * last 21 days, not closed), or an open role that fits and a signal from the last 21 days received
 * after your latest Apply or Dismiss on one of its roles; never when dismissed. A company a signal
 * named with nothing open that fits is on the Signals screen instead (signals/query.ts). A watched
 * company is in it only while it has new roles that fit first seen since you watched it, and only
 * those count. `source`: only companies a signal from that source named (watched ones aren't).
 * `remote`: only remote roles count (a company a signal brought stays).
 * `metro`: only companies with an open role that fits in that city of the profile's `metros`.
 */
export function inboxPage(
  q: InboxQuery = {},
  now = new Date(),
): { companies: InboxCompany[]; next: string | null; count?: number } {
  ensureScored();
  const after = decodeCursor(q.cursor);
  const rows = open()
    .query(
      `${listed(q)}
       SELECT *${after ? "" : ", count(*) OVER () AS total"} FROM page
       ${after ? "WHERE at < $at OR (at = $at AND id < $id)" : ""}
       ORDER BY at DESC, id DESC LIMIT $limit`,
    )
    .all({
      ...binds(q, now),
      limit: PAGE + 1,
      ...(after ? { at: after.at, id: after.id } : {}),
    }) as (Company & {
    n: number;
    at: string;
    total?: number;
  })[];
  const more = rows.length > PAGE;
  const page = rows.slice(0, PAGE);
  const companies = describe(page, now);
  const last = page.at(-1);
  return {
    companies,
    next: more && last ? encodeCursor({ at: last.at, id: last.id }) : null,
    // The first page carries how many companies the list has (inboxCount's number); later pages don't.
    ...(after ? {} : { count: rows[0]?.total ?? 0 }),
  };
}

/** How many companies the Inbox lists with these filters: the same `page` as inboxPage, counted. */
export function inboxCount(q: InboxQuery = {}, now = new Date()): number {
  ensureScored();
  const r = open()
    .query(`${listed(q)} SELECT count(*) AS n FROM page`)
    .get(binds(q, now)) as { n: number };
  return r.n;
}

/**
 * The CTE `sig`: each company's newest signal from the last 21 days that came after your latest
 * Apply or Dismiss on one of its roles. A signal you already acted on keeps no company listed; a
 * newer one brings it back. A company you decided nothing on keeps every recent signal.
 */
const afterDecided = `s.received_at > coalesce((SELECT max(r.state_at) FROM roles r
     WHERE r.company_id = s.company_id AND r.state IN ('applied', 'dismissed')), '')`;
const heard = `sig AS (
     SELECT s.company_id, max(s.received_at) AS last FROM signals s
     WHERE s.received_at >= $cutoff AND s.company_id IS NOT NULL AND ${afterDecided}
     GROUP BY s.company_id
   )`;

/** The companies the Inbox lists, as the CTE `page` (one row each, `n` new roles that fit, `at` newest). */
const listed = (q: InboxQuery) =>
  `WITH live AS (
     SELECT r.company_id, count(*) AS n, max(${cameAt("r.")}) AS newest
     FROM roles r JOIN companies c ON c.id = r.company_id
     WHERE r.state = 'new' AND r.fits = 1 AND r.closed_at IS NULL AND ${cameAt("r.")} >= $cutoff
       AND ${sinceWatched(cameAt("r."), "c.watched_at")}
       ${q.remote ? "AND r.mode = 'remote'" : ""}
     GROUP BY r.company_id
   ), ${heard}, page AS (
     SELECT c.*, coalesce(live.n, 0) AS n,
       CASE WHEN c.watched_at IS NULL THEN max(coalesce(live.newest, ''), coalesce(sig.last, ''))
         ELSE live.newest END AS at
     FROM companies c
     LEFT JOIN live ON live.company_id = c.id
     LEFT JOIN sig ON sig.company_id = c.id
     WHERE ((c.watched_at IS NOT NULL AND live.n IS NOT NULL)
       OR (c.watched_at IS NULL AND c.dismissed_at IS NULL AND (live.n IS NOT NULL OR (sig.last IS NOT NULL
         AND EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.closed_at IS NULL AND r.fits = 1)))))
       ${q.only !== undefined ? "AND c.id = $only" : ""}
       ${
         q.source
           ? "AND c.watched_at IS NULL AND EXISTS (SELECT 1 FROM signals s WHERE s.company_id = c.id AND s.source = $source)"
           : ""
       }
       ${q.metro ? "AND c.id IN (SELECT value FROM json_each($metro))" : ""}
   )`;
const binds = (q: InboxQuery, now: Date) => ({
  cutoff: cutoff(now),
  ...(q.only !== undefined ? { only: q.only } : {}),
  ...(q.source ? { source: q.source } : {}),
  ...(q.metro ? { metro: JSON.stringify(q.city ?? inCity(q.metro)) } : {}),
});

/**
 * One page of what the search box's words find (search.ts): every company with a role they find,
 * any company, watched or dismissed, the one their words name first, then the most roles that fit.
 * `cursor`: how many were shown.
 */
export function searchPage(
  q: string,
  o: { cursor?: string | null; only?: number } = {},
  now = new Date(),
): { companies: InboxCompany[]; next: string | null; count?: number } {
  ensureScored();
  const f = search(q, now);
  const from = Number(decodeCursor(o.cursor)?.n ?? 0);
  const ids =
    o.only !== undefined ? f.companies.filter((id) => id === o.only) : f.companies.slice(from, from + PAGE);
  if (!ids.length) return { companies: [], next: null, ...(from ? {} : { count: f.companies.length }) };
  const rows = open()
    .query(`SELECT * FROM companies WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as Company[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const companies = describe(
    ids.flatMap((id) =>
      byId.has(id)
        ? [{ ...byId.get(id)!, n: 0, at: byId.get(id)!.last_signal_at ?? byId.get(id)!.created_at }]
        : [],
    ),
    now,
  ).map((c) => ({
    ...c,
    hits: f.titles.get(c.id) ?? [],
    hitRoles: f.roles.get(c.id)?.length ?? 0,
    hitFits: f.fits.get(c.id) ?? 0,
    dismissed: !!byId.get(c.id)?.dismissed_at,
  }));
  const more = o.only === undefined && from + PAGE < f.companies.length;
  return {
    companies,
    next: more ? encodeCursor({ at: "", id: 0, n: from + PAGE }) : null,
    ...(from || o.only !== undefined ? {} : { count: f.companies.length }),
  };
}

/** The companies with an open role that fits in this city: each role's location read on its own. */
export function inCity(metro: string): number[] {
  const filters = loadFilters();
  const words = filters.metros?.[metro];
  if (!Array.isArray(words)) return [];
  const us = usPlaces(filters);
  const rows = open()
    .query(
      "SELECT DISTINCT company_id, location FROM roles WHERE closed_at IS NULL AND fits = 1 AND location != ''",
    )
    .all() as { company_id: number; location: string }[];
  return [...new Set(rows.filter((r) => inMetro(r.location, words, us)).map((r) => r.company_id))];
}

/** The cities the switch offers: the profile's `metros`, in its order. */
export const inboxMetros = (): string[] => Object.keys(loadFilters().metros ?? {});

/** A city the profile has, else null: one saved in the browser that it no longer has means every city. */
export const knownMetro = (metro: string | null): string | null =>
  metro && inboxMetros().includes(metro) ? metro : null;

/**
 * "Everything else", below the Inbox: every company with a board that isn't in it (nor watched or
 * dismissed), to browse when nothing is new. The most open roles that fit first, then by name.
 */
export function othersPage(
  q: InboxQuery = {},
  now = new Date(),
): { companies: InboxCompany[]; next: string | null; count?: number } {
  ensureScored();
  const after = decodeCursor(q.cursor);
  const rows = open()
    .query(
      `${others(q)}
       SELECT *${after ? "" : ", count(*) OVER () AS total"} FROM other
       ${after ? "WHERE n < $n OR (n = $n AND (sort, id) > ($at, $id))" : ""}
       ORDER BY n DESC, sort, id LIMIT $limit`,
    )
    .all({
      ...binds(q, now),
      limit: PAGE + 1,
      ...(after ? { n: after.n ?? 0, at: after.at, id: after.id } : {}),
    }) as (Company & { n: number; at: string; held: number; sort: string; total?: number })[];
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    companies: describe(page, now),
    next: rows.length > PAGE && last ? encodeCursor({ at: last.sort, id: last.id, n: last.n }) : null,
    ...(after ? {} : { count: rows[0]?.total ?? 0 }), // as inboxPage's
  };
}

export function othersCount(q: InboxQuery = {}, now = new Date()): number {
  ensureScored();
  const r = open()
    .query(`${others(q)} SELECT count(*) AS n FROM other`)
    .get(binds(q, now)) as { n: number };
  return r.n;
}

/**
 * The companies "Everything else" lists, as the CTE `other`: a board, and not in the Inbox's `page`
 * (unfiltered, so a company is in one list or the other). `remote` and `metro` as in the Inbox.
 */
const others = (q: InboxQuery) =>
  `${listed({})}, held AS (
     SELECT company_id, sum(fits) AS n, count(*) AS held FROM roles
     WHERE closed_at IS NULL ${q.remote ? "AND mode = 'remote'" : ""}
     GROUP BY company_id
   ), other AS (
     SELECT c.*, coalesce(held.n, 0) AS n, coalesce(held.held, 0) AS held, '' AS at, lower(c.name) AS sort
     FROM companies c
     LEFT JOIN held ON held.company_id = c.id
     WHERE c.watched_at IS NULL AND c.dismissed_at IS NULL
       AND EXISTS (SELECT 1 FROM boards b WHERE b.company_id = c.id)
       AND c.id NOT IN (SELECT id FROM page)
       ${q.only !== undefined ? "AND c.id = $only" : ""}
       ${q.remote ? "AND held.held IS NOT NULL" : ""}
       ${q.metro ? "AND c.id IN (SELECT value FROM json_each($metro))" : ""}
   )`;

/** One company as "Everything else" shows it, or null when it isn't there. */
export function otherCompany(id: number, q: Omit<InboxQuery, "only" | "cursor"> = {}, now = new Date()) {
  return othersPage({ ...q, only: id }, now).companies[0] ?? null;
}

/** One company as the Inbox shows it, or null when it isn't in the Inbox (after Dismiss, Watch). */
export function inboxCompany(id: number, q: Omit<InboxQuery, "only" | "cursor"> = {}, now = new Date()) {
  return inboxPage({ ...q, only: id }, now).companies[0] ?? null;
}

/** The sources a page's switch offers: those of companies in the Inbox. */
export function inboxSources(now = new Date()): { source: string; tag: string }[] {
  return open()
    .query(
      `SELECT s.source, max(s.source_tag) AS tag FROM signals s JOIN companies c ON c.id = s.company_id
       WHERE c.watched_at IS NULL AND c.dismissed_at IS NULL AND s.received_at >= $cutoff
         AND ${afterDecided}
         AND EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.closed_at IS NULL AND r.fits = 1)
       GROUP BY s.source ORDER BY tag`,
    )
    .all({ cutoff: cutoff(now) }) as { source: string; tag: string }[];
}

/** The page's boards and signals: two queries for the 50 companies, not one per row. */
function describe(rows: (Company & { n: number; at: string; held?: number })[], now: Date): InboxCompany[] {
  if (!rows.length) return [];
  const d = open();
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const boards = d
    .query(
      `SELECT company_id, url, provider, status, partial FROM boards WHERE company_id IN (${marks})
         AND status <> 'retired' ORDER BY status = 'ok' DESC, id`,
    )
    .all(...ids) as { company_id: number; url: string; provider: string; status: string; partial: number }[];
  const signals = d
    .query(
      `SELECT company_id, source, source_tag, title, url, received_at FROM signals s
       WHERE company_id IN (${marks}) AND id = (
         SELECT id FROM signals t WHERE t.company_id = s.company_id AND t.source = s.source
         ORDER BY received_at DESC, id DESC LIMIT 1)
       ORDER BY received_at DESC`,
    )
    .all(...ids) as {
    company_id: number;
    source: string;
    source_tag: string;
    title: string | null;
    url: string;
    received_at: string;
  }[];
  const fit = new Map(
    (
      d
        .query(
          `SELECT company_id, count(*) AS n FROM roles WHERE company_id IN (${marks})
             AND closed_at IS NULL AND fits = 1 GROUP BY company_id`,
        )
        .all(...ids) as { company_id: number; n: number }[]
    ).map((r) => [r.company_id, r.n]),
  );
  // A watched company's roles that are new by a person's measure: first seen this week, after the watch.
  const watched = rows.filter((r) => r.watched_at).map((r) => r.id);
  const week = new Map(
    watched.length
      ? (
          d
            .query(
              `SELECT r.company_id, count(*) AS n FROM roles r JOIN companies c ON c.id = r.company_id
               WHERE r.company_id IN (${watched.join(",")}) AND r.state = 'new' AND r.fits = 1
                 AND r.closed_at IS NULL AND ${cameAt("r.")} >= ? AND ${sinceWatched(cameAt("r."), "c.watched_at")}
               GROUP BY r.company_id`,
            )
            .all(new Date(now.getTime() - WEEK_DAYS * DAY).toISOString()) as {
            company_id: number;
            n: number;
          }[]
        ).map((r) => [r.company_id, r.n])
      : [],
  );
  return rows.map((c) => {
    const b = boards.find((x) => x.company_id === c.id);
    const f = fundingOf(c);
    return {
      id: c.id,
      name: c.name,
      domain: c.domain,
      at: c.at,
      roles: c.n,
      fit: fit.get(c.id) ?? 0,
      watched: !!c.watched_at,
      week: week.get(c.id) ?? 0,
      partial: boards.some((x) => x.company_id === c.id && x.partial === 1),
      board: b ? { url: b.url, provider: b.provider, status: b.status } : null,
      link: ownPage(c) ?? b?.url ?? null,
      discovery: c.discovery,
      careers_url: c.careers_url,
      email: applyEmailOf(c)?.address ?? null,
      funding: f ? { date: f.date, url: f.url } : null,
      signals: signals
        .filter((s) => s.company_id === c.id)
        .map((s) => ({ source: s.source, tag: s.source_tag, title: s.title, url: s.url, at: s.received_at })),
      ...(c.held !== undefined ? { held: c.held } : {}),
    };
  });
}

export type RoleView = {
  id: number;
  title: string;
  location: string;
  place: string;
  mode: string;
  url: string;
  posted_at: string | null;
  first_seen: string;
  at: string; // what the list sorts by: posted_at, else first_seen (never after first_seen)
  reposted: string | null;
  matched: string | null;
  fits: boolean;
  near: boolean; // doesn't fit, but has your title words: only its place or how it's worked missed
  why: string | null; // why it doesn't fit, in plain words
  state: string;
  closed: boolean;
};

/**
 * A company's roles, a page at a time, those that fit first, then the newest posted: a role with
 * no posting date by when it was first seen, and a posting date after that (a board that re-dates
 * its roles) by first seen too. `view`: "inbox", the new ones that fit (what the Inbox
 * counts); "fit", every open role that fits, whatever you did with it (the Watchlist's company page);
 * "all", every open role, those that fit first, then near misses ("Everything else", Signals).
 * `found`: the search box's (search.ts), only the roles it found here, in any state, those that
 * fit first, then those with the words together.
 */
export function companyRoles(
  companyId: number,
  o: { view?: "inbox" | "fit" | "all"; cursor?: string | null; remote?: boolean; found?: Found | null } = {},
  now = new Date(),
): { roles: RoleView[]; next: string | null; held: number } {
  const d = open();
  const after = decodeCursor(o.cursor);
  const found = o.found ? (o.found.roles.get(companyId) ?? []) : null;
  const view = found ? "all" : (o.view ?? "inbox");
  // Second in the order: a near miss; with a search, the words together.
  const near = found
    ? "(id IN (SELECT value FROM json_each($together)))"
    : "(fits = 0 AND matched IS NOT NULL)";
  const rows = d
    .query(
      `SELECT id, title, location, mode, url, posted_at, first_seen, reposted, matched, fits, state, closed_at,
         min(coalesce(posted_at, first_seen), first_seen) AS at, ${near} AS near
       FROM roles WHERE company_id = $company AND closed_at IS NULL
         ${view !== "all" ? "AND fits = 1" : ""}
         ${found ? "AND id IN (SELECT value FROM json_each($found))" : ""}
         ${
           view === "inbox" && !found
             ? `AND state = 'new' AND ${cameAt()} >= $cutoff
                AND ${sinceWatched(cameAt(), "(SELECT watched_at FROM companies WHERE id = $company)")}`
             : ""
         }
         ${o.remote && !found ? "AND mode = 'remote'" : ""}
         ${
           after
             ? `AND (fits, ${near}, min(coalesce(posted_at, first_seen), first_seen), id)
                  < ($fits, $near, $at, $id)`
             : ""
         }
       ORDER BY fits DESC, near DESC, at DESC, id DESC LIMIT $limit`,
    )
    .all({
      company: companyId,
      limit: PAGE + 1,
      ...(view === "inbox" && !found ? { cutoff: cutoff(now) } : {}),
      ...(found
        ? {
            found: JSON.stringify(found),
            together: JSON.stringify(found.filter((id) => o.found!.together.has(id))),
          }
        : {}),
      ...(after ? { fits: after.n ?? 1, near: after.m ?? 0, at: after.at, id: after.id } : {}),
    }) as (Omit<RoleView, "place" | "fits" | "near" | "why" | "closed"> & {
    fits: number;
    near: number;
    closed_at: string | null;
  })[];
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  const held = (
    d.query("SELECT count(*) AS n FROM roles WHERE company_id = ? AND closed_at IS NULL").get(companyId) as {
      n: number;
    }
  ).n;
  const filters = page.some((r) => !r.fits) ? loadFilters() : null;
  return {
    roles: page.map(({ closed_at, fits, near, ...r }) => ({
      ...r,
      place: workMode({ title: r.title, location: r.location }).place,
      fits: fits === 1,
      near: !found && near === 1,
      why: filters && !fits ? missed(r, filters, { place: false }) : null,
      closed: !!closed_at,
    })),
    next:
      rows.length > PAGE && last
        ? encodeCursor({ at: last.at, id: last.id, n: last.fits, m: last.near })
        : null,
    held,
  };
}

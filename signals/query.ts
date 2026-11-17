// The Signals screen's read path: every company a signal named that has nothing open that fits you
// (so it is never in the Inbox), why, and what can be done, in three groups by the useful action:
//   hiring   its board lists open roles, none that fit: near misses (your title words, not your
//            place) are listed; a company hiring only for other kinds of work is folded
//   posted   nothing posted: a board with no open roles, a careers page read and empty, no board
//            found, or one still being looked for: Work is the way in
//   unread   it has a careers page or board the app couldn't read: its link, and Try again
// Noise is folded, never deleted: no signal on record, a fund with nothing open, a name that names
// no company, no website known, a website that doesn't answer. One staged table per screenful of
// questions (a few indexed scans over companies), then each list is a page of it; a page's rows are
// described with three queries for the page, never one per row.
import { loadFilters, missed } from "../ats/filters.ts";
import { DAY, getMeta, open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { namesFound, prefixMatch, words } from "../inbox/search.ts";
import { applyEmailOf, companyOfThread, fundingOf, isStandIn } from "../intake/companies.ts";
import { ensureScored } from "../intake/refresh.ts";
import { isReading, plainNote } from "../sources/pipeline.ts";

export const SIGNAL_DAYS = 90; // the default list: a company whose latest signal reached you this recently
export const PAGE = 30;

export const VIEWS = ["hiring", "other", "posted", "unread", "older", "noise", "hidden"] as const;
export type View = (typeof VIEWS)[number];
export type Group = "hiring" | "posted" | "unread";
export type Noise = "nosignal" | "noname" | "fund" | "nosite" | "dead";

export type SignalLine = {
  source: string;
  tag: string;
  kind: string | null; // posting (a role's own page), post, ...
  at: string;
  title: string | null;
  text: string | null; // the start of what it said
  url: string | null;
};
export type SignalsCompany = {
  id: number;
  name: string;
  domain: string | null;
  at: string | null; // its latest signal, received
  group: Group | null; // null: noise
  noise: Noise | null;
  why: string; // why it's here, in plain words
  held: number; // open roles
  near: number; // of those, near misses: your title words, not your place
  nearRole: { title: string; why: string } | null; // the newest near miss
  board: { url: string; provider: string; status: string } | null;
  careers_url: string | null;
  note: string | null; // what the last look for its board found, where it says more than `why`
  email: string | null;
  funding: { date: string; url: string } | null;
  signal: SignalLine | null; // the newest
  signals: number; // how many signals named it
  hidden: boolean;
  reading: boolean; // a careers page or board you gave is being read now
};

// A careers page the model read and couldn't read the roles of, said in its own words: a sign-in
// or a bot check in the way, roles only behind a link or a widget, counts with no titles (Deel).
const UNREAD_NOTES = [
  "access denied",
  "access-denied",
  "access restriction",
  "blocked",
  "security check",
  "checkpoint",
  "cloudflare",
  "login page",
  "sign-in",
  "passphrase",
  "gated",
  "could not be read",
  "couldn't be read",
  "could not be identified",
  "only links to",
  "it links to the jobs page",
  "loading positions",
  "job widget",
  "department names",
  "category links",
  "not shown on the page",
  "no visible text",
];
const like = (col: string, words: string[]) =>
  words.map((w) => `lower(${col}) LIKE '%${w.replace(/'/g, "''")}%'`).join(" OR ");

// A fund named as a company: conservative, by the words a fund's name or website ends in, and only
// with nothing open (a fund hiring for itself is hiring: Khosla Ventures' own board).
const FUND = `(lower(c.name) GLOB '* ventures' OR lower(c.name) GLOB '* venture partners'
  OR lower(c.name) GLOB '* capital' OR c.domain GLOB '*.vc' OR c.domain GLOB '*.capital'
  OR c.domain GLOB '*.ventures' OR c.domain GLOB '*.fund')`;
// A name that names no company ("Location: REMOTE (anywhere)", "*Confidential Healthcare AI Startup").
// A name may start with any letter (Émile, Ōura, 小米): only one starting with a mark (*, (, -, •, “)
// or ending a phrase with a colon ("Location: …", "Re:Build" is a name) names nothing.
const NONAME = `(c.name GLOB '*: *' OR c.name GLOB '*:'
  OR (unicode(c.name) < 128 AND c.name GLOB '[^A-Za-z0-9]*') OR unicode(c.name) BETWEEN 8208 AND 8231
  OR lower(c.name) GLOB '*confidential*' OR lower(c.name) GLOB '*stealth*' OR lower(c.name) GLOB '*undisclosed*')`;
// Its website answers nothing at all (runner.mjs siteProblem): an expired certificate, a dead domain.
const DEAD = `(c.discovery_note LIKE 'certificate expired%' OR c.discovery_note LIKE 'certificate not valid%'
  OR c.discovery_note LIKE 'domain doesn''t resolve%')`;
// A careers page or board it has that couldn't be read.
const UNREAD = `(c.discovery IN ('unreadable', 'blocked') OR (any_board AND NOT ok_board)
  OR c.discovery_note LIKE '%didn''t load%' OR c.discovery_note LIKE '%timed out%'
  OR c.discovery_note LIKE 'its roles are on %' OR c.discovery_note LIKE 'its careers site''s board can''t be read%'
  OR (c.discovery_note LIKE 'its careers page, checked:%' AND (${like("c.discovery_note", UNREAD_NOTES)})))`;

/**
 * The companies the screen knows about, one row each with its group (or noise), as a temporary
 * table: made again when older than 2 seconds or after a change here. Listed: not dismissed, not
 * watched, no thread (or a signal newer than all its thread holds: a past application's company
 * named again), and no open role that fits (one that does is the Inbox's, or "Everything
 * else"'s). Hidden ones are kept, marked, for their own fold.
 */
const STAGED = `
  WITH sig AS (
    SELECT company_id, max(received_at) AS last, max(coalesce(arrived_at, received_at)) AS arrived,
      count(*) AS n FROM signals
    WHERE company_id IS NOT NULL GROUP BY company_id
  ), base AS (
    SELECT c.*, sig.last AS at, sig.arrived, coalesce(sig.n, 0) AS signal_n,
      (SELECT count(*) FROM roles r WHERE r.company_id = c.id AND r.closed_at IS NULL) AS held,
      (SELECT count(*) FROM roles r WHERE r.company_id = c.id AND r.closed_at IS NULL AND r.fits = 0
         AND r.matched IS NOT NULL) AS near,
      EXISTS (SELECT 1 FROM boards b WHERE b.company_id = c.id AND b.status = 'ok') AS ok_board,
      EXISTS (SELECT 1 FROM boards b WHERE b.company_id = c.id AND b.status <> 'retired') AS any_board,
      EXISTS (SELECT 1 FROM signals s WHERE s.company_id = c.id AND s.source = 'hn') AS hn,
      EXISTS (SELECT 1 FROM boards b WHERE b.company_id = c.id AND b.status = 'ok' AND b.last_read_at IS NULL) AS unread_board
    FROM companies c LEFT JOIN sig ON sig.company_id = c.id
    WHERE c.dismissed_at IS NULL AND c.watched_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each($threads) t WHERE t.value ->> '$[0]' = c.id
        AND (sig.last IS NULL OR sig.last <= t.value ->> '$[1]'))
      AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.closed_at IS NULL AND r.fits = 1)
  )
  SELECT c.*, CASE
      WHEN c.at IS NULL THEN 'nosignal'
      WHEN ${NONAME} AND NOT c.held THEN 'noname'
      WHEN c.held > 0 THEN 'hiring'
      WHEN ${FUND} THEN 'fund'
      WHEN c.ok_board THEN 'posted'
      -- No website: noise, unless HN's hiring thread named it (always a company hiring).
      WHEN c.domain IS NULL AND NOT c.hn THEN 'nosite'
      WHEN ${DEAD} THEN 'dead'
      WHEN ${UNREAD} THEN 'unread'
      ELSE 'posted' END AS grp,
    CASE WHEN c.near > 0 THEN 0 ELSE 1 END AS tier,
    -- Newest first by when its latest signal reached you, then by that post's own date.
    coalesce(c.arrived, c.created_at) || coalesce(c.at, '') AS k
  FROM base c`;

let stagedAt = 0;
let stagedDb: unknown = null;
let stagedMark: string | null = null;
function stage(): void {
  const d = open();
  // Roles scored against your filters as they are now (an edit in Settings) before they're grouped.
  const rescored = ensureScored() > 0;
  // Made again after 2 seconds, or at once when intake changed something since (a read, a signal):
  // a list asked for just after a change never gets the table from before it.
  const mark = getMeta("intake_changed_at");
  if (!rescored && stagedDb === d && mark === stagedMark && Date.now() - stagedAt < 2000) return;
  d.exec("DROP TABLE IF EXISTS temp.named");
  d.query(`CREATE TEMP TABLE named AS ${STAGED}`).run({
    threads: JSON.stringify(threadCompanies()),
  });
  stagedAt = Date.now();
  stagedDb = d;
  stagedMark = mark;
}
/** After a change (Hide, a choice): the next question stages again. */
export const restage = () => {
  stagedAt = 0;
};

/**
 * The companies that have a thread, each with the thread's last activity: by the thread's domain
 * (or one it had), or its stand-in's name.
 */
function threadCompanies(): [number, string][] {
  const threads = index.all();
  const last = new Map(threads.map((s) => [s.id, s.lastTs]));
  const domains = threads.map((s) => s.id).filter((id) => !isStandIn(id));
  const found = domains.length
    ? (open()
        .query(
          `SELECT id, domain AS thread FROM companies WHERE domain IN (SELECT value FROM json_each($d))
           UNION SELECT company_id, substr(name_key, 2) FROM company_names
           WHERE name_key IN (SELECT '@' || value FROM json_each($d))`,
        )
        .all({ d: JSON.stringify(domains) }) as { id: number; thread: string }[])
    : [];
  const standIns = threads
    .filter((s) => isStandIn(s.id))
    .flatMap((s) => {
      const c = companyOfThread(s.id);
      return c ? [{ id: c.id, thread: s.id }] : [];
    });
  return [...found, ...standIns].map((r) => [r.id, last.get(r.thread) ?? ""]);
}

export type SignalsQuery = {
  view: View;
  cursor?: string | null;
  source?: string | null;
  q?: string | null;
  only?: number;
};

const cut = (now: Date) => new Date(now.getTime() - SIGNAL_DAYS * DAY).toISOString();
const NOISE = "grp IN ('nosignal', 'noname', 'fund', 'nosite', 'dead')";

/** Which staged rows a view lists, as SQL over `named`. */
function where(q: SignalsQuery): string {
  // Recent by when the signal reached you, not the post's date (a bookmark of an old post).
  const recent = "arrived >= $cut";
  const parts = [
    q.view === "hidden" ? "hidden_at IS NOT NULL" : "hidden_at IS NULL",
    {
      hiring: `grp = 'hiring' AND tier = 0 AND ${recent}`,
      other: `grp = 'hiring' AND tier = 1 AND ${recent}`,
      posted: `grp = 'posted' AND ${recent}`,
      unread: `grp = 'unread' AND ${recent}`,
      older: `grp IN ('hiring', 'posted', 'unread') AND arrived < $cut`,
      noise: NOISE,
      hidden: "1",
    }[q.view],
  ];
  if (q.only !== undefined) parts.push("id = $only");
  if (q.source)
    parts.push("EXISTS (SELECT 1 FROM signals s WHERE s.company_id = named.id AND s.source = $source)");
  if (q.q) parts.push("id IN (SELECT value FROM json_each($hits))");
  return parts.join(" AND ");
}

type Cursor = { k: string; id: number };
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString()) as Cursor;
    return typeof c.k === "string" && Number.isInteger(c.id) ? c : null;
  } catch {
    return null;
  }
}

/** The companies the search box's words find: by name, or by what a signal naming them said. */
function hits(q: string): number[] {
  const tokens = words(q);
  if (!tokens.length) return [];
  const byName = namesFound(q);
  const rows = open()
    .query("SELECT company_id, title, text FROM signals WHERE company_id IS NOT NULL")
    .all() as { company_id: number; title: string | null; text: string | null }[];
  for (const r of rows)
    if (!byName.has(r.company_id) && prefixMatch(words(`${r.title ?? ""} ${r.text ?? ""}`), tokens))
      byName.add(r.company_id);
  return [...byName];
}

type Row = Record<string, unknown> & {
  id: number;
  name: string;
  domain: string | null;
  at: string | null;
  k: string;
  grp: string;
  tier: number;
  held: number;
  near: number;
  ok_board: number;
  unread_board: number;
  signal_n: number;
  discovery: string | null;
  discovery_note: string | null;
  careers_url: string | null;
  apply_email: string | null;
  funding: string | null;
  hidden_at: string | null;
};

/** One page of a view, newest signal first. */
export function signalsPage(
  q: SignalsQuery,
  now = new Date(),
): { companies: SignalsCompany[]; next: string | null; count?: number } {
  stage();
  const after = decode(q.cursor);
  const text = q.q?.trim() ?? "";
  const binds = {
    cut: cut(now),
    ...(q.only !== undefined ? { only: q.only } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(text ? { hits: JSON.stringify(hits(text)) } : {}),
  };
  const rows = open()
    .query(
      `SELECT *${after ? "" : ", count(*) OVER () AS total"} FROM named
       WHERE ${where({ ...q, q: text })} ${after ? "AND (k < $k OR (k = $k AND id < $id))" : ""}
       ORDER BY k DESC, id DESC LIMIT $limit`,
    )
    .all({ ...binds, limit: PAGE + 1, ...(after ? { k: after.k, id: after.id } : {}) }) as (Row & {
    total?: number;
  })[];
  const page = rows.slice(0, PAGE);
  const last = page.at(-1);
  return {
    companies: describe(page),
    next: rows.length > PAGE && last ? encode({ k: last.k, id: last.id }) : null,
    ...(after ? {} : { count: rows[0]?.total ?? 0 }),
  };
}

/** One company as a view lists it, or null when it isn't in that view any more. */
export function signalsCompany(id: number, q: Omit<SignalsQuery, "only" | "cursor">, now = new Date()) {
  return signalsPage({ ...q, only: id }, now).companies[0] ?? null;
}

/** How many companies each view lists, and the sources a filter offers. */
export function signalsSummary(
  o: { source?: string | null; q?: string | null } = {},
  now = new Date(),
): { counts: Record<View, number>; sources: { source: string; tag: string }[] } {
  stage();
  const text = o.q?.trim() ?? "";
  const binds = {
    cut: cut(now),
    ...(o.source ? { source: o.source } : {}),
    ...(text ? { hits: JSON.stringify(hits(text)) } : {}),
  };
  const counts = Object.fromEntries(
    VIEWS.map((view) => [
      view,
      (
        open()
          .query(`SELECT count(*) AS n FROM named WHERE ${where({ view, source: o.source, q: text })}`)
          .get(binds) as { n: number }
      ).n,
    ]),
  ) as Record<View, number>;
  const sources = open()
    .query(
      `SELECT s.source, max(s.source_tag) AS tag FROM signals s
       WHERE s.company_id IN (SELECT id FROM named WHERE hidden_at IS NULL AND NOT (${NOISE}))
       GROUP BY s.source ORDER BY tag`,
    )
    .all() as { source: string; tag: string }[];
  return { counts, sources };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Why a company is here, in plain words. */
function whyOf(r: Row): string {
  const note = r.discovery_note ?? "";
  switch (r.grp) {
    case "nosignal":
      return "no signal on record: it came in another way (an import, a list)";
    case "noname":
      return "the name names no company";
    case "fund":
      return "a fund, not a company hiring";
    case "nosite":
      return "no website known";
    case "dead":
      return "its website doesn't answer";
    case "hiring":
      if (r.near)
        return `${plural(r.held, "open role")}, none fit you · ${plural(r.near, "near miss", "near misses")}`;
      return `${plural(r.held, "open role")}, none with your title words`;
    case "unread":
      if (r.discovery === "blocked" || /robots/.test(note))
        return "its site asks apps like this one not to read it";
      if (r.discovery === "unreadable" || /no reader here reads|can't be read/.test(note))
        return "its roles are on a site the app can't read";
      if (note.startsWith("its careers page, checked:")) return "its careers page couldn't be read";
      if (/didn't load|timed out/.test(note)) return "its careers page wouldn't load";
      return "its job board was found, but stopped working";
    default:
      if (!r.domain) return "no website known yet: Work looks for it first";
      if (r.ok_board)
        return r.unread_board ? "its board isn't read yet" : "its board lists no open roles right now";
      if (r.discovery === "queued" || r.discovery === null) return "looking for its board now";
      if (note.startsWith("its careers page, checked:")) return "its careers page lists no openings";
      return "no careers page or job board found";
  }
}

/** The page's signals, boards and near misses: three queries for the page, not one per row. */
function describe(rows: Row[]): SignalsCompany[] {
  if (!rows.length) return [];
  const d = open();
  const ids = JSON.stringify(rows.map((r) => r.id));
  const signals = d
    .query(
      `SELECT company_id, source, source_tag, kind, title, text, url, received_at FROM signals s
       WHERE company_id IN (SELECT value FROM json_each($ids)) AND id = (
         SELECT id FROM signals t WHERE t.company_id = s.company_id ORDER BY received_at DESC, id DESC LIMIT 1)`,
    )
    .all({ ids }) as {
    company_id: number;
    source: string;
    source_tag: string;
    kind: string | null;
    title: string | null;
    text: string | null;
    url: string;
    received_at: string;
  }[];
  const boards = d
    .query(
      `SELECT company_id, url, provider, status FROM boards WHERE company_id IN (SELECT value FROM json_each($ids))
         AND status <> 'retired' ORDER BY status = 'ok' DESC, id`,
    )
    .all({ ids }) as { company_id: number; url: string; provider: string; status: string }[];
  const near = d
    .query(
      `SELECT company_id, title, location FROM roles r
       WHERE company_id IN (SELECT value FROM json_each($ids)) AND id = (
         SELECT id FROM roles x WHERE x.company_id = r.company_id AND x.closed_at IS NULL AND x.fits = 0
           AND x.matched IS NOT NULL ORDER BY coalesce(x.posted_at, x.first_seen) DESC, x.id DESC LIMIT 1)`,
    )
    .all({ ids }) as { company_id: number; title: string; location: string }[];
  const filters = loadFilters();
  const http = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
  return rows.map((r) => {
    const s = signals.find((x) => x.company_id === r.id);
    const b = boards.find((x) => x.company_id === r.id);
    const n = near.find((x) => x.company_id === r.id);
    const f = fundingOf(r);
    const noisy = ["nosignal", "noname", "fund", "nosite", "dead"].includes(r.grp);
    const why = whyOf(r);
    // The model's own words on the careers page it read, where they say more than the reason.
    const said = r.discovery_note?.match(/^its careers page, checked:\s*([^·]+)/i)?.[1]?.trim();
    // A board found, or given by hand, that another company here already has (discover.ts addBoard).
    const taken = r.discovery_note?.match(/^[\w ]+: (https?:\/\/\S+) is (.+)'s board$/);
    const note = said
      ? (plainNote(said) ?? "").slice(0, 220)
      : taken
        ? `${taken[1]} is the board of another company in your list, ${taken[2]}`
        : null;
    // Where its roles are, when the look named a site it couldn't read.
    const rolesAt = http(r.discovery_note?.match(/(?:its roles are on|board at) (https?:\/\/[^\s,]+)/)?.[1]);
    return {
      id: r.id,
      name: r.name,
      domain: r.domain,
      at: r.at,
      group: noisy ? null : (r.grp as Group),
      noise: noisy ? (r.grp as Noise) : null,
      why,
      held: r.held,
      near: r.near,
      nearRole: n ? { title: n.title, why: missed(n, filters) ?? "" } : null,
      board: b ? { url: b.url, provider: b.provider, status: b.status } : null,
      careers_url: rolesAt ?? http(r.careers_url),
      note: r.grp === "unread" || (r.grp === "posted" && !r.ok_board) ? note : null,
      email: applyEmailOf(r)?.address ?? null,
      funding: f ? { date: f.date, url: f.url } : null,
      signal: s
        ? {
            source: s.source,
            tag: s.source_tag,
            kind: s.kind,
            at: s.received_at,
            title: s.title?.trim() || null,
            text: s.text ? s.text.replace(/\s+/g, " ").trim().slice(0, 200) : null,
            url: http(s.url),
          }
        : null,
      signals: r.signal_n,
      hidden: !!r.hidden_at,
      reading: isReading(r.id),
    };
  });
}

/** Hide: out of this list only. Unhide puts it back. */
export function hideCompany(id: number, hide: boolean, now = new Date()): boolean {
  const changed =
    open()
      .query(
        hide
          ? "UPDATE companies SET hidden_at = $now WHERE id = $id AND hidden_at IS NULL"
          : "UPDATE companies SET hidden_at = NULL WHERE id = $id AND hidden_at IS NOT NULL",
      )
      .run(hide ? { id, now: now.toISOString() } : { id }).changes > 0;
  restage();
  return changed;
}

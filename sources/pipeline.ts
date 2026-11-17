// The Sources screen's numbers: how a signal becomes roles, in five steps (Signal in → Company
// named → Website proven → Board found → Roles read), each company counted once, at the furthest
// step it reached, so every number is one count over the companies table and they add up. What
// stopped at each step, why, and the retries that replace one-off batch scripts: one item, or all
// of a reason at once, lined up for the tick, with progress and a Stop.
import { isLinkedIn } from "../apply/linkedin.ts";
import { atsRoot } from "../ats/reader.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, getMeta, markChanged, open, setMeta, tx } from "../core/db.ts";
import { backgroundLeft, canUseSmallModel, connection, DayLimit, NO_MODEL, OverCap } from "../core/model.ts";
import { modelCost } from "../core/prices.ts";
import { PARKED, parkAgain, unpark } from "../dropfolder/backlog.ts";
import { ANSWERED, COMPANY_UNKNOWN, classifyOne, SET_ASIDE, SYSTEM } from "../intake/classify.ts";
import { dismissCompany, getCompany, placeSignal, type Signal, signalsOf } from "../intake/companies.ts";
import { discover, giveDomain } from "../intake/discover.ts";
import { siteDomain } from "../intake/leads.ts";
import { BY_HAND } from "../intake/refresh.ts";

export const STEPS = ["signal", "named", "website", "board", "roles"] as const;
export type Step = (typeof STEPS)[number];

// Each source by one name everywhere (its tile, the map, the lists), by the key its signals
// carry. Job mail took over LinkedIn alerts and Grok mail: their signals count under it.
export const SOURCE_NAMES: Record<string, string> = {
  x: "X bookmarks",
  hn: "Hacker News",
  "job-mail": "Job mail",
  "board-search": "Board search",
  "form-d": "Funding filings",
  funds: "Fund portals",
  feeds: "Feeds",
  "github-stars": "GitHub stars",
  drop: "Files",
  hand: "Added by hand",
};
const DOOR: Record<string, string> = { linkedin: "job-mail", grok: "job-mail" };
// A post keeps where it came from inside its source.
const WITHIN: Record<string, string> = { linkedin: "Job mail (LinkedIn alert)", grok: "Job mail (Grok)" };
/** The source a signal's key counts under, in SQL. */
const door = (col: string) =>
  `CASE ${col} ${Object.entries(DOOR)
    .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
    .join(" ")} ELSE ${col} END`;
export const sourceName = (k: string) => SOURCE_NAMES[k] ?? WITHIN[k] ?? k;

// Each company with the step it reached and the source of its first signal ("hand": none), as a
// temporary table for one screen's worth of questions: made again when older than 2 seconds.
const STAGED = `
  WITH open_roles AS (SELECT DISTINCT company_id FROM roles WHERE closed_at IS NULL),
  ok_boards AS (SELECT DISTINCT company_id FROM boards WHERE status = 'ok'),
  first_src AS (
    SELECT company_id, source FROM (
      SELECT company_id, ${door("source")} AS source, row_number() OVER (PARTITION BY company_id ORDER BY received_at, id) AS n
      FROM signals WHERE company_id IS NOT NULL) WHERE n = 1)
  SELECT c.*, coalesce(f.source, 'hand') AS src,
    CASE WHEN o.company_id IS NOT NULL THEN 5 WHEN b.company_id IS NOT NULL THEN 4
         WHEN c.domain IS NOT NULL THEN 3 ELSE 2 END AS stage
  FROM companies c
  LEFT JOIN open_roles o ON o.company_id = c.id
  LEFT JOIN ok_boards b ON b.company_id = c.id
  LEFT JOIN first_src f ON f.company_id = c.id
  WHERE c.dismissed_at IS NULL`;
let stagedAt = 0;
let stagedDb: unknown = null;
function restage(): void {
  const d = open();
  if (stagedDb === d && Date.now() - stagedAt < 2000) return;
  d.exec(`DROP TABLE IF EXISTS temp.staged; CREATE TEMP TABLE staged AS ${STAGED}`);
  stagedAt = Date.now();
  stagedDb = d;
}
/** After a change: the next question stages again. */
const changedNow = () => {
  stagedAt = 0;
};

export type Funnel = {
  signals: number;
  named: number;
  website: number;
  board: number;
  roles: number;
  openRoles: number;
  bySource: Record<string, { signals: number; named: number; website: number; board: number; roles: number }>;
  stopped: Record<Step, number>;
  // Steps 1 and 2 by source: what the map shows while following one.
  stoppedBy: Record<string, { signal: number; named: number }>;
};

/** The five steps' counts, all sources and each one. */
export function funnel(): Funnel {
  restage();
  const d = open();
  const rows = d
    .query(
      `SELECT src, count(*) AS named, sum(stage >= 3) AS website, sum(stage >= 4) AS board,
         sum(stage >= 5) AS roles FROM staged GROUP BY src`,
    )
    .all() as { src: string; named: number; website: number; board: number; roles: number }[];
  const sigs = d.query(`SELECT ${door("source")} AS source, count(*) AS n FROM signals GROUP BY 1`).all() as {
    source: string;
    n: number;
  }[];
  const bySource: Funnel["bySource"] = {};
  for (const s of sigs) bySource[s.source] = { signals: s.n, named: 0, website: 0, board: 0, roles: 0 };
  for (const r of rows)
    bySource[r.src] = {
      signals: bySource[r.src]?.signals ?? 0,
      named: r.named,
      website: r.website,
      board: r.board,
      roles: r.roles,
    };
  const sum = (k: "signals" | "named" | "website" | "board" | "roles") =>
    Object.values(bySource).reduce((a, s) => a + s[k], 0);
  const stopped = Object.fromEntries(
    STEPS.map((s) => [s, reasons(s).reduce((a, r) => a + r.n, 0)]),
  ) as Record<Step, number>;
  const stoppedBy: Funnel["stoppedBy"] = {};
  for (const step of ["signal", "named"] as const) {
    const any = REASONS[step].map((r) => `(${r.where})`).join(" OR ");
    for (const r of d
      .query(
        `SELECT ${door("source")} AS source, count(*) AS n FROM signals WHERE company_id IS NULL AND (${any}) GROUP BY 1`,
      )
      .all() as { source: string; n: number }[]) {
      stoppedBy[r.source] ??= { signal: 0, named: 0 };
      stoppedBy[r.source]![step] = r.n;
    }
  }
  return {
    signals: sum("signals"),
    named: sum("named"),
    website: sum("website"),
    board: sum("board"),
    roles: sum("roles"),
    openRoles: (d.query("SELECT count(*) AS n FROM roles WHERE closed_at IS NULL").get() as { n: number }).n,
    bySource,
    stopped,
    stoppedBy,
  };
}

/** Companies a source brought (by its first signal) still waiting for their first look for a board. */
export function queuedFrom(src: string): number {
  restage();
  return (
    open().query("SELECT count(*) AS n FROM staged WHERE src = ? AND discovery = 'queued'").get(src) as {
      n: number;
    }
  ).n;
}

// What stopped at each step, by reason: a SQL condition over signals (steps 1 and 2) or over the
// staged companies that reached the step before and not this one (steps 3 to 5).
type Reason = { k: string; l: string; where: string };
const REASONS: Record<Step, Reason[]> = {
  signal: [
    {
      k: "waiting",
      l: "posts in a dropped file, waiting for you to sort them",
      where: `classify_tries = ${PARKED}`,
    },
  ],
  named: [
    { k: "nohire", l: "weren't about hiring", where: `classify_tries = ${ANSWERED}` },
    { k: "noname", l: "are about hiring but name no company", where: `classify_tries = ${COMPANY_UNKNOWN}` },
    { k: "next", l: "wait for the small model's next pass", where: "classify_tries < 2" },
    {
      k: "failed",
      l: "the small model couldn't answer, twice",
      where: `classify_tries >= 2 AND classify_tries NOT IN (${ANSWERED}, ${COMPANY_UNKNOWN}, ${PARKED}, ${SET_ASIDE})`,
    },
  ],
  website: [
    { k: "unlooked", l: "not looked for yet", where: "search_at IS NULL" },
    {
      k: "unproven",
      l: "a site was found, but nothing proves it's theirs",
      where: "search_at IS NOT NULL AND discovery_note LIKE '%no site proven%'",
    },
    {
      k: "nosite",
      l: "no website found",
      where: "search_at IS NOT NULL AND coalesce(discovery_note, '') NOT LIKE '%no site proven%'",
    },
  ],
  board: [
    { k: "queued", l: "being looked for now", where: "discovery = 'queued' OR discovery IS NULL" },
    { k: "blocked", l: "its site's robots.txt keeps readers out", where: "discovery = 'blocked'" },
    {
      k: "noopenings",
      l: "its careers page says there are no openings",
      where: "discovery IN ('none', 'unreadable') AND discovery_note LIKE 'its careers page, checked:%'",
    },
    {
      k: "noload",
      l: "its careers page wouldn't load",
      where:
        "discovery IN ('none', 'unreadable') AND (discovery_note LIKE '%didn''t load%' OR discovery_note LIKE '%timed out%')",
    },
    {
      k: "nocareers",
      l: "no careers page or job board found",
      where: `discovery IN ('none', 'unreadable') AND coalesce(discovery_note, '') NOT LIKE 'its careers page, checked:%'
        AND coalesce(discovery_note, '') NOT LIKE '%didn''t load%' AND coalesce(discovery_note, '') NOT LIKE '%timed out%'`,
    },
    // Found once, and no board of its answers now: without this the reasons wouldn't add up.
    {
      k: "broken",
      l: "its job board was found, but stopped working",
      where: "discovery NOT IN ('queued', 'blocked', 'none', 'unreadable')",
    },
  ],
  roles: [
    {
      k: "unread",
      l: "boards not read yet",
      where:
        "NOT EXISTS (SELECT 1 FROM boards b WHERE b.company_id = staged.id AND b.last_read_at IS NOT NULL)",
    },
    {
      k: "empty",
      l: "boards list no open roles right now",
      where: "EXISTS (SELECT 1 FROM boards b WHERE b.company_id = staged.id AND b.last_read_at IS NOT NULL)",
    },
  ],
};
// The same reasons said of one item, on its row.
const ONE: Record<string, string> = {
  waiting: "in a dropped file, waiting for you to sort it",
  nohire: "the small model found it isn't about hiring",
  noname: "about hiring, but it names no company",
  next: "waiting for the small model's next pass",
  failed: "the small model couldn't answer, twice",
  unlooked: "not looked for yet",
  unproven: "a site was found, but nothing proves it's theirs",
  nosite: "no website found",
  queued: "being looked for now",
  blocked: "its site's robots.txt keeps readers out",
  noopenings: "its careers page says there are no openings",
  noload: "its careers page wouldn't load",
  nocareers: "no careers page or job board found",
  broken: "its job board was found, but stopped working",
  unread: "its board isn't read yet",
  empty: "its board lists no open roles right now",
};
const AT_STEP: Record<Step, number> = { signal: 0, named: 0, website: 2, board: 3, roles: 4 };
const isSignalStep = (s: Step) => s === "signal" || s === "named";

/** A step's reasons with their counts; `src` narrows to one source. */
export function reasons(step: Step, src?: string): { k: string; l: string; n: number }[] {
  restage();
  const d = open();
  return REASONS[step].map((r) => {
    const n = isSignalStep(step)
      ? (
          d
            .query(
              `SELECT count(*) AS n FROM signals WHERE company_id IS NULL AND (${r.where})${src ? ` AND ${door("source")} = ?` : ""}`,
            )
            .get(...(src ? [src] : [])) as { n: number }
        ).n
      : (
          d
            .query(
              `SELECT count(*) AS n FROM staged WHERE stage = ${AT_STEP[step]} AND (${r.where})${src ? " AND src = ?" : ""}`,
            )
            .get(...(src ? [src] : [])) as { n: number }
        ).n;
    return { k: r.k, l: r.l, n };
  });
}

/** A signal as the screen shows it: who posted it, where, when, all of its text and its link. */
export type Post = {
  source: string;
  author: string | null;
  url: string | null; // the original, http(s) only
  kind: string | null;
  at: string | null;
  title: string | null;
  text: string;
};
export type BoardLine = {
  url: string;
  provider: string;
  broken: boolean;
  readAt: string | null;
  error: string | null;
  roles: number | null;
};
export type Item = {
  id: number;
  cursor: string; // where the next page starts after this one
  label: string; // its name, short: "Removed Acme"
  source: string;
  reason: string;
  why: string;
  at: string | null;
  waiting: string | null; // lined up to be tried again, in words
  running: boolean; // being read now
  post?: Post; // steps 1 and 2
  company?: {
    website: string | null;
    careers: string | null;
    note: string | null; // what the last look found, in plain words where it can be
    noteAt: string | null;
    signals: number;
    latest: Post | null;
    boards: BoardLine[];
  };
};

const http = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
function postOf(
  s: Pick<Signal, "source" | "author" | "url" | "kind" | "posted_at" | "received_at" | "title" | "text">,
): Post {
  return {
    source: sourceName(s.source),
    author: s.author?.trim() || null,
    url: http(s.url),
    kind: s.kind ?? null,
    at: s.posted_at || s.received_at || null,
    title: s.title?.trim() || null,
    text: (s.text ?? "").trim(),
  };
}

// The look's own words where they are a machine's: the rest of a note is already plain.
const PLAIN: [RegExp, string][] = [
  [/getaddrinfo ENOTFOUND/g, "its address doesn't exist"],
  [/ECONNREFUSED/g, "the site refused the connection"],
  [/ECONNRESET/g, "the connection dropped"],
  [/detection failed: timed out after (\d+)s/g, "its site didn't answer within $1 seconds"],
  [/HTTP 404 Not Found/g, "the page isn't there (404)"],
];
export const plainNote = (n: string | null) =>
  n
    ? PLAIN.reduce((t, [re, w]) => t.replace(re, w), n)
        .replace(/\s+/g, " ")
        .trim()
    : null;

// Read now, set by hand: shown on the row until the read is done.
const reading = new Set<number>();
/** Is a page you gave for this company being read now (setByHand)? */
export const isReading = (id: number) => reading.has(id);

/**
 * What is stuck at a step, newest first: signals at steps 1 and 2, companies after. A page of
 * `limit` from the start or after `after` (an item's cursor), so the list can be walked whole.
 */
export function items(
  step: Step,
  o: { reason?: string; src?: string; after?: string; limit?: number } = {},
): Item[] {
  const rs = REASONS[step].filter((r) => !o.reason || r.k === o.reason);
  const reasonOf = (row: Record<string, unknown>) => rs.find((r) => row[`r_${r.k}`]) ?? rs[0]!;
  const flags = rs.map((r) => `(${r.where}) AS r_${r.k}`).join(", ");
  const any = rs.map((r) => `(${r.where})`).join(" OR ");
  const limit = Math.min(Math.max(1, o.limit ?? 10), 500);
  const cut = o.after?.lastIndexOf("|") ?? -1;
  const after = o.after && cut > 0 ? [o.after.slice(0, cut), Number(o.after.slice(cut + 1))] : null;
  const args = [...(o.src ? [o.src] : []), ...(after ?? [])];
  restage();
  const d = open();
  if (isSignalStep(step)) {
    const rows = d
      .query(
        `SELECT s.*, ${flags}, b.stage AS backlog_stage FROM signals s LEFT JOIN backlogs b ON b.id = s.backlog_id
         WHERE s.company_id IS NULL AND (${any})${o.src ? ` AND ${door("s.source")} = ?` : ""}
         ${after ? "AND (s.received_at, s.id) < (?, ?)" : ""}
         ORDER BY s.received_at DESC, s.id DESC LIMIT ${limit}`,
      )
      .all(...args) as (Signal & Record<string, unknown>)[];
    return rows.map((r) => {
      const why = reasonOf(r);
      const post = postOf(r);
      const first = (post.title ?? post.text).replace(/\s+/g, " ");
      return {
        id: r.id,
        cursor: `${r.received_at}|${r.id}`,
        label: post.author ?? (first.length > 50 ? `${first.slice(0, 48)}…` : first || "the post"),
        source: post.source,
        reason: why.k,
        why: ONE[why.k] ?? why.l,
        at: post.at,
        waiting:
          step === "signal" && ["links", "sent", "filing"].includes(String(r.backlog_stage))
            ? "Lined up: its file is sorted at the next read, within 15 minutes"
            : step === "named" && r.classify_tries < 2
              ? "Waiting for the small model's next pass, tonight"
              : null,
        running: false,
        post,
      };
    });
  }
  const now = new Date().toISOString();
  const rows = d
    .query(
      `SELECT *, coalesce(last_signal_at, created_at) AS k, ${flags} FROM staged
       WHERE stage = ${AT_STEP[step]} AND (${any})${o.src ? " AND src = ?" : ""}
       ${after ? "AND (coalesce(last_signal_at, created_at), id) < (?, ?)" : ""}
       ORDER BY coalesce(last_signal_at, created_at) DESC, id DESC LIMIT ${limit}`,
    )
    .all(...args) as Record<string, unknown>[];
  const count = d.query("SELECT count(*) AS n FROM signals WHERE company_id = ?");
  const boards = d.query(
    `SELECT url, provider, status, last_read_at, last_error, role_count, next_read_at FROM boards
     WHERE company_id = ? AND status <> 'retired' ORDER BY status = 'ok' DESC, id`,
  );
  return rows.map((r) => {
    const id = r.id as number;
    const why = reasonOf(r);
    const bs = boards.all(id) as {
      url: string;
      provider: string;
      status: string;
      last_read_at: string | null;
      last_error: string | null;
      role_count: number | null;
      next_read_at: string | null;
    }[];
    const latest = signalsOf(id, 1)[0];
    const due = bs.some((b) => b.status === "ok" && (!b.next_read_at || b.next_read_at <= now));
    return {
      id,
      cursor: `${r.k}|${id}`,
      label: String(r.name),
      source: sourceName(String(r.src)),
      reason: why.k,
      why: ONE[why.k] ?? why.l,
      at: (r.discovery_at ?? r.search_at ?? r.created_at ?? null) as string | null,
      waiting:
        step !== "roles" && r.discovery === "queued"
          ? "Lined up: looked for again at the next read, within 15 minutes"
          : step === "board" && r.discovery === "unreadable" && r.careers_url
            ? canUseSmallModel()
              ? "Lined up: the small model reads its careers page at the next read, within 15 minutes"
              : "Its careers page waits for a model to read it: connect one in Settings"
            : step === "roles" && due
              ? "Lined up: its board is read again at the next read, within 15 minutes"
              : null,
      running: reading.has(id),
      company: {
        website: r.domain ? `https://${r.domain}` : null,
        careers: http(r.careers_url as string | null),
        note: plainNote(r.discovery_note as string | null),
        noteAt: (r.discovery_at ?? r.search_at ?? null) as string | null,
        signals: (count.get(id) as { n: number }).n,
        latest: latest ? postOf(latest) : null,
        boards: bs.map((b) => ({
          url: b.url,
          provider: b.provider,
          broken: b.status !== "ok",
          readAt: b.last_read_at,
          error: plainNote(b.last_error),
          roles: b.role_count,
        })),
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Retries

type Bulk = {
  step: Step;
  reason: string | null;
  ids: number[];
  at: string;
  backlog?: number;
  prev?: Record<number, number>;
};
const bulkKey = (step: Step) => `sources:retry:${step}`;
export const bulkOf = (step: Step): Bulk | null => {
  const v = getMeta(bulkKey(step));
  return v ? (JSON.parse(v) as Bulk) : null;
};

/** One company or signal, tried again at the next read (website and board: discovery; roles: a read). */
export function again(step: Step, ids: number[], now: Date): void {
  if (!ids.length) return;
  const d = open();
  const iso = now.toISOString();
  const list = ids.join(",");
  tx(() => {
    if (step === "named")
      d.query(`UPDATE signals SET classify_tries = 0 WHERE id IN (${list}) AND company_id IS NULL`).run();
    else if (step === "website" || step === "board") {
      d.query(
        `UPDATE companies SET discovery = 'queued', search_at = NULL, discovery_at = ? WHERE id IN (${list})`,
      ).run(iso);
      // A board found once that stopped working is read again too.
      if (step === "board")
        d.query(
          `UPDATE boards SET status = 'ok', fails = 0, next_read_at = ? WHERE company_id IN (${list}) AND status = 'broken'`,
        ).run(iso);
    } else if (step === "roles")
      d.query(
        `UPDATE boards SET status = 'ok', fails = 0, next_read_at = ? WHERE company_id IN (${list}) AND status <> 'retired'`,
      ).run(iso);
    markChanged(now);
  });
  changedNow();
}

/** Try one item again: a post is read by the small model now; the rest are lined up for the next read. */
export async function retryOne(step: Step, id: number, now = new Date()): Promise<string> {
  if (step === "signal") {
    const b = open().query("SELECT backlog_id FROM signals WHERE id = ?").get(id) as {
      backlog_id: number;
    } | null;
    if (b?.backlog_id)
      open()
        .query("UPDATE backlogs SET stage = 'links', requested_at = ? WHERE id = ? AND stage = 'waiting'")
        .run(now.toISOString(), b.backlog_id);
    return "Lined up: its file is sorted at the next read, within 15 minutes";
  }
  if (step === "named") {
    const s = open()
      .query("SELECT * FROM signals WHERE id = ? AND company_id IS NULL")
      .get(id) as Signal | null;
    if (!s) return "Already filed under a company";
    if (!canUseSmallModel()) throw new Error(NO_MODEL);
    let d: Awaited<ReturnType<typeof classifyOne>>;
    try {
      d = await classifyOne(s, now);
    } catch (err) {
      if (err instanceof DayLimit)
        throw new Error("Today's limit of background checks is used: try tomorrow");
      if (err instanceof OverCap)
        throw new Error("This month's spend limit is reached: see Settings > Spend");
      throw new Error(`The small model couldn't answer: ${(err as Error).message}`);
    } finally {
      markChanged(now);
      changedNow();
    }
    return d.state === "file"
      ? `Filed under ${d.name}`
      : d.state === "unknown"
        ? "Read again: it's about hiring, but names no company the post shows"
        : "Read again: it isn't about hiring";
  }
  again(step, [id], now);
  return step === "roles"
    ? "Lined up: its board is read again at the next read, within 15 minutes"
    : "Lined up: looked for again at the next read, within 15 minutes";
}

/** The ids a reason (or a step's every reason) covers. */
function idsFor(step: Step, reason: string | null, src?: string): number[] {
  const rs = REASONS[step].filter((r) => !reason || r.k === reason);
  const any = rs.map((r) => `(${r.where})`).join(" OR ");
  const by = src ? (isSignalStep(step) ? ` AND ${door("source")} = ?` : " AND src = ?") : "";
  restage();
  const d = open();
  return (
    isSignalStep(step)
      ? d
          .query(`SELECT id FROM signals WHERE company_id IS NULL AND (${any})${by}`)
          .all(...(src ? [src] : []))
      : d
          .query(`SELECT id FROM staged WHERE stage = ${AT_STEP[step]} AND (${any})${by}`)
          .all(...(src ? [src] : []))
  ).map((r) => (r as { id: number }).id);
}

/**
 * About how many background model checks trying these again takes, at most: a post is one;
 * finding a website is a search's pick and the homepage's check; finding a board, a careers page
 * read and a pick; reading roles again, one only where the board is a careers page the model reads.
 */
function checksFor(step: Step, ids: number[]): number {
  if (step === "signal" || step === "named") return ids.length;
  if (step === "website" || step === "board") return ids.length * 2;
  if (!ids.length) return 0;
  return (
    open()
      .query(
        `SELECT count(DISTINCT company_id) AS n FROM boards
         WHERE provider = 'careers-page' AND company_id IN (${ids.join(",")})`,
      )
      .get() as { n: number }
  ).n;
}

export type Fix = {
  n: number;
  cost: string;
  how: string;
  checks: number; // background model checks it takes, at most
  left: number | null; // of today's on the subscription; null where no day limit applies
  limit: number | null;
};

/** What trying a reason again costs, in words, and the background checks it takes against today's. */
export function costOf(step: Step, reason: string | null, src?: string): Fix {
  const ids = idsFor(step, reason, src);
  const day = backgroundLeft();
  return {
    ...costWords(step, ids.length),
    checks: checksFor(step, ids),
    left: day?.left ?? null,
    limit: day?.limit ?? null,
  };
}

function costWords(step: Step, n: number): { n: number; cost: string; how: string } {
  const daily = Number(loadConfig().discovery.search_daily);
  if (step === "signal" || step === "named") {
    const model = loadConfig().models.small;
    // About a short post a call: the classifier's prompt in, a short answer out, by batch (half price).
    const each = modelCost(model, { input_tokens: SYSTEM.length / 4 + 150, output_tokens: 60 }) / 2;
    const cost =
      connection() === "subscription" ? "no charge" : `about $${Math.max(0.01, n * each).toFixed(2)}`;
    return {
      n,
      cost,
      how:
        step === "signal"
          ? `Sorts the ${n.toLocaleString("en-US")} waiting posts with the small model, ${cost}.`
          : `Has the small model read these ${n.toLocaleString("en-US")} posts again in one batch, ${cost}. Stop takes back the ones not sent yet.`,
    };
  }
  if (step === "website")
    return {
      n,
      cost: `up to ${n.toLocaleString("en-US")} searches`,
      how: `Searches the web for each company's website again, one search each, at most ${daily} companies a day (your daily search limit): ${Math.ceil(n / daily)} days for all.`,
    };
  if (step === "board")
    return {
      n,
      cost: "free, searches inside your daily limit",
      how: `Looks on each company's website for its careers page or job board again; a company still without one gets a web search, at most ${daily} a day.`,
    };
  return { n, cost: "no cost", how: "Reads these companies' boards again at the next read. Free." };
}

/** Try a whole reason (or step) again: lined up for the tick, its progress kept. */
export function retryAll(step: Step, reason: string | null, now = new Date(), src?: string): string {
  const ids = idsFor(step, reason, src);
  if (!ids.length) return "Nothing to try again";
  const bulk: Bulk = { step, reason, ids, at: now.toISOString() };
  if (step === "signal") {
    const backlogs = open()
      .query(
        "SELECT DISTINCT backlog_id AS id FROM signals WHERE id IN (" +
          ids.join(",") +
          ") AND backlog_id IS NOT NULL",
      )
      .all() as { id: number }[];
    for (const b of backlogs)
      open()
        .query("UPDATE backlogs SET stage = 'links', requested_at = ? WHERE id = ? AND stage = 'waiting'")
        .run(now.toISOString(), b.id);
  } else if (step === "named") {
    const prev = Object.fromEntries(
      (
        open()
          .query(`SELECT id, classify_tries AS t FROM signals WHERE id IN (${ids.join(",")})`)
          .all() as { id: number; t: number }[]
      ).map((r) => [r.id, r.t]),
    );
    bulk.prev = prev;
    bulk.backlog = parkAgain(
      `retry: ${reason ? REASONS.named.find((r) => r.k === reason)?.l : "posts that named no company"}`,
      ids,
      now,
    );
  } else again(step, ids, now);
  setMeta(bulkKey(step), JSON.stringify(bulk));
  changedNow();
  return `Lined up ${ids.length.toLocaleString("en-US")}: they go from the next read, within 15 minutes`;
}

/**
 * How far a step's retry has got: of its items, how many are still waiting. Waiting is still as the
 * retry left it (its time on the company or board): SQLite gives the number of a company that went
 * to the next one made, which the retry never lined up.
 */
export function progress(step: Step): { total: number; left: number; stoppable: boolean } | null {
  const b = bulkOf(step);
  if (!b) return null;
  const d = open();
  const list = b.ids.join(",") || "0";
  let left = 0;
  let stoppable = true;
  if (step === "signal" || step === "named") {
    left = (
      d
        .query(
          `SELECT count(*) AS n FROM signals WHERE id IN (${list}) AND company_id IS NULL AND classify_tries IN (0, ${PARKED})`,
        )
        .get() as { n: number }
    ).n;
    if (b.backlog) {
      const st = d.query("SELECT stage FROM backlogs WHERE id = ?").get(b.backlog) as {
        stage: string;
      } | null;
      stoppable = st?.stage === "links" || st?.stage === "waiting";
      if (st?.stage === "done") left = 0;
    }
  } else if (step === "roles")
    left = (
      d
        .query(
          `SELECT count(DISTINCT company_id) AS n FROM boards WHERE company_id IN (${list}) AND next_read_at = ?`,
        )
        .get(b.at) as { n: number }
    ).n;
  else
    left = (
      d
        .query(
          `SELECT count(*) AS n FROM companies WHERE id IN (${list}) AND discovery = 'queued' AND discovery_at = ?`,
        )
        .get(b.at) as {
        n: number;
      }
    ).n;
  if (!left && Date.now() - Date.parse(b.at) > DAY) {
    setMeta(bulkKey(step), "");
    return null;
  }
  return { total: b.ids.length, left, stoppable };
}

/** Stop a step's retry: what hasn't gone yet goes back as it was. */
export function stopAll(step: Step, now = new Date()): string {
  const b = bulkOf(step);
  if (!b) return "Nothing running";
  const d = open();
  const list = b.ids.join(",") || "0";
  tx(() => {
    if (step === "named" && b.backlog) {
      unpark(b.backlog, b.prev ?? {});
    } else if (step === "website" || step === "board")
      d.query(
        `UPDATE companies SET discovery = 'none', discovery_at = ? WHERE id IN (${list}) AND discovery = 'queued' AND discovery_at = ?`,
      ).run(now.toISOString(), b.at);
    else if (step === "roles")
      d.query(`UPDATE boards SET next_read_at = ? WHERE company_id IN (${list}) AND next_read_at = ?`).run(
        new Date(now.getTime() + DAY / 4).toISOString(),
        b.at,
      );
    markChanged(now);
  });
  setMeta(bulkKey(step), "");
  changedNow();
  return "Stopped: the rest stay as they were";
}

/** Set by hand: a signal's company (by name), a company's website, or its careers page or board. */
export async function setByHand(step: Step, id: number, value: string, now = new Date()): Promise<string> {
  const v = value.trim();
  if (!v) throw new Error("Type it first");
  if (isSignalStep(step)) {
    placeSignal(id, { name: v }, now);
    return `Filed under ${v}: its board is looked for at the next read`;
  }
  const c = getCompany(id);
  if (!c) throw new Error("No such company");
  if (step === "website") {
    const domain = siteDomain(/^https?:/i.test(v) ? v : `https://${v}`);
    if (!domain) throw new Error("That isn't a website: type its address, like example.com");
    giveDomain(id, domain, "hand");
    again("board", [id], now);
    return `Website set: ${domain}. Its board is looked for at the next read`;
  }
  const url = /^https?:/i.test(v) ? v : `https://${v}`;
  // Said now, not found later in a failed read: a link that isn't one, and LinkedIn (never read).
  // The read itself refuses private addresses and what robots.txt keeps out (core/http.ts).
  if (!URL.canParse(url) || !new URL(url).hostname.includes("."))
    throw new Error("That isn't a web address: paste the page's link, like example.com/careers");
  if (isLinkedIn(url))
    throw new Error("LinkedIn pages are never read: give its own careers page or job board");
  reading.add(id);
  // Any page of the board, filtered or not, stands for the board itself (jobs.ashbyhq.com/acme).
  // The board it finds is yours: its first read with roles retires the company's empty boards.
  void discover([c], now, atsRoot(url))
    .then((found) => {
      const mine = open().query(
        "UPDATE boards SET found_by = ? WHERE company_id = ? AND url = ? AND last_read_at IS NULL",
      );
      for (const f of found) if (f.board) mine.run(BY_HAND, f.companyId, f.board);
    })
    .catch(() => {})
    .finally(() => {
      reading.delete(id);
      markChanged();
      changedNow();
    });
  return "Reading it now: it leaves this list once its roles are read";
}

/**
 * Not a company: a signal is set aside, a company dismissed; either leaves every stuck list.
 * `prev`: what a signal was before, for Undo.
 */
export function notACompany(step: Step, id: number, now = new Date()): { toast: string; prev?: number } {
  let prev: number | undefined;
  if (isSignalStep(step)) {
    const s = open()
      .query("SELECT classify_tries AS t FROM signals WHERE id = ? AND company_id IS NULL")
      .get(id) as {
      t: number;
    } | null;
    if (!s) throw new Error("It's already filed under a company");
    prev = s.t;
    open().query("UPDATE signals SET classify_tries = ? WHERE id = ?").run(SET_ASIDE, id);
  } else dismissCompany(id, now);
  markChanged(now);
  changedNow();
  return { toast: "Set aside: it won't be tried again", ...(prev !== undefined ? { prev } : {}) };
}
const UNDO_TO = new Set([0, 1, ANSWERED, COMPANY_UNKNOWN, PARKED]);
export function undoNot(step: Step, id: number, prev?: number, now = new Date()): string {
  if (isSignalStep(step))
    open()
      .query(
        "UPDATE signals SET classify_tries = ? WHERE id = ? AND company_id IS NULL AND classify_tries = ?",
      )
      .run(prev !== undefined && UNDO_TO.has(prev) ? prev : 0, id, SET_ASIDE);
  else open().query("UPDATE companies SET dismissed_at = NULL WHERE id = ?").run(id);
  markChanged(now);
  changedNow();
  return "Back as it was";
}

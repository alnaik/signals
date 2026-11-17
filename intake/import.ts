// `jobsignal migrate` (also `jobsignal db import`): the data folder's files from before
// jobsignal.db, folded into it once. Safe to run again: every step finds or makes by key (a
// company by domain or name, a board by provider and slug, a role by its board id or link, a
// signal by its link), so a second run adds nothing. The old files then go into one archive,
// archive/pre-sqlite-<date>.tgz, and leave the folder; threads/, me/, the ledger and config stay.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadFilters, score, workMode } from "../ats/filters.ts";
// @ts-expect-error plain JS module
import { careersPage } from "../ats/links.mjs";
import { atsRoot, boardKey, type Job, postingId } from "../ats/reader.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, getMeta, open, setMeta, tx } from "../core/db.ts";
import { roleLinkOk } from "../core/http.ts";
import { dataDir, paths } from "../core/paths.ts";
import { updateState } from "../core/state.ts";
import { readSourceState, writeSourceState } from "../signals/state.ts";
import {
  type ApplyEmail,
  companyByDomain,
  type Funding,
  isPlaceholder,
  recordSignal,
  setFunding,
  upsertCompany,
} from "./companies.ts";
import { addBoard } from "./discover.ts";
import { normalizeUrl } from "./leads.ts";
import { applyRead, type Board } from "./refresh.ts";
import type { Lead } from "./types.ts";

// Boards the evidence rule (2026-10-28) took away from companies that are theirs, restored from
// directory.pre-evidence.json. Not Deloitte's: deloitteie is Deloitte Ireland, not the Deloitte
// the signal named.
export const RESTORE = ["cape.co", "onechronos.com"];

export type ImportResult = {
  companies: number;
  watched: number;
  boards: number;
  restored: string[];
  roles: number; // from snapshots and Inbox rows
  signals: number;
  pending: number; // signals waiting for the classifier
  dismissed: number;
  merged: number; // duplicate rows of one posting folded into one
  skipped: string[]; // what wasn't brought over, and why
  archive: string | null;
};

type DirEntry = {
  name?: string;
  board?: string | null;
  provider?: string | null;
  careers_url?: string | null;
  checked_at?: string;
  apply_email?: ApplyEmail | null;
  funding?: Funding | null;
  domain_ok?: boolean;
};
type WatchEntry = {
  name: string;
  added: string;
  sources?: string[];
  ats?: { provider: string; url?: string } | null;
  careers?: { url: string };
  funding?: Funding;
  [k: string]: unknown;
};
type Row = {
  id: string;
  ts: string;
  url: string;
  domain: string;
  company: string;
  title?: string;
  location?: string;
  source: string;
  source_tag: string;
  kind?: string;
  text?: string;
  author?: string;
  posted_at?: string;
  reposted?: string;
  note?: string;
};
type Folded = Row & { outcome?: string; outcome_at?: string };
type Snapshot = {
  fetched_at: string;
  provider: string;
  careers_url: string;
  jobs: (Job & { id?: string })[];
};

const src = (f: string) => path.join(dataDir(), "sources", f);
const json = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};
const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            return l.trim() ? [JSON.parse(l) as T] : [];
          } catch {
            return []; // a torn line
          }
        })
    : [];

/** inbox.jsonl's events, folded: each row with how it ended and when; and the companies dismissed. */
export function foldInbox(file: string): { rows: Folded[]; dismissed: Map<string, string> } {
  const rows = new Map<string, Folded>();
  const dismissed = new Map<string, string>();
  for (const e of lines<Record<string, unknown> & { op: string; ts: string }>(file)) {
    const r = typeof e.id === "string" ? rows.get(e.id) : undefined;
    if (e.op === "add") rows.set((e.row as Row).id, { ...(e.row as Row) });
    else if (e.op === "upgrade" && r) {
      const { source: _s, source_tag: _t, ...rest } = e.row as Partial<Row>;
      Object.assign(r, rest); // a board read's upgrade kept where the row was seen
    } else if (e.op === "act" && r && !r.outcome) Object.assign(r, { outcome: e.action, outcome_at: e.ts });
    else if (e.op === "archive" && r && !r.outcome)
      Object.assign(r, { outcome: (e.outcome as string | undefined) ?? "expired", outcome_at: e.ts });
    else if (e.op === "dismiss_company") dismissed.set(e.domain as string, e.ts);
    else if (e.op === "undismiss_company") dismissed.delete(e.domain as string);
  }
  return { rows: [...rows.values()], dismissed };
}

const boardOfCompany = (companyId: number) =>
  open()
    .query("SELECT * FROM boards WHERE company_id = ? AND status = 'ok' ORDER BY id LIMIT 1")
    .get(companyId) as Board | null;

/** A board's snapshots, oldest first, replayed as reads: roles get their first-seen dates, ids and closes. */
function replaySnapshots(domain: string, board: Board): number {
  const dir = paths.snapshots(domain);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)
    .filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))
    .sort()) {
    const s = json<Snapshot | null>(path.join(dir, f), null);
    if (!s?.jobs || boardKey(s.provider, atsRoot(s.careers_url)) !== board.key) continue;
    // A replay already done leaves the board read at this time or later.
    const fresh = open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as Board;
    if (fresh.last_read_at && fresh.last_read_at >= s.fetched_at) continue;
    const jobs = s.jobs
      .filter((j) => j.url && j.title)
      .map((j) => ({
        ...j,
        id: String(j.id ?? j.url),
        location: j.location ?? "",
        postedAt: j.postedAt ?? null,
      }));
    applyRead(fresh, { ok: true, jobs }, new Date(s.fetched_at));
    n += jobs.length;
  }
  return n;
}

const STATE: Record<string, string> = {
  apply: "applied",
  apply_watch: "applied",
  dismiss: "dismissed",
  expired: "archived",
};

/** An Inbox row of a board's role: the role takes its state, its first-seen date, its repost. */
function placeRole(row: Folded, board: Board, filters = loadFilters()): boolean {
  // A link that isn't a web page or a mail link is never stored (as in refresh's reads).
  if (!roleLinkOk(row.url)) return false;
  const d = open();
  const url = normalizeUrl(row.url);
  const pid = postingId(board.provider, row.url, "") || null;
  const found = (
    d.query("SELECT id, ext_id, url, first_seen, state FROM roles WHERE board_id = ?").all(board.id) as {
      id: number;
      ext_id: string | null;
      url: string;
      first_seen: string;
      state: string;
    }[]
  ).find((r) => (pid && r.ext_id === pid) || normalizeUrl(r.url) === url);
  // What you did with it carries over. A role still open in the old Inbox is new only when it's
  // news by refresh's rule (posted within postings.max_age_days of reaching the Inbox): the old
  // Inbox held 109 of Netflix's roles at once.
  const chosen = (row.outcome && STATE[row.outcome]) || null;
  const closed = row.outcome === "gone" ? (row.outcome_at ?? row.ts) : null;
  if (found) {
    // Its snapshot replay already decided whether it arrived as news; only a choice overrides that.
    d.query(
      `UPDATE roles SET first_seen = min(first_seen, $ts), reposted = coalesce(reposted, $reposted),
         state = CASE WHEN state IN ('new', 'archived') AND $state IS NOT NULL THEN $state ELSE state END,
         state_at = CASE WHEN state IN ('new', 'archived') AND $state IS NOT NULL THEN $at ELSE state_at END,
         closed_at = coalesce(closed_at, $closed) WHERE id = $id`,
    ).run({
      id: found.id,
      ts: row.ts,
      reposted: row.reposted ?? null,
      state: chosen,
      at: row.outcome_at ?? null,
      closed,
    });
    return false;
  }
  const maxAge = loadConfig().postings.max_age_days * DAY;
  const news = !row.posted_at || Date.parse(row.ts) - Date.parse(row.posted_at) <= maxAge;
  const state = chosen ?? (news ? "new" : "archived");
  // Not in any snapshot: kept under the id its link carries (else none); a read matches it by
  // that id or by link.
  const job = { title: row.title!, location: row.location ?? "", description: row.text };
  const s = score(job, filters);
  d.query(
    `INSERT INTO roles (board_id, company_id, ext_id, url, title, location, mode, posted_at, first_seen,
       last_seen, closed_at, reposted, fits, matched, review, state, state_at)
     VALUES ($board, $company, $ext, $url, $title, $location, $mode, $posted, $ts, $ts, $closed, $reposted,
       $fits, $matched, $review, $state, $at)`,
  ).run({
    board: board.id,
    company: board.company_id,
    ext: pid,
    url: row.url,
    title: row.title!,
    location: row.location ?? "",
    mode: workMode(job).mode,
    posted: row.posted_at ?? null,
    ts: row.ts,
    closed,
    reposted: row.reposted ?? null,
    // It was in the Inbox: it fit the filters of the day.
    fits: 1,
    matched: s.matched,
    review: null,
    state,
    at: state === "new" ? null : (row.outcome_at ?? null),
  });
  return true;
}

function archiveOld(now: Date): string | null {
  const root = dataDir();
  const old = [
    ...readdirSync(root).filter((f) => /^inbox(\..+)?\.jsonl$/.test(f)),
    "watchlist.json",
    ...readdirSync(path.join(root, "sources"))
      .filter((f) => /^(directory|company-domains)(\..+)?\.json$/.test(f) || f === "pending.jsonl")
      .map((f) => `sources/${f}`),
    "snapshots",
  ].filter((f) => existsSync(path.join(root, f)));
  if (!old.length) return null;
  const name = `archive/pre-sqlite-${now.toISOString().slice(0, 10)}.tgz`;
  let file = path.join(root, name);
  for (let i = 2; existsSync(file); i++) file = path.join(root, name.replace(".tgz", `-${i}.tgz`));
  mkdirSync(path.join(root, "archive"), { recursive: true });
  const r = spawnSync("tar", ["-czf", file, "-C", root, ...old], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`archiving the old files failed: ${r.stderr}`);
  for (const f of old) rmSync(path.join(root, f), { recursive: true, force: true });
  return path.relative(root, file);
}

/** Sources and jobs that no longer exist leave the rail and the schedule. */
function forgetOldSources(): void {
  updateState((s) => {
    for (const k of ["ats", "directory-boards"]) delete s.sources[k];
  });
  const jobs = readSourceState<Record<string, unknown>>("jobs", {});
  for (const k of ["board-detect", "inbox-expire"]) delete jobs[k];
  writeSourceState("jobs", jobs);
}

const RANK: Record<string, number> = { applied: 0, dismissed: 1, new: 2, archived: 3 };

/**
 * Every role under the id its link carries (postingId), one row per posting: an earlier import
 * kept some boards' roles under their links and the readers' under numbers, so one amazon.jobs
 * posting could be two rows. Duplicates fold into the row you acted on (applied, dismissed),
 * else the first seen; it keeps the earliest first-seen and the latest sighting. Returns the
 * rows removed.
 */
export function canonicalRoleIds(): number {
  const d = open();
  let removed = 0;
  tx(() => {
    const rows = d
      .query(
        `SELECT r.id, r.board_id, r.ext_id, r.url, r.state, r.first_seen, r.last_seen, r.closed_at, b.provider
         FROM roles r JOIN boards b ON b.id = r.board_id ORDER BY r.board_id, r.id`,
      )
      .all() as {
      id: number;
      board_id: number;
      ext_id: string | null;
      url: string;
      state: string;
      first_seen: string;
      last_seen: string;
      closed_at: string | null;
      provider: string;
    }[];
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const id = postingId(r.provider, r.url, r.ext_id ?? "");
      if (!id) continue;
      const k = `${r.board_id}\u0000${id}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const setId = d.query("UPDATE roles SET ext_id = NULL WHERE id = ?");
    const finish = d.query(
      "UPDATE roles SET ext_id = $ext, first_seen = $first, last_seen = $last, closed_at = $closed WHERE id = $id",
    );
    const keepText = d.query(
      "UPDATE OR IGNORE role_text SET role_id = ? WHERE role_id = ? AND NOT EXISTS (SELECT 1 FROM role_text WHERE role_id = ?)",
    );
    const drop = d.query("DELETE FROM roles WHERE id = ?");
    const dropText = d.query("DELETE FROM role_text WHERE role_id = ?");
    for (const [k, list] of groups) {
      const ext = k.split("\u0000")[1]!;
      if (list.length === 1 && list[0]!.ext_id === ext) continue;
      const sorted = [...list].sort(
        (x, y) => (RANK[x.state] ?? 9) - (RANK[y.state] ?? 9) || x.first_seen.localeCompare(y.first_seen),
      );
      const keep = sorted[0]!;
      const latest = [...list].sort((x, y) => y.last_seen.localeCompare(x.last_seen))[0]!;
      // Clear the ids first: the board's (board, ext_id) is unique.
      for (const r of list) setId.run(r.id);
      for (const r of sorted.slice(1)) {
        keepText.run(keep.id, r.id, keep.id);
        dropText.run(r.id);
        drop.run(r.id);
        removed++;
      }
      finish.run({
        id: keep.id,
        ext,
        first: list.map((r) => r.first_seen).sort()[0]!,
        last: latest.last_seen,
        closed: latest.closed_at,
      });
    }
  });
  return removed;
}

export function importOld(o: { archive?: boolean } = {}, now = new Date()): ImportResult {
  open();
  const out: ImportResult = {
    companies: 0,
    watched: 0,
    boards: 0,
    restored: [],
    roles: 0,
    signals: 0,
    pending: 0,
    dismissed: 0,
    merged: 0,
    skipped: [],
    archive: null,
  };
  const before = (t: string) => (open().query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const counts0 = {
    companies: before("companies"),
    boards: before("boards"),
    roles: before("roles"),
    signals: before("signals"),
  };
  const filters = loadFilters();

  tx(() => {
    // 1. Names and their domains, as the old resolver found them: guesses, kept only to name the
    // directory's companies below.
    const names = json<Record<string, string | null>>(src("company-domains.json"), {});

    // 2. The watchlist: watched companies, their boards and funding.
    const w = json<Record<string, WatchEntry>>(paths.watchlist(), {});
    for (const [domain, e] of Object.entries(w)) {
      const id = upsertCompany({ name: e.name, domain }, new Date(e.added));
      open()
        .query(
          `UPDATE companies SET watched_at = coalesce(watched_at, $at),
             watch_sources = coalesce(watch_sources, $sources), dismissed_at = NULL WHERE id = $id`,
        )
        .run({ id, at: e.added, sources: JSON.stringify(e.sources ?? ["manual"]) });
      if (e.ats?.url) addBoard(id, e.ats.provider, e.ats.url, "import", now);
      else if (e.careers?.url) addBoard(id, "careers-page", e.careers.url, "import", now);
      if (e.funding) setFunding(id, e.funding);
    }

    // 3. The directory: the boards found for companies a signal named, and what else was seen.
    const dir = json<Record<string, DirEntry>>(src("directory.json"), {});
    const pre = json<Record<string, DirEntry>>(src("directory.pre-evidence.json"), {});
    for (const d of RESTORE)
      if (pre[d]?.board && !dir[d]?.board) {
        dir[d] = { ...dir[d], ...pre[d] };
        out.restored.push(`${pre[d]!.name ?? d} (${pre[d]!.board})`);
      }
    const nameOf = new Map(Object.entries(names).flatMap(([n, d]) => (d ? [[d, n] as const] : [])));
    for (const [domain, e] of Object.entries(dir)) {
      if (e.name && isPlaceholder(e.name)) {
        out.skipped.push(`directory/${domain}: "${e.name}" names no company`);
        continue;
      }
      const id = upsertCompany(
        { name: e.name && e.name !== domain ? e.name : (nameOf.get(domain) ?? domain), domain },
        now,
      );
      // The directory only held companies a signal named in the last 60 days.
      if (e.checked_at)
        open()
          .query("UPDATE companies SET last_signal_at = max(coalesce(last_signal_at, ''), ?) WHERE id = ?")
          .run(e.checked_at, id);
      if (e.board && e.provider) addBoard(id, e.provider, e.board, "import", now);
      else
        open()
          .query(
            `UPDATE companies SET discovery = coalesce(discovery, $discovery), discovery_at = coalesce(discovery_at, $at),
               discovery_note = coalesce(discovery_note, $note), careers_url = coalesce(careers_url, $careers)
             WHERE id = $id`,
          )
          .run({
            id,
            // Held back by the evidence rule (its domain "not confirmed"): looked for again now,
            // with no note yet ("queued · no board found" read as if it had been looked for).
            discovery: e.domain_ok === false ? "queued" : "none",
            note: e.domain_ok === false ? null : "no board found",
            at: e.checked_at ?? now.toISOString(),
            careers: e.careers_url && careersPage(e.careers_url) ? e.careers_url : null,
          });
      if (e.apply_email)
        open()
          .query("UPDATE companies SET apply_email = coalesce(apply_email, ?) WHERE id = ?")
          .run(JSON.stringify(e.apply_email), id);
      if (e.funding) setFunding(id, e.funding);
    }
  });

  // 4. The Inbox's signals, before any board is read: a read keeps new the roles a
  // signal named (refresh.ts). A board's role keeps its state once the snapshots are in (6).
  const { rows, dismissed } = foldInbox(path.join(dataDir(), "inbox.jsonl"));
  const unboarded = new Set<string>();
  const boardRows: Folded[] = [];
  tx(() => {
    for (const r of rows) {
      if (r.source === "ats" && r.title) {
        const c = companyByDomain(r.domain);
        if (c && boardOfCompany(c.id)) {
          boardRows.push(r);
          continue;
        }
        // Its board left the directory: the row stays as a signal, and its link (a posting on the
        // board) is where discovery starts.
        unboarded.add(r.company);
      }
      if (r.source === "form-d" && r.title) continue; // "Form D: X": funding is a company fact now
      const lead: Lead & { ref?: string } = {
        url: r.url,
        // "Unknown" with a domain was the old classifier's guess: the signal waits for the new one.
        ...(r.domain && !isPlaceholder(r.company ?? "") ? { domain: r.domain } : {}),
        company_hint: r.company,
        ...(r.title ? { title: r.title } : {}),
        ...(r.location ? { location: r.location } : {}),
        ...(r.text ? { text: r.text } : {}),
        ...(r.author ? { author: r.author } : {}),
        ...(r.note ? { note: r.note } : {}),
        ...(r.posted_at ? { posted_at: r.posted_at } : {}),
        kind: (r.kind as Lead["kind"]) ?? "post",
        max_age_days: null,
        source: r.source,
        // A board's role whose board left the directory: "Board", not the old "ATS change".
        source_tag: r.source === "ats" ? "Board" : r.source_tag,
      };
      const s = recordSignal(lead, new Date(r.ts));
      const id = s.companyId;
      if (id && (r.outcome === "dismiss" || r.outcome === "apply"))
        open()
          .query(
            "UPDATE companies SET dismissed_at = coalesce(dismissed_at, ?) WHERE id = ? AND watched_at IS NULL",
          )
          .run(r.outcome_at ?? r.ts, id);
      if (id && (r.outcome === "watch" || r.outcome === "apply_watch"))
        open()
          .query(
            "UPDATE companies SET watched_at = coalesce(watched_at, ?), watch_sources = coalesce(watch_sources, '[\"inbox\"]') WHERE id = ?",
          )
          .run(r.outcome_at ?? r.ts, id);
    }
    for (const [domain, at] of dismissed) {
      const c = companyByDomain(domain);
      if (c && !c.watched_at && !c.dismissed_at) {
        open().query("UPDATE companies SET dismissed_at = ? WHERE id = ?").run(at, c.id);
        out.dismissed++;
      }
    }

    for (const c of unboarded)
      out.skipped.push(
        `${c}: board roles kept as signals; its board isn't in the directory any more, so discovery looks again`,
      );

    // Leads that waited for the classifier: signals now. A name is enough to make a company.
    for (const l of lines<Lead>(src("pending.jsonl")))
      recordSignal({ ...l, max_age_days: null }, new Date(l.seen_at ?? l.posted_at ?? now.toISOString()));
  });

  // 5. Snapshots, replayed into the roles table: each board's history as it was read.
  const snapDirs = existsSync(paths.snapshots())
    ? readdirSync(paths.snapshots()).filter((f) => !f.startsWith("."))
    : [];
  for (const domain of snapDirs) {
    const c = companyByDomain(domain);
    const board = c ? boardOfCompany(c.id) : null;
    if (!board) {
      out.skipped.push(`snapshots/${domain}: no board for it in the watchlist or the directory`);
      continue;
    }
    if (board.provider === "careers-page") continue;
    replaySnapshots(domain, board);
  }

  // 6. A board's role in the Inbox keeps its state: applied, dismissed, expired.
  tx(() => {
    for (const r of boardRows) placeRole(r, boardOfCompany(companyByDomain(r.domain)!.id)!, filters);
  });

  // 7. One row per posting, under the id its link carries (also mends a db imported before this).
  out.merged = canonicalRoleIds();

  const after = (t: string) => before(t);
  out.companies = after("companies") - counts0.companies;
  out.boards = after("boards") - counts0.boards;
  out.roles = after("roles") - counts0.roles;
  out.signals = after("signals") - counts0.signals;
  out.watched = (
    open().query("SELECT count(*) AS n FROM companies WHERE watched_at IS NOT NULL").get() as { n: number }
  ).n;
  out.pending = (
    open().query("SELECT count(*) AS n FROM signals WHERE company_id IS NULL").get() as { n: number }
  ).n;
  if (!getMeta("imported_at")) setMeta("imported_at", now.toISOString());
  if (o.archive) {
    out.archive = archiveOld(now);
    forgetOldSources();
  }
  return out;
}

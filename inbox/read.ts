// Read them: the descriptions of the open roles at the companies a search names, read now so
// the search finds their words; and the places of those whose board names none (Deloitte's), from
// their pages. Deloitte, 2026-11-16: 83 of its 539 roles name the AI & Data team
// in their description and nowhere else, 32 of those outside your filters, so every open role is
// read, those that fit first. In the server, on its own: closing the board doesn't stop it, Stop
// does. One host at a time per host (its polite gate), hosts side by side; a description that
// can't be read (or a page that names no place) isn't asked again for 30 days (roles.text_missed_at).
import { rolePlaces, roleText } from "../ats/detail.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, markChanged, open } from "../core/db.ts";
import { failure } from "../core/trace.ts";
import { emit } from "../server/hub.ts";

export const READ_CAP = 600; // a press reads at most this many; a bigger company takes two

export type Reading = { names: string[]; done: number; failed: number; total: number; stopped: boolean };

let job: (Reading & { companies: number[]; stop: AbortController }) | null = null;

/**
 * The roles a press would read: open, no description kept or no place (a board that lists none:
 * its page names them), not missed lately; those that fit first.
 */
function unread(companies: number[], now: Date): { id: number; url: string; kept: number }[] {
  return open()
    .query(
      `SELECT r.id, r.url, EXISTS (SELECT 1 FROM role_text t WHERE t.role_id = r.id) AS kept FROM roles r
       WHERE r.company_id IN (SELECT value FROM json_each($companies)) AND r.closed_at IS NULL
         AND (r.location = '' OR NOT EXISTS (SELECT 1 FROM role_text t WHERE t.role_id = r.id))
         AND (r.text_missed_at IS NULL OR r.text_missed_at < $since)
       ORDER BY r.fits DESC, r.first_seen DESC`,
    )
    .all({
      companies: JSON.stringify(companies),
      since: new Date(now.getTime() - 30 * DAY).toISOString(),
    }) as { id: number; url: string; kept: number }[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** What a press would read: how many, and how long at least (the busiest host, a polite request a second; Deloitte answers in about 3 s). */
export function readOffer(companies: number[], now = new Date()): { roles: number; minutes: number } | null {
  if (!companies.length) return null;
  const rows = unread(companies, now);
  if (!rows.length) return null;
  const take = rows.slice(0, READ_CAP);
  const perHost = new Map<string, number>();
  for (const r of take) perHost.set(hostOf(r.url), (perHost.get(hostOf(r.url)) ?? 0) + 1);
  const rps = loadConfig().polling.per_host_rps;
  return { roles: rows.length, minutes: Math.max(1, Math.ceil(Math.max(...perHost.values()) / rps / 60)) };
}

/** The read going now, if any. */
export const reading = (): Reading | null =>
  job && { names: job.names, done: job.done, failed: job.failed, total: job.total, stopped: job.stopped };

/**
 * Read the descriptions of these companies' open roles. A press while a read runs joins it. The
 * progress goes out on the live stream ("inbox.read"), the Inbox's lists are told at the end.
 */
export function startRead(companies: number[], names: string[], now = new Date()): Reading | null {
  if (job) return reading();
  const rows = unread(companies, now).slice(0, READ_CAP);
  if (!rows.length) return null;
  const stop = new AbortController();
  const j = { names, companies, done: 0, failed: 0, total: rows.length, stopped: false, stop };
  job = j;
  const hosts = new Map<string, { id: number; kept: number }[]>();
  for (const r of rows) hosts.set(hostOf(r.url), [...(hosts.get(hostOf(r.url)) ?? []), r]);
  const missed = open().query("UPDATE roles SET text_missed_at = ? WHERE id = ?");
  let said = 0;
  const tell = (force = false) => {
    if (!force && Date.now() - said < 1000) return;
    said = Date.now();
    emit("inbox.read", reading());
  };
  void Promise.all(
    [...hosts.values()].map(async (list) => {
      for (const { id, kept } of list) {
        if (stop.signal.aborted) return;
        // Its description (and its places, when its board named none); kept already: its places.
        const ok = kept ? await rolePlaces(id).catch(() => false) : !!(await roleText(id).catch(() => null));
        if (!ok) {
          missed.run(new Date().toISOString(), id);
          j.failed++;
        }
        j.done++;
        if (j.done % 50 === 0) markChanged(); // the search finds what came so far
        tell();
      }
    }),
  )
    .catch((err) => failure("board", "read descriptions", err))
    .finally(() => {
      j.stopped = stop.signal.aborted;
      job = null;
      markChanged();
      emit("inbox.read", { ...j, stop: undefined, companies: undefined, finished: true });
      emit("inbox.changed", {});
    });
  tell(true);
  return reading();
}

/** Stop: the reads under way finish, no more start. */
export function stopRead(): boolean {
  job?.stop.abort();
  return !!job;
}

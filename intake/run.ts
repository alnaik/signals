// One scheduler tick: run every due source and job, record results for the rail.
// launchd fires a tick every 15 minutes and again on wake, so missed work catches up.
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { importAll } from "../core/features.ts";
import { lockHolder, takeLock } from "../core/lock.ts";
import { checkSignedIn } from "../core/model.ts";
import { online } from "../core/online.ts";
import { dataDir, ensureLayout } from "../core/paths.ts";
import { readState, recordRun, setAgent, setConnected } from "../core/state.ts";
import { failure } from "../core/trace.ts";
import { batchStatus, startIfAsked } from "./batch.ts";
import { discoverDue, stillGoing } from "./discover.ts";
import { isDue, sourceDay, sourceEveryHours } from "./due.ts";
import { type IntakeResult, intakeLead } from "./leads.ts";
import { makeAllDue, refreshDue, resolvePlaces, summary } from "./refresh.ts";
import { repairOnce } from "./repair.ts";
import type { Job, Source } from "./types.ts";

export async function discoverSources(): Promise<Source[]> {
  return (await importAll<{ default?: Source }>("sources/*/index.ts"))
    .map((m) => m.mod.default)
    .filter((s): s is Source => !!s);
}

export async function discoverJobs(): Promise<Job[]> {
  return (await importAll<{ jobs?: Job[] }>("*/jobs.ts")).flatMap((m) => m.mod.jobs ?? []);
}

type JobState = Record<string, { lastRun?: string; lastOk?: string; error?: string | null; result?: string }>;
const jobsFile = () => path.join(dataDir(), "sources", "jobs.json");
function readJobs(): JobState {
  try {
    return JSON.parse(readFileSync(jobsFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeJobs(s: JobState): void {
  writeFileSync(`${jobsFile()}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${jobsFile()}.tmp`, jobsFile());
}

/** Run one source now and feed its leads to intake. A failure is recorded, never thrown. */
export async function runSource(src: Source, since: Date | null = null) {
  const counts: Record<IntakeResult, number> = {
    added: 0,
    duplicate: 0,
    dismissed: 0,
    stale: 0,
    pending: 0,
  };
  try {
    const leads = await src.fetch(since);
    for (const lead of leads) counts[intakeLead(lead).result]++;
    const kept = counts.added + counts.pending;
    const note = src.note ? ` · ${src.note}` : "";
    recordRun(src.key, src.name, { ok: true, stat: `${kept} / ${src.read ?? leads.length} kept${note}` });
    return { ok: true as const, counts, fetched: leads.length };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failure("source", src.key, err);
    recordRun(src.key, src.name, { ok: false, reason: reason.slice(0, 160) });
    return { ok: false as const, reason };
  }
}

export function lock(): (() => void) | null {
  const file = path.join(dataDir(), "tick.lock");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8"));
    // A lock older than two hours is stale even if its pid is alive: pids get reused.
    const fresh = Date.now() - statSync(file).mtimeMs < 2 * 3_600_000;
    try {
      process.kill(pid, 0);
      if (fresh) return null; // another tick is running
    } catch {
      // stale lock from a crashed tick
    }
  }
  writeFileSync(file, String(process.pid));
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}

function nextTickLabel(now = new Date()): string {
  const next = new Date(now.getTime() + 15 * 60_000);
  return next.toTimeString().slice(0, 5);
}

/**
 * Boards: every board that's due, and beside it discovery (companies a signal named that have no
 * board yet, within its own time budget, so a slow company site never holds the reads up). Boards
 * discovery found get their first read after. On the rail as "Boards". While a batch run is
 * finding boards (intake/batch.ts), discovery is its alone: the tick skips it.
 */
export async function runBoardsStep(now = new Date(), log = console.log): Promise<void> {
  setAgent("intake", "working", "reading boards");
  const discovering = batchStatus()?.running || lockHolder("batch") !== null ? null : takeLock("discover");
  try {
    for (const line of repairOnce(now)) log(`repair: ${line}`);
    const t0 = Date.now();
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const [outcomes, found] = await Promise.all([
      refreshDue(now).then((o) => {
        log(`boards: ${summary(o)} · ${secs(Date.now() - t0)}`);
        return o;
      }),
      discovering
        ? discoverDue(now)
            .catch((err) => {
              failure("discover", "tick", err);
              return [];
            })
            .then((f) => {
              if (f.length)
                log(
                  `discover: ${f.filter((x) => x.board).length} boards found for ${f.length} companies · ${secs(Date.now() - t0)}`,
                );
              return f;
            })
        : skipped(log),
    ]);
    // What discovery just found, read now rather than in 15 minutes.
    const first = found.some((f) => f.board) ? await refreshDue(now) : [];
    if (first.length) log(`new boards: ${summary(first)}`);
    const places = await resolvePlaces(now).catch((err) => {
      failure("places", "tick", err);
      return 0;
    });
    if (places) log(`workday places: ${places} roles`);
    const all = [...outcomes, ...first];
    const line = summary(all);
    const failed = all.length > 0 && all.every((o) => o.status === "failed");
    recordRun(
      "boards",
      "Boards",
      failed ? { ok: false, reason: all[0]?.error ?? "every read failed" } : { ok: true, stat: line },
    );
  } catch (err) {
    failure("job", "boards", err);
    recordRun("boards", "Boards", { ok: false, reason: (err as Error).message.slice(0, 160) });
  } finally {
    // Discovery's steps its deadline left going finish inside the tick's lock: two minutes at most,
    // so one that hangs can't hold the lock (and every tick after it).
    const left = await stillGoing(LATE_MS);
    if (left) log(`discover: ${left} steps still going after ${LATE_MS / 60_000} minutes, left to finish`);
    discovering?.();
  }
}
const LATE_MS = 2 * 60_000;
// While a batch run finds boards, the tick leaves discovery to it.
const skipped = async (log: (l: string) => void) => {
  log("discover: skipped, a batch run started on Sources is finding boards");
  return [];
};

/** One pass of the schedule. `now6h`: every six-hour source runs and every board is read (`tick --now`). */
export async function tick(
  now = new Date(),
  log = console.log,
  o: { now6h?: boolean } = {},
): Promise<boolean> {
  ensureLayout();
  const release = lock();
  if (!release) {
    log("Another tick is running.");
    return false;
  }
  try {
    // No internet: every read would fail and count against its board or company. Nothing is read
    // and nothing recorded; the next tick tries again.
    if (!(await online())) {
      log("no internet: this read was skipped");
      return true;
    }
    // A tick is in the background: it waits for whether Claude Code is signed in, so every model
    // step in it sees the real answer.
    await checkSignedIn();
    const state = readState();
    for (const src of await discoverSources()) {
      if (!(await src.connected())) {
        if (state.sources[src.key]?.connected !== false) setConnected(src.key, src.name, false);
        continue;
      }
      const s = state.sources[src.key];
      const due =
        (o.now6h && src.schedule === "every_6h") ||
        isDue(src.schedule, s?.lastRun, now, sourceEveryHours(src.key), sourceDay(src.key));
      if (!(s?.enabled ?? !src.off) || !due) continue;
      setAgent("intake", "working", `reading ${src.name}`);
      const r = await runSource(src, s?.lastOk ? new Date(s.lastOk) : null);
      log(`${src.key}: ${r.ok ? JSON.stringify(r.counts) : `failed: ${r.reason}`}`);
    }
    await startIfAsked(log, now);
    if (o.now6h) makeAllDue(now);
    await runBoardsStep(now, log);
    const jobState = readJobs();
    for (const job of await discoverJobs()) {
      const js = jobState[job.name] ?? {};
      if (!isDue(job.schedule, js.lastRun, now)) continue;
      js.lastRun = new Date().toISOString();
      try {
        const result = await job.run();
        Object.assign(js, { lastOk: js.lastRun, error: null, result: result ?? "" });
        log(`${job.name}: ${result ?? "ok"}`);
      } catch (err) {
        js.error = err instanceof Error ? err.message : String(err);
        failure("job", job.name, err);
        log(`${job.name}: failed: ${js.error}`);
      }
      jobState[job.name] = js;
      writeJobs(jobState);
    }
  } finally {
    setAgent("intake", "idle", `idle · next ${nextTickLabel()}`);
    release();
  }
  return true;
}

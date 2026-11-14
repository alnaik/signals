// A batch run: the job boards of every company waiting, looked for now, in one go, then the boards
// it found read. Only the person starts one (Sources, the companies a dropped file brought, first
// run's Start with); nothing starts one by itself. It is its own process (`jobsignal find-boards`,
// started detached, so restarting the board never stops it mid-write) with its own lock,
// batch.lock, beside the ticks, which carry on every 15 minutes. Finding boards never runs twice
// at once (Context.dev answers one request at a time per organisation, and its queue is one
// process's): whichever is finding boards holds discover.lock, a tick skips its discovery while a
// batch run holds its lock, and a batch run waits for a tick's discovery already going. Inside it
// every limit applies as in a tick (each host's pace, the day's web searches, the day's background
// checks, the spend limits, robots.txt). Stop ends it after the companies in hand; one that died
// (its lock stale) is resumed by starting again, and what it looked at isn't looked at again.
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { canReadPages } from "../ats/read-page.ts";
import { getMeta, markChanged, setMeta } from "../core/db.ts";
import { canSpend } from "../core/ledger.ts";
import { lockHolder, takeLock } from "../core/lock.ts";
import { backgroundLeft, canUseSmallModel, checkSignedIn, connection } from "../core/model.ts";
import { online } from "../core/online.ts";
import { dataDir } from "../core/paths.ts";
import { failure } from "../core/trace.ts";
import { webSearches } from "../providers/registry.ts";
import type { Company } from "./companies.ts";
import { discoverDue, waiting } from "./discover.ts";
import { dueBoards, readBoards, summary } from "./refresh.ts";
import { searchConfig, searchedToday } from "./search.ts";

const NO_INTERNET = "Ended: no internet. The companies it couldn't look at wait for Find their boards now.";

export type Batch = {
  started: string;
  total: number; // companies waiting when it started, and those that came in since
  done: number; // companies looked at
  boards: number; // boards found
  on: string; // what it is doing now, in plain words
  ended?: string;
  why?: string; // how it ended, in plain words
};

const STATE = "batch";
const STOP = "batch:stop";
const ASKED = "batch:after-next-read";
const ROUNDS = 10; // a company sent back to the queue (its website just found) is looked at again
const WAIT_MS = 5_000;
const ROOT = path.resolve(import.meta.dir, "..");
const fmt = (n: number) => n.toLocaleString("en-US");
const companies = (n: number) => `${fmt(n)} compan${n === 1 ? "y" : "ies"}`;

const read = (): Batch | null => {
  const v = getMeta(STATE);
  return v ? (JSON.parse(v) as Batch) : null;
};
const save = (b: Batch) => setMeta(STATE, JSON.stringify(b));
const stopAsked = () => getMeta(STOP) === "1";

/**
 * The batch run as Sources shows it: going (its lock live, or just started), stopped partway (its
 * process died: a crash, the Mac restarted), or ended, with how. Null when there never was one.
 */
export function batchStatus(): (Batch & { running: boolean; partway: boolean; stopping: boolean }) | null {
  const b = read();
  if (!b) return null;
  const live = lockHolder("batch") !== null;
  // Started from the board a moment ago: its process is still taking its lock.
  const starting = !b.ended && Date.now() - Date.parse(b.started) < 30_000;
  const running = live || starting;
  return { ...b, running, partway: !running && !b.ended, stopping: running && stopAsked() };
}

let spawner = (args: string[], log: number) =>
  Bun.spawn(args, { cwd: ROOT, detached: true, stdio: ["ignore", log, log] }).unref();
/** Tests: start nothing real. */
export function setSpawner(fn: typeof spawner): void {
  spawner = fn;
}

/** Start a batch run (or resume one that stopped partway): its own process, detached. */
export async function startBatch(now = new Date()): Promise<string> {
  if (lockHolder("batch") !== null || batchStatus()?.running) return "Already finding boards: see Sources";
  const n = await waitingNow(now);
  if (!n) return "No company is waiting for its job board";
  mkdirSync(path.join(dataDir(), "logs"), { recursive: true });
  const log = openSync(path.join(dataDir(), "logs", "batch.log"), "a");
  try {
    spawner([process.execPath, path.join(ROOT, "bin", "jobsignal.ts"), "find-boards"], log);
  } finally {
    closeSync(log);
  }
  setMeta(STOP, "");
  save({ started: now.toISOString(), total: n, done: 0, boards: 0, on: "starting" });
  return `Finding the boards of ${companies(n)} now: its progress is on Sources`;
}

/** Stop: it ends after the companies in hand. */
export function stopBatch(): string {
  if (!batchStatus()?.running) return "No batch run is going";
  setMeta(STOP, "1");
  return "Stopping after the companies in hand";
}

/** First run's Start with: a batch run once the next read has brought companies in. */
export function askAfterNextRead(on: boolean): void {
  setMeta(ASKED, on ? "1" : "");
}

/** The tick, once its sources are read: the batch run first run asked for, if anything waits. */
export async function startIfAsked(log: (l: string) => void, now = new Date()): Promise<void> {
  if (getMeta(ASKED) !== "1") return;
  setMeta(ASKED, "");
  if (await waitingNow(now)) log(`batch: ${await startBatch(now)}`);
}

/**
 * Companies a run could look at now: a web search due counts only with a search connected and a
 * model to pick, a careers page only while the model can read it.
 */
export async function waitingNow(now = new Date()): Promise<number> {
  return waiting(now, await canTry(now));
}
const canTry = async (now = new Date()) => ({
  search: canUseSmallModel() && (await webSearches()).length > 0,
  pages: canReadPages(now),
});

const names = (cs: Company[]) => {
  const shown = cs.slice(0, 3).map((c) => c.name);
  return cs.length > 3 ? `${shown.join(", ")} and ${cs.length - 3} more` : shown.join(", ");
};

/** Why a run that tried everything it could still leaves companies waiting, in plain words. */
export async function whyEnded(now = new Date()): Promise<string> {
  const left = waiting(now);
  if (!left) return "Done: every company that was waiting has been looked at.";
  const rest = `${companies(left)} still wait${left === 1 ? "s" : ""}; the regular reads go on with them`;
  const via = connection();
  const day = backgroundLeft(now);
  const search = searchConfig();
  if (!via) return `Ended: no model is connected, and web searches and careers pages need one. ${rest}.`;
  if (day && day.left === 0)
    return `Ended: today's limit of ${fmt(day.limit)} background checks is used. ${rest}, from tomorrow.`;
  if (via === "api-key" && !canSpend(0.01))
    return `Ended: this month's spend limit is reached (Settings > Spend). ${rest}.`;
  if (search.on && searchedToday(now) >= search.daily)
    return `Ended: today's limit of ${fmt(search.daily)} web searches is used. ${rest}, from tomorrow.`;
  if (search.on && !(await webSearches()).length)
    return `Ended: no web search is connected, and the rest need one. ${rest}.`;
  if (!canReadPages(now))
    return `Ended: this month's limit for reading careers pages is reached (Settings > Spend). ${rest}.`;
  return `Ended: ${rest}. They can't be tried again yet (a web search didn't answer, or they were just looked at).`;
}

/**
 * The run itself (`jobsignal find-boards`): its lock, then discovery's (waiting for a tick's), then
 * discovery with no time limit, round after round while companies come back to the queue, then a
 * first read of the boards it found.
 */
export async function runBatch(
  log: (l: string) => void = console.log,
  waitMs = WAIT_MS,
): Promise<Batch | null> {
  const release = takeLock("batch");
  if (!release) {
    log("A batch run is already going.");
    return null;
  }
  const was = read();
  const b: Batch = {
    started: new Date().toISOString(),
    total: 0,
    done: 0,
    boards: 0,
    on: "starting",
  };
  // Stop pressed before this process took its lock (the board started it a moment ago) counts.
  if (!(was && !was.ended && Date.now() - Date.parse(was.started) < 30_000)) setMeta(STOP, "");
  save(b);
  const looked = new Set<number>();
  const found = new Set<number>();
  let discovering: (() => void) | null = null;
  try {
    if (!(await online())) {
      b.why = NO_INTERNET;
      log(`batch: ${b.why}`);
      return b;
    }
    // Every model step in it sees whether Claude Code is signed in.
    await checkSignedIn();
    const can = await canTry();
    b.total = waiting(new Date(), can);
    for (discovering = takeLock("discover"); !discovering; discovering = takeLock("discover")) {
      if (stopAsked()) break;
      b.on = "waiting for the regular read to finish looking for boards";
      save(b);
      await Bun.sleep(waitMs);
    }
    log(`batch: ${companies(b.total)} waiting`);
    for (let round = 0; discovering && round < ROUNDS && !stopAsked(); round++) {
      const out = await discoverDue(new Date(), {
        budgetMs: Number.POSITIVE_INFINITY,
        stop: stopAsked,
        clock: () => new Date(),
        watch: {
          on: (step, cs) => {
            b.on = `${step.replace(/^./, (c) => c.toUpperCase())}: ${names(cs)}`;
            b.total = Math.max(b.total, looked.size + waiting(new Date(), can));
            save(b);
            log(`batch: ${b.on}`);
          },
          found: (fs) => {
            for (const f of fs) {
              looked.add(f.companyId);
              if (f.board) found.add(f.companyId);
            }
            b.done = looked.size;
            b.boards = found.size;
            b.total = Math.max(b.total, b.done);
            save(b);
            markChanged();
          },
        },
      });
      if (!out.length) break;
    }
    // Finding boards is done: a tick may look for them again.
    discovering?.();
    discovering = null;
    // The boards it found, read now rather than at the next tick (one a tick took meanwhile isn't due).
    const due = dueBoards(new Date()).filter((x) => found.has(x.company_id));
    if (due.length) {
      b.on = `Reading the ${fmt(due.length)} boards it found`;
      save(b);
      log(`batch: new boards: ${summary(await readBoards(due, new Date()))}`);
    }
    // The internet went partway: what it couldn't look at waits, uncounted (intake/discover.ts).
    b.why = stopAsked()
      ? `Stopped: ${companies(b.done)} looked at. Find their boards now goes on from there.`
      : (await online())
        ? await whyEnded()
        : NO_INTERNET;
  } catch (err) {
    failure("batch", "find-boards", err);
    b.why = `It stopped on an error: ${(err as Error).message.slice(0, 160)}`;
  } finally {
    discovering?.();
    b.on = "";
    b.ended = new Date().toISOString();
    save(b);
    setMeta(STOP, "");
    markChanged();
    release();
  }
  log(`batch: ${b.why} (${companies(b.done)} looked at, ${fmt(b.boards)} boards found)`);
  return b;
}

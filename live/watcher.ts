// Folders → watcher → SQLite → event. The only path by which the board learns of change.
import { type FSWatcher, readdirSync, watch } from "node:fs";
import path from "node:path";
import { getMeta } from "../core/db.ts";
import { paths } from "../core/paths.ts";
import { failure } from "../core/trace.ts";
import { companyOfThread, isStandIn, threadIdOf } from "../intake/companies.ts";
import { changed, emit } from "../server/hub.ts";
import { adopt, waiting } from "../worker/website.ts";

/**
 * Move each stand-in thread whose company now has a website (found by the tick's discovery, not
 * by Work) to the company's real thread. One waiting for its website is findWebsite's.
 */
export function adoptStandIns(): void {
  try {
    for (const t of readdirSync(paths.threads()).filter(isStandIn)) {
      if (waiting(t)) continue;
      const c = companyOfThread(t);
      if (c?.domain) adopt(t, threadIdOf(c));
    }
  } catch (err) {
    failure("watcher", "adopt stand-ins", err);
  }
}

export function startWatcher(): () => void {
  const timers = new Map<string, Timer>();
  const debounce = (key: string, fn: () => void) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, 80),
    );
  };

  const watchers: FSWatcher[] = [];
  watchers.push(
    watch(paths.threads(), { recursive: true }, (_event, file) => {
      if (!file) return;
      const id = String(file).split("/")[0]!;
      if (String(file).endsWith("log.jsonl") || !String(file).includes("/")) {
        debounce(id, () => changed(id));
      }
    }),
  );
  watchers.push(
    watch(path.dirname(paths.sourceState()), () => debounce("rail", () => emit("rail.changed", {}))),
  );
  // The Inbox lives in jobsignal.db, written by the tick from another process too. Each write
  // that changes what the Inbox shows stamps meta.intake_changed_at: one cheap read every 2s. A
  // change may have given a stand-in's company its website.
  let seen = getMeta("intake_changed_at");
  const poll = setInterval(() => {
    const at = getMeta("intake_changed_at");
    if (at !== seen) {
      seen = at;
      adoptStandIns();
      emit("inbox.changed", {});
    }
  }, 2000);

  return () => {
    clearInterval(poll);
    for (const w of watchers) w.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}

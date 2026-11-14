// Work, now: the gather and the model run happen in the server, one thread at a time, with a
// progress line on the thread. A Work pressed while a run is going is next in line: runs go back
// to back in the order pressed. The chain stops when no run can start, when another process holds
// the run (the nightly queue), or after two runs in a row that didn't finish; the nightly queue
// takes what's left. A restart picks the line up again.

import * as index from "../core/index-db.ts";
import { failure } from "../core/trace.ts";
import { isStandIn } from "../core/vocab.ts";
import { decide } from "../decisions/decide.ts";
import { changed, emit } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { queue } from "./queue.ts";
import { canStart, type RunResult, runWorker } from "./run.ts";
import { findWebsite, waiting } from "./website.ts";

let running: { id: string; line: string } | null = null;
let failed = 0; // runs in a row that didn't finish

function progress(id: string, line: string | null) {
  running = line === null ? null : { id, line };
  emit("work.progress", { id, line });
}

/** One run; when it ends, the next in line starts (its own promise isn't awaited here). */
export function start(id: string, chained = false): Promise<void> {
  if (!chained) failed = 0;
  progress(id, "starting");
  let r: RunResult | null = null;
  return runWorker(id, (line) => progress(id, line))
    .then((x) => {
      r = x;
    })
    .catch((err) => failure("worker", id, err))
    .finally(() => {
      progress(id, null);
      changed(id);
      next(r);
    });
}

function next(r: RunResult | null): void {
  if (r?.reason === "already running") return;
  failed = r?.ok ? 0 : failed + 1;
  if (failed >= 2 || canStart()) return;
  const id = queue()[0];
  if (id) void start(id, true);
}

/** The stand-in's website looked for; found, its thread (moved) runs now or takes its turn. */
function lookThenWork(standIn: string): void {
  void findWebsite(standIn).then((to) => {
    changed(standIn);
    if (!to) return;
    changed(to);
    if (!running && !canStart()) void start(to);
  });
}

/** Resolves once no run is going: for tests. */
export function idle(): Promise<void> {
  return new Promise((done) => {
    const check = () => (running ? setTimeout(check, 20) : done());
    check();
  });
}

export const feature: ServerFeature = {
  name: "worker",
  routes: {
    "/api/work": { GET: () => Response.json({ running, queued: queue().length }) },
    "/api/work/:id": {
      POST: (req) => {
        const id: string = req.params.id;
        // Nothing enters "researching" when no run could start, now or tonight.
        const why = canStart();
        if (why) return Response.json({ toast: why }, { status: 400 });
        // A company known only by its name: its website is looked for first, then Work runs.
        if (isStandIn(id)) {
          const r = decide(id, { action: "work" });
          if (!r.ok) return Response.json({ toast: r.toast }, { status: r.status });
          changed(id);
          lookThenWork(id);
          const name = r.toast.replace(/^Researching · /, "");
          return Response.json({ toast: `Looking for ${name}'s website · Work starts when it's found` });
        }
        // "tonight" is the log's word for next in line (entries from before the chain keep it).
        const later = running !== null;
        const r = decide(id, { action: "work", ...(later ? { tonight: true } : {}) });
        if (!r.ok) return Response.json({ toast: r.toast }, { status: r.status });
        changed(id);
        if (!later) void start(id);
        return Response.json({ toast: r.toast });
      },
    },
  },
  // After a restart (which ends a run going, or a website being looked for), both start again.
  start: () => {
    const t = setTimeout(() => {
      for (const s of index.all()) if (waiting(s.id)) lookThenWork(s.id);
      if (running || canStart()) return;
      const id = queue()[0];
      if (id) void start(id);
    }, 10_000);
    (t as { unref?: () => void }).unref?.();
    return () => clearTimeout(t);
  },
};

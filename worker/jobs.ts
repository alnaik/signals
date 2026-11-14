import type { Job } from "../intake/types.ts";
import { queue } from "./queue.ts";
import { runWorker } from "./run.ts";

/** The nightly pass: whatever is still in line, read again after each run so a Work pressed
 * meanwhile is taken too. A run going in the board means the board is working through the line. */
export async function runQueue(): Promise<string> {
  let done = 0;
  const tried = new Set<string>();
  for (let id = queue()[0]; id; id = queue().find((x) => !tried.has(x))) {
    tried.add(id);
    const r = await runWorker(id);
    if (r.reason === "already running") return `${done} runs; the board is running the line`;
    if (r.reason?.startsWith("No model connected") || r.reason?.includes("isn't installed")) {
      return `${done} runs; stopped: ${r.reason}`;
    }
    if (r.ok) done++;
  }
  return `${done} runs`;
}

export const jobs: Job[] = [{ name: "worker", schedule: "nightly", run: runQueue }];

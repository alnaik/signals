// The file watcher picks up a dropped file as soon as it has finished writing.
import { existsSync, statSync, watch } from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.ts";
import type { ServerFeature } from "../server/types.ts";
import { backlogLines, requestSort } from "./backlog.ts";
import { pendingFiles, processFile } from "./process.ts";

let chain = Promise.resolve();
const queued = new Set<string>();

async function settled(file: string): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    if (size === last && size > 0) return true;
    last = size;
    await Bun.sleep(300);
  }
  return existsSync(file);
}

export function enqueue(file: string): void {
  if (queued.has(file)) return;
  queued.add(file);
  chain = chain.then(async () => {
    try {
      if (await settled(file)) await processFile(file);
    } finally {
      queued.delete(file);
    }
  });
}

export const feature: ServerFeature = {
  name: "dropfolder",
  start: () => {
    for (const f of pendingFiles()) enqueue(f);
    const w = watch(paths.drop(), (_event, name) => {
      if (!name) return;
      const file = path.join(paths.drop(), String(name));
      if (pendingFiles().includes(file)) enqueue(file);
    });
    return () => w.close();
  },
  routes: {
    // Sort now on a parked drop: the tick does the work, a step at a time.
    "/api/backlogs/:bid/sort": {
      POST: (req) => {
        const id = Number(req.params.bid);
        if (!backlogLines().find((b) => b.id === id)?.sort || !requestSort(id))
          return Response.json({ toast: "That can't be sorted now" }, { status: 409 });
        return Response.json({ toast: "Sorting starts with the next tick, within 15 minutes" });
      },
    },
  },
};

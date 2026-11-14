import type { Job } from "../intake/types.ts";
import { sortBacklogs } from "./backlog.ts";
import { processAll } from "./process.ts";

// The server's watcher handles drops as they land; this catches anything left, nightly.
// A big drop's backlog, once Sort now is pressed, moves on every tick.
export const jobs: Job[] = [
  {
    name: "drop-folder",
    schedule: "nightly",
    run: async () => `${(await processAll()).length} files`,
  },
  { name: "drop-backlogs", schedule: "every_tick", run: () => sortBacklogs() },
];

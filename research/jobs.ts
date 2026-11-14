import type { Job } from "../intake/types.ts";
import { runWatches } from "./actions.ts";

export const jobs: Job[] = [{ name: "watched-searches", schedule: "nightly", run: runWatches }];

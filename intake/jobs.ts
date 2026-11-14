import { classifyPending } from "./classify.ts";
import type { Job } from "./types.ts";

export const jobs: Job[] = [{ name: "classify-pending", schedule: "nightly", run: classifyPending }];

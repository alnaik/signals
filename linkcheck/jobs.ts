import type { Job } from "../intake/types.ts";
import { checkOpenThreads } from "./check.ts";

export const jobs: Job[] = [{ name: "linkcheck", schedule: "nightly", run: checkOpenThreads }];

import type { Job } from "../intake/types.ts";
import { prune } from "./lookup.ts";

/** Nightly: the last 50 lookups kept, and the emails found 30 days, unless saved to a thread. */
function pruneLookups(): string {
  const { deleted, dropped } = prune();
  return `${deleted} lookups dropped · ${dropped} emails dropped`;
}

export const jobs: Job[] = [{ name: "lookups", schedule: "nightly", run: pruneLookups }];

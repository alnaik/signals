import { open } from "../core/db.ts";
import type { Job } from "../intake/types.ts";

/** Nightly: the search's index of descriptions merged into one, so a search reads one segment, not hundreds. */
function optimize(): string {
  open().exec("INSERT INTO role_fts (role_fts) VALUES ('optimize')");
  return "descriptions index tidied";
}

export const jobs: Job[] = [{ name: "search-index", schedule: "nightly", run: optimize }];

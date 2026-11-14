// Which threads the worker owes a run: Work was pressed and no run has finished since.
// Runs go back to back (the board's line by day, the nightly pass for what's left), so the
// prompt cache stays warm.
import * as index from "../core/index-db.ts";
import { read } from "../core/log.ts";
import { isRunNote, isStandIn } from "../core/vocab.ts";

const MAX_ATTEMPTS = 2;

export function owed(id: string): boolean {
  const log = read(id);
  const work = log.findLast((e) => e.kind === "decision" && e.data.action === "work");
  if (!work) return false;
  const after = log.slice(log.indexOf(work) + 1);
  if (after.some((e) => isRunNote(e, "run_done"))) return false;
  const stops = after.filter((e) => isRunNote(e, "run_incomplete"));
  // A final stop never got going (no binary, no key): trying again tonight won't help.
  if (stops.some((e) => e.data.final)) return false;
  return stops.length < MAX_ATTEMPTS;
}

export function queue(): string[] {
  return (
    index
      .all()
      // A stand-in waits for its website (worker/website.ts): with none, there's nothing to research.
      .filter((s) => s.status === "researching" && !isStandIn(s.id))
      .sort((a, b) => a.statusSince.localeCompare(b.statusSince))
      .map((s) => s.id)
      .filter((id) => owed(id))
  );
}

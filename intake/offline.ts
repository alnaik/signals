// `jobsignal repair offline <from> <to>`: undo what a span with no internet marked, from before
// reads skipped themselves offline (core/online.ts). Its boards are picked from the failures log:
// a board read that failed at the network level inside the span, still carrying that error. They
// are read again at the next tick, as new (status ok, no fails); a company their failures sent
// back to discovery keeps its board instead. Companies whose discovery found nothing inside the
// span go back in line as Sources' Try again does it. The span is remembered, so the problems
// list leaves its network failures out. Boards broken for any other reason are untouched.
import { markChanged, open, tx } from "../core/db.ts";
import { networkError, rememberSpan } from "../core/online.ts";
import { failures } from "../core/trace.ts";
import { again } from "../sources/pipeline.ts";

export type OfflineRepair = {
  boards: number; // read again as new
  broken: number; // of them, marked broken
  kept: number; // companies sent back to discovery by those failures, keeping their board
  companies: number; // companies whose nothing-found went back in line
  theirs: number; // boards of those companies not working, read again with them (as Try again does)
};

export function repairOffline(from: Date, to: Date, o: { dry?: boolean; now?: Date } = {}): OfflineRepair {
  const [a, b] = [from.toISOString(), to.toISOString()];
  const now = o.now ?? new Date();
  const failed = new Set(
    failures(from)
      .filter((f) => f.ts <= b && f.area === "refresh" && networkError(f.error))
      .map((f) => Number(f.context?.board))
      .filter((id) => id > 0),
  );
  const d = open();
  const boards = (
    d
      .query(
        `SELECT id, company_id, status, last_error FROM boards WHERE id IN (${[...failed].join(",") || 0})`,
      )
      .all() as { id: number; company_id: number; status: string; last_error: string | null }[]
  ).filter((x) => networkError(x.last_error));
  const owners = [...new Set(boards.map((x) => x.company_id))];
  const requeued = (
    d
      .query(
        `SELECT id, discovery_note FROM companies WHERE discovery = 'queued' AND id IN (${owners.join(",") || 0})`,
      )
      .all() as { id: number; discovery_note: string | null }[]
  ).filter((c) => /^board failed \d+ reads: /.test(c.discovery_note ?? "") && networkError(c.discovery_note));
  const nothing = (
    d
      .query(
        "SELECT id FROM companies WHERE discovery IN ('none', 'unreadable') AND discovery_at >= ? AND discovery_at <= ?",
      )
      .all(a, b) as { id: number }[]
  ).map((c) => c.id);
  const out = {
    boards: boards.length,
    broken: boards.filter((x) => x.status === "broken").length,
    kept: requeued.length,
    companies: nothing.length,
    theirs: (
      d
        .query(
          `SELECT count(*) AS n FROM boards WHERE status <> 'ok' AND company_id IN (${nothing.join(",") || 0})`,
        )
        .get() as { n: number }
    ).n,
  };
  if (o.dry) return out;
  tx(() => {
    const iso = now.toISOString();
    for (const x of boards)
      d.query(
        "UPDATE boards SET status = 'ok', fails = 0, last_error = NULL, next_read_at = ? WHERE id = ?",
      ).run(iso, x.id);
    for (const c of requeued)
      d.query("UPDATE companies SET discovery = 'found', discovery_note = NULL WHERE id = ?").run(c.id);
    rememberSpan({ from: a, to: b });
    markChanged(now);
  });
  again("board", nothing, now);
  return out;
}

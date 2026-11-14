// Every button on a thread becomes one `decision` entry in its log.
// Rules here are the ones the board can't be trusted to enforce alone.

import { open } from "../core/db.ts";
import { derive } from "../core/derive.ts";
import { ACTIONS, type Action, append, type Entry, read } from "../core/log.ts";
import { applyEmailOf, companyOfThread } from "../intake/companies.ts";

// `close` stays in the log's words (the past-applications import writes it), but no button sends it.
const BOARD_ACTIONS: readonly Action[] = ACTIONS.filter((a) => a !== "close");

export type DecisionResult =
  | { ok: true; entry: Entry; toast: string; company?: number } // company: its board's role changed too
  | { ok: false; status: number; toast: string };

// biome-ignore lint/suspicious/noExplicitAny: request body is validated field by field
export function decide(id: string, body: Record<string, any>, now = new Date()): DecisionResult {
  const action = body.action as Action;
  if (!BOARD_ACTIONS.includes(action)) return { ok: false, status: 400, toast: `Unknown action: ${action}` };
  const log = read(id);
  if (log.length === 0) return { ok: false, status: 404, toast: "No such thread" };
  const t = derive(log, now);
  const name = t.company || id;
  const closed = t.status === "closed";
  const no = (toast: string, status = 409) => ({ ok: false as const, status, toast });

  const data: Record<string, unknown> = { action };
  let toast = "";
  switch (action) {
    case "apply":
    case "applied":
    case "drop": {
      const role = t.roles.find((r) => r.key === body.url);
      if (!role) return no("No such role on this thread", 400);
      if (action === "applied" && role.status === "applied") return no("Already marked applied");
      if (action === "drop" && role.status === "dismissed") return no("Already dismissed");
      data.url = role.key;
      toast = `${action === "drop" ? "Dismissed" : action === "applied" ? "Applied" : "Applying"} · ${role.title}`;
      break;
    }
    case "work":
      if (closed) return no("This thread is closed");
      if (t.status === "researching") return no("Already researching");
      if (body.tonight) data.tonight = true;
      toast = body.tonight ? `Next in line · ${name}` : `Researching · ${name}`;
      break;
    case "mark_sent":
      if (closed) return no("This thread is closed");
      if (body.channel) data.channel = String(body.channel);
      // No person found and the company takes applications by email: that's how it went.
      else if (!t.contact && hasApplyEmail(id)) data.channel = "email";
      toast = `Marked sent · ${name}`;
      break;
    case "got_reply":
      if (closed) return no("This thread is closed");
      if (body.text) data.text = String(body.text);
      toast = `Reply noted · ${name}`;
      break;
    case "copy":
      if (body.what) data.what = String(body.what);
      toast = "Copied";
      break;
  }
  const entry = append(id, { actor: "board", kind: "decision", data });
  const company =
    action === "apply" || action === "applied" || action === "drop"
      ? roleFollows(id, data.url as string, action, now)
      : undefined;
  return { ok: true, entry, toast, ...(company ? { company } : {}) };
}

/**
 * A role chosen, applied to or dismissed on the thread is so on its company's board too, so the
 * Watchlist page shows what the thread says (Apply, then Dismiss on the thread, left it "applied").
 * Returns the company when a role changed.
 */
function roleFollows(
  thread: string,
  url: string,
  action: "apply" | "applied" | "drop",
  now: Date,
): number | undefined {
  const c = companyOfThread(thread);
  if (!c) return undefined;
  const [state, from] =
    action === "drop"
      ? ["dismissed", "'new', 'archived', 'applied'"]
      : ["applied", "'new', 'archived', 'dismissed'"];
  const r = open()
    .query(
      `UPDATE roles SET state = $state, state_at = $now WHERE company_id = $company AND url = $url AND state IN (${from})`,
    )
    .run({ state, now: now.toISOString(), company: c.id, url });
  return r.changes > 0 ? c.id : undefined;
}

function hasApplyEmail(thread: string): boolean {
  const c = companyOfThread(thread);
  return !!(c && applyEmailOf(c));
}

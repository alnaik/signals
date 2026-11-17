// The log's stable vocabulary. Browser-safe: the board imports it too.
// Old logs also hold hypothesis, talking_points, proof and problem_tag: read, never written.
export const KINDS = [
  "signal",
  "fact",
  "contact",
  "apply",
  "decision",
  "sent",
  "reply",
  "research",
  "note",
] as const;
export type Kind = (typeof KINDS)[number];

// Every decision a thread's log can hold. `apply`, `applied` and `drop` name a role by its url.
// `close` is written only by the past-applications import; the board has no Close button.
// `remove_contact` takes back one saved person: `entry` names their contact entry (the log is
// append-only, so a Remove is a line of its own).
export const ACTIONS = [
  "apply",
  "applied",
  "drop",
  "work",
  "mark_sent",
  "got_reply",
  "close",
  "copy",
  "remove_contact",
] as const;
export type Action = (typeof ACTIONS)[number];

// The status words, all of them. A role: chosen, applied, taken down, or dismissed.
export const ROLE_STATUS = ["apply", "applied", "gone", "dismissed"] as const;
export type RoleStatus = (typeof ROLE_STATUS)[number];
// A thread: the research is running, it named someone, you wrote, they wrote back, it's over.
export const THREAD_STATUS = ["researching", "person found", "sent", "replied", "closed"] as const;
export type ThreadStatus = (typeof THREAD_STATUS)[number];

// A thread named for a company whose website isn't known yet (acme.no-domain).
export const isStandIn = (thread: string) => thread.endsWith(".no-domain");

// A Work run's end: "run_done" or "run_incomplete", counted only when the worker wrote it. Any
// other writer's note with the same event (a spread, an import, a future tool) ends nothing.
export const RUN_EVENTS = ["run_done", "run_incomplete"] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];
export function isRunNote(
  e: { kind: string; actor: string; data: { event?: unknown } },
  event: RunEvent,
): boolean {
  return e.kind === "note" && e.actor === "worker" && e.data?.event === event;
}

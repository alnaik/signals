// The server's change hub. Anything that learns a thread changed calls `changed(id)`:
// the index is re-derived from the folder, then listeners (the live stream) are told.
import * as index from "../core/index-db.ts";

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();

export function listen(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event: string, data: unknown): void {
  for (const fn of listeners) fn(event, data);
}

/** A line for the board's toast, from work that finished after the request that started it. */
export function toast(text: string): void {
  emit("toast", { text });
}

export function changed(id: string): void {
  index.reindex(id);
  emit("thread.changed", { id });
}

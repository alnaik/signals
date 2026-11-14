// The Work run's progress line, shared by the thread's row and its drawer. One stream for the
// page: the server says which thread it's on and what it's reading.
import { useSyncExternalStore } from "react";

let running: { id: string; line: string } | null = null;
const subs = new Set<() => void>();
const tell = () => {
  for (const f of subs) f();
};

if (typeof window !== "undefined") {
  fetch("/api/work")
    .then((r) => (r.ok ? r.json() : null))
    .then((w) => {
      running = w?.running ?? null;
      tell();
    })
    .catch(() => {});
  window.addEventListener("work.progress", (e) => {
    const p = (e as CustomEvent<{ id: string; line: string | null }>).detail;
    running = p.line === null ? null : { id: p.id, line: p.line };
    tell();
  });
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useWorkLine(id: string): string | null {
  return useSyncExternalStore(subscribe, () => (running?.id === id ? running.line : null));
}

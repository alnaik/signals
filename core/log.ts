// The thread log: one JSON object per line, append-only. It is the source of truth
// and the trace; everything else (index, board) is derived from it.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import { paths } from "./paths.ts";
import { ulid } from "./ulid.ts";
import { ACTIONS, KINDS, type Kind } from "./vocab.ts";

export { ACTIONS, type Action, KINDS, type Kind } from "./vocab.ts";

export type Source = {
  url?: string;
  quote?: string;
  fetched_at?: string;
  provider?: string;
  type: "page" | "provider_record";
};

export type Entry = {
  id: string;
  ts: string;
  actor: string;
  kind: Kind;
  // biome-ignore lint/suspicious/noExplicitAny: entry payloads vary by kind
  data: Record<string, any>;
  source?: Source;
  refs: string[];
};

export type NewEntry = Omit<Entry, "id" | "ts" | "refs"> & { ts?: string; refs?: string[] };

/** Thread ids are company domains: lowercase, no scheme, no www, no path. */
export function threadId(domainOrUrl: string): string {
  let d = domainOrUrl.trim().toLowerCase();
  d = d
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "");
  d = d.replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error(`Not a company domain: ${domainOrUrl}`);
  return d;
}

export function validate(e: NewEntry): void {
  if (!KINDS.includes(e.kind)) throw new Error(`Unknown kind: ${e.kind}`);
  if (!e.actor) throw new Error("Entry needs an actor");
  if (e.kind === "decision" && !ACTIONS.includes(e.data?.action)) {
    throw new Error(`Unknown decision action: ${e.data?.action}`);
  }
}

export function append(id: string, e: NewEntry): Entry {
  validate(e);
  const entry: Entry = {
    id: ulid(),
    ts: e.ts ?? new Date().toISOString(),
    actor: e.actor,
    kind: e.kind,
    data: e.data ?? {},
    ...(e.source ? { source: e.source } : {}),
    refs: e.refs ?? [],
  };
  mkdirSync(paths.thread(id), { recursive: true });
  appendLine(paths.log(id), entry);
  return entry;
}

export function read(id: string): Entry[] {
  const file = paths.log(id);
  if (!existsSync(file)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line (crash mid-write) is skipped, never fatal.
    }
  }
  return out;
}

export function exists(id: string): boolean {
  return existsSync(paths.log(id));
}

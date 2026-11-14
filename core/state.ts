// sources/state.json: what the rail shows. Sources record runs; agents record what they're on.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";

export type SourceState = {
  name: string;
  connected: boolean;
  enabled?: boolean;
  lastRun?: string;
  lastOk?: string;
  failures: number; // consecutive
  reason?: string | null;
  stat?: string; // e.g. "3 / 40 kept"
};

export type AgentState = {
  status: "idle" | "working" | "held" | "done";
  line: string;
  at?: string;
};

export type State = { sources: Record<string, SourceState>; agents: Record<string, AgentState> };

export function readState(): State {
  const file = paths.sourceState();
  if (!existsSync(file)) return { sources: {}, agents: {} };
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return { sources: s.sources ?? {}, agents: s.agents ?? {} };
  } catch {
    return { sources: {}, agents: {} };
  }
}

/** Read-modify-write with an atomic rename, so the watcher never sees half a file. */
export function updateState(fn: (s: State) => void): State {
  const s = readState();
  fn(s);
  const file = paths.sourceState();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
  return s;
}

export function setAgent(key: string, status: AgentState["status"], line: string): void {
  updateState((s) => {
    s.agents[key] = { status, line, at: new Date().toISOString() };
  });
}

/** Record one source run. Three consecutive failures turn the source red on the rail. */
export function recordRun(
  key: string,
  name: string,
  result: { ok: boolean; stat?: string; reason?: string },
) {
  updateState((s) => {
    const prev = s.sources[key] ?? { name, connected: true, failures: 0 };
    const now = new Date().toISOString();
    s.sources[key] = result.ok
      ? {
          ...prev,
          name,
          connected: true,
          lastRun: now,
          lastOk: now,
          failures: 0,
          reason: null,
          stat: result.stat,
        }
      : {
          ...prev,
          name,
          connected: true,
          lastRun: now,
          failures: prev.failures + 1,
          reason: result.reason ?? "failed",
        };
  });
}

export function setConnected(key: string, name: string, connected: boolean): void {
  updateState((s) => {
    s.sources[key] = { ...(s.sources[key] ?? { failures: 0 }), name, connected };
  });
}

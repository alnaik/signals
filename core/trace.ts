// logs/failures.jsonl: every failure from a run, source, job, model or board action, in one
// place, with enough context to act on. `jobsignal report` turns it into a bug report.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendLine } from "./jsonl.ts";
import { dataDir } from "./paths.ts";

export type Failure = {
  ts: string;
  area: string; // source, job, ats, worker, model, apply, research, board, ...
  what: string; // which one: a source key, a company domain, a station, a route
  error: string;
  stack?: string;
  context?: Record<string, unknown>;
};

const MAX_BYTES = 2_000_000;
export const failuresFile = () => path.join(dataDir(), "logs", "failures.jsonl");

// Things that look like secrets never reach the log the bug report is made from.
const SECRETS: [RegExp, string][] = [
  [/\b(sk-ant-|sk-|ghp_|gho_|github_pat_|xox[abpr]-|AIza)[\w-]{8,}/g, "$1[redacted]"],
  [/\b(Bearer|Basic|token)\s+[\w.~+/=-]{12,}/gi, "$1 [redacted]"],
  [/([?&](?:key|api_key|apikey|token|access_token|secret|password|sig)=)[^&\s"']+/gi, "$1[redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+_-]{40,}={0,2}/g, "[redacted]"],
];
export function redact(s: string): string {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), s);
}

/** Record one failure. Never throws: tracing must not become a second failure. */
export function failure(area: string, what: string, err: unknown, context?: Record<string, unknown>): void {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const entry: Failure = {
      ts: new Date().toISOString(),
      area,
      what,
      error: redact(e.message).slice(0, 500),
      ...(err instanceof Error && e.stack ? { stack: e.stack.split("\n").slice(1, 7).join("\n") } : {}),
      ...(context ? { context: JSON.parse(redact(JSON.stringify(context))) } : {}),
    };
    const file = failuresFile();
    mkdirSync(path.dirname(file), { recursive: true });
    // Keep the newest half when the file grows past its cap.
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      writeFileSync(file, `${lines.slice(lines.length / 2).join("\n")}\n`);
    }
    appendLine(file, entry);
  } catch {}
}

// Areas logged here that aren't failures: an approved robots.txt exception used, work discovery
// left at its deadline, two companies merged. The bug report leaves them out.
export const EVENTS = new Set(["robots-exception", "deadline", "merge"]);

/** Record one event worth finding later that isn't a failure (an area in EVENTS). Never throws. */
export function event(area: string, what: string, note: string, context?: Record<string, unknown>): void {
  failure(area, what, note, context);
}

export function failures(since: Date): Failure[] {
  if (!existsSync(failuresFile())) return [];
  const iso = since.toISOString();
  return readFileSync(failuresFile(), "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        const f = JSON.parse(l) as Failure;
        return f.ts >= iso ? [f] : [];
      } catch {
        return [];
      }
    });
}

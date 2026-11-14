// Is this Mac on the internet? Asked before a read and when a read fails at the network level, so
// a night with no internet skips its reads instead of counting every board and company it touched
// as failed. Offline only when none of a few hosts the app already talks to resolves; the answer
// is kept for a minute.
import { lookup } from "node:dns/promises";
import { getMeta, setMeta } from "./db.ts";

const HOSTS = ["api.github.com", "boards-api.greenhouse.io", "hacker-news.firebaseio.com"];
const KEEP_MS = 60_000;
const LOOKUP_MS = 3000;

let known: { at: number; on: boolean } | null = null;
let stub: boolean | null = null;

/** Tests: the answer to give, or null for the real one. */
export function setOnline(v: boolean | null): void {
  stub = v;
  known = null;
}

const resolves = (host: string) =>
  Promise.race([
    lookup(host).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), LOOKUP_MS)),
  ]).catch(() => false);

export async function online(): Promise<boolean> {
  if (stub !== null) return stub;
  if (known && Date.now() - known.at < KEEP_MS) return known.on;
  const answers = await Promise.all(HOSTS.map(resolves));
  known = { at: Date.now(), on: answers.some(Boolean) };
  return known.on;
}

/** An error that says the network itself failed (no lookup, no route), not the site. */
export const networkError = (message: string | null | undefined): boolean =>
  /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|FailedToOpenSocket|Unable to connect/i.test(
    message ?? "",
  );

/** Should a failure with this message count? Not when it is the network and the network is down. */
export async function countsAsFailure(message: string | null | undefined): Promise<boolean> {
  return !networkError(message) || (await online());
}

// Spans of time with no internet that `jobsignal repair offline` undid: their network failures
// aren't problems (report/report.ts).
const SPANS = "offline:spans";
export type Span = { from: string; to: string };

export function offlineSpans(): Span[] {
  return JSON.parse(getMeta(SPANS) ?? "[]") as Span[];
}

export function rememberSpan(span: Span): void {
  const all = offlineSpans().filter((s) => s.from !== span.from || s.to !== span.to);
  setMeta(SPANS, JSON.stringify([...all, span]));
}

/** A network failure at this time, inside a span with no internet that was repaired. */
export const inOfflineSpan = (ts: string, error: string, spans = offlineSpans()): boolean =>
  networkError(error) && spans.some((s) => ts >= s.from && ts <= s.to);

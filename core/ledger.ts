// ledger.jsonl: every model and provider call with what it really cost. Spend is never shown on
// the Threads screen; `jobsignal spend` and Settings read this file, and caps.month_usd skips
// paid steps past its limit.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { appendLine } from "./jsonl.ts";
import { paths } from "./paths.ts";

export type LedgerEntry = {
  ts: string;
  kind: "model" | "provider";
  station: string; // worker, apply, classify, linkcheck, research, people, ...
  model?: string;
  provider?: string;
  thread?: string;
  board?: number; // a page read: the board it was read for
  usd: number; // real money only
  notional_usd?: number; // what a subscription run would have cost; never counted
  usage?: Record<string, number>;
  note?: string;
  failed?: boolean; // the call threw; usd is 0 unless it may still have been billed
};

export function record(e: Omit<LedgerEntry, "ts"> & { ts?: string }): LedgerEntry {
  const entry = { ts: new Date().toISOString(), ...e };
  appendLine(paths.ledger(), entry);
  return entry;
}

// Every model call reads the ledger (caps, the day's background calls), and it only grows: what
// was parsed is kept, and only the lines appended since are read. A file replaced or cut shorter
// (its inode, size or first bytes changed) is read whole again.
const HEAD = 256;
let parsed: {
  file: string;
  ino: number;
  head: string;
  offset: number; // bytes read, up to the last whole line
  list: readonly LedgerEntry[];
} | null = null;

const parseLines = (text: string): LedgerEntry[] =>
  text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as LedgerEntry;
        // Lines from before 2026-10-27 put a subscription run's notional cost in `usd`.
        if (e.note === "claude-code-subscription" && e.notional_usd === undefined)
          return [{ ...e, usd: 0, notional_usd: e.usd }];
        return [e];
      } catch {
        return [];
      }
    });

export function entries(): readonly LedgerEntry[] {
  const file = paths.ledger();
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    parsed = null;
    return [];
  }
  try {
    const st = fstatSync(fd);
    const headBuf = Buffer.alloc(Math.min(HEAD, st.size));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString("latin1");
    const same =
      parsed?.file === file &&
      parsed.ino === st.ino &&
      st.size >= parsed.offset &&
      head.startsWith(parsed.head);
    if (same && st.size === parsed!.offset) return parsed!.list;
    const from = same ? parsed!.offset : 0;
    const buf = Buffer.alloc(st.size - from);
    readSync(fd, buf, 0, buf.length, from);
    // Up to the last whole line: a line still being written is read next time.
    const end = buf.lastIndexOf(0x0a) + 1;
    const more = parseLines(buf.subarray(0, end).toString("utf8"));
    const list = same ? (more.length ? [...parsed!.list, ...more] : parsed!.list) : more;
    parsed = { file, ino: st.ino, head, offset: from + end, list };
    return list;
  } finally {
    closeSync(fd);
  }
}

export function spentSince(since: Date): number {
  const iso = since.toISOString();
  return entries()
    .filter((e) => e.ts >= iso)
    .reduce((sum, e) => sum + e.usd, 0);
}

/** The first of this month, local time. */
export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export const monthSpend = (now = new Date()) => spentSince(monthStart(now));

/** What's left of this month's cap. */
export const capLeft = (now = new Date()) => Math.max(0, loadConfig().caps.month_usd - monthSpend(now));

/** May a paid step costing about `usd` run? Never a reason to fail a run: the step is skipped. */
export function canSpend(usd: number, now = new Date()): boolean {
  return monthSpend(now) + usd <= loadConfig().caps.month_usd + 1e-9;
}

/** Local midnight today. */
export function dayStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The small model's background calls today (sorting posts, finding websites and boards, reading
 * careers pages, the employer check…): every model line but Work's own runs.
 */
export function backgroundToday(now = new Date()): number {
  const iso = dayStart(now).toISOString();
  let n = 0;
  for (const e of entries()) if (e.kind === "model" && e.station !== "worker" && e.ts >= iso) n++;
  return n;
}

/** What a spend line is grouped under: the provider, else the model, else the station. */
export const spendKey = (e: LedgerEntry) => e.provider ?? e.model ?? e.station;

/** Real spend summed by spendKey, largest first. */
export function spendBy(list: LedgerEntry[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const e of list) if (e.usd > 0) by[spendKey(e)] = (by[spendKey(e)] ?? 0) + e.usd;
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
}

/** Real spend per calendar month (local time), newest first, with the first ledger date. */
export function spendHistory(): {
  total: number;
  since: string | null;
  months: { month: string; total: number; by: Record<string, number> }[];
} {
  const all = entries();
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of all) {
    const d = new Date(e.ts);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const list = groups.get(month);
    if (list) list.push(e);
    else groups.set(month, [e]);
  }
  const months = [...groups]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, list]) => ({ month, total: list.reduce((s, e) => s + e.usd, 0), by: spendBy(list) }));
  const first = all.map((e) => e.ts).sort()[0];
  return { total: months.reduce((s, m) => s + m.total, 0), since: first?.slice(0, 10) ?? null, months };
}

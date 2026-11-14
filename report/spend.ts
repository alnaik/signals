// What each paid service has used, for Settings and `jobsignal spend`: one row per provider, from
// the provider's own count where it gives one (Context.dev), else from the ledger. Context.dev is
// counted over its own period (from its grant day, the 10th); the rest over the calendar month,
// as the caps are.
import { loadConfig } from "../core/config.ts";
import { entries, type LedgerEntry, monthStart } from "../core/ledger.ts";
import { accountUsage, creditsSince } from "../providers/contextdev.ts";
import type { SpendRow } from "./spend-text.ts";

export { describeRow, type SpendRow } from "./spend-text.ts";

const SUBSCRIPTION = "claude-code-subscription";
const onSubscription = (e: LedgerEntry) => e.kind === "model" && e.note === SUBSCRIPTION;

function sum(list: LedgerEntry[], of: (e: LedgerEntry) => number): Record<string, number> {
  const by: Record<string, number> = {};
  for (const e of list) by[e.station] = (by[e.station] ?? 0) + of(e);
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
}

function row(key: string, label: string, since: Date, list: LedgerEntry[]): SpendRow {
  return {
    key,
    label,
    since: since.toISOString(),
    calls: list.length,
    failed: list.filter((e) => e.failed).length,
    usd: list.reduce((s, e) => s + e.usd, 0),
    by: sum(list, (e) => e.usd),
  };
}

export async function spendNow(now = new Date()): Promise<SpendRow[]> {
  const all = entries();
  const month = monthStart(now);
  const inMonth = all.filter((e) => e.ts >= month.toISOString());
  const rows: SpendRow[] = [];

  const account = await accountUsage(now.getTime());
  const period = account?.periodStart ? new Date(account.periodStart) : month;
  const cd = all.filter((e) => e.provider === "contextdev" && e.ts >= period.toISOString());
  const by = Object.fromEntries(Object.entries(creditsSince(period)).sort((a, b) => b[1] - a[1]));
  rows.push({
    ...row("contextdev", "Context.dev", period, cd),
    by,
    credits: {
      used: account?.used ?? null,
      recorded: Object.values(by).reduce((s, n) => s + n, 0),
      remaining: account?.remaining ?? null,
      refillAt: account?.refillAt ?? null,
      refillCredits: account?.refillCredits ?? null,
      topup: account?.topup ?? false,
      asked: !!account?.periodStart,
    },
  });

  const exa = inMonth.filter((e) => e.provider === "exa");
  rows.push({
    ...row("exa", "Exa", month, exa),
    estimated: exa.filter((e) => e.usage?.estimated).length,
    cap: Number(loadConfig().discovery.exa_month_usd ?? 0) || undefined,
  });

  const models = inMonth.filter((e) => e.kind === "model");
  rows.push(
    row(
      "anthropic",
      "Anthropic API key",
      month,
      models.filter((e) => !onSubscription(e)),
    ),
  );
  const sub = models.filter(onSubscription);
  if (sub.length)
    rows.push({
      ...row("subscription", "Claude Code subscription", month, sub),
      notional: sub.reduce((s, e) => s + (e.notional_usd ?? 0), 0),
      by: sum(sub, () => 1),
    });

  // Any other provider: those that cost money get their own row, the free ones one line of calls.
  const others = new Map<string, LedgerEntry[]>();
  for (const e of inMonth)
    if (e.kind === "provider" && e.provider && e.provider !== "contextdev" && e.provider !== "exa")
      others.set(e.provider, [...(others.get(e.provider) ?? []), e]);
  const free: Record<string, number> = {};
  for (const [name, list] of [...others].sort((a, b) => a[0].localeCompare(b[0])))
    if (list.some((e) => e.usd > 0)) rows.push(row(name, name, month, list));
    else free[name] = list.length;
  if (Object.keys(free).length)
    rows.push({
      key: "free",
      label: "Free lookups",
      since: month.toISOString(),
      calls: Object.values(free).reduce((s, n) => s + n, 0),
      failed: 0,
      usd: 0,
      by: free,
    });
  return rows;
}

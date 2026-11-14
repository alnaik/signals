// A spend row and how it reads: shared by Settings (in the browser) and `jobsignal spend`, so no
// file or database access here.

export type SpendRow = {
  key: string; // "contextdev", "exa", "anthropic", "subscription", another provider's name, or "free"
  label: string;
  since: string; // the start of the window counted
  calls: number;
  failed: number; // calls that threw (an answered error costs nothing)
  usd: number; // real money
  notional?: number; // the subscription: what its runs would have cost, never charged
  estimated?: number; // calls priced from the price list, not the provider's own figure
  cap?: number; // the provider's own monthly cap in config
  by: Record<string, number>; // by station: credits for Context.dev, else dollars (calls for free ones)
  credits?: {
    used: number | null; // Context.dev's own count for its period, every caller of the key included
    recorded: number; // what Job Signal's ledger has for the same period
    remaining: number | null;
    refillAt: string | null;
    refillCredits: number | null;
    topup: boolean;
    asked: boolean; // false: Context.dev didn't answer, so the window is the calendar month
  };
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const n = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) => `$${x.toFixed(2)}`;
const list = (by: Record<string, number>, f: (v: number) => string) =>
  Object.entries(by)
    .map(([k, v]) => `${k} ${f(v)}`)
    .join(" · ");

/** A row as plain lines: the headline, then by station, then what's worth knowing. */
export function describeRow(r: SpendRow): string[] {
  const failed = r.failed ? ` · ${r.failed} failed` : "";
  if (r.key === "contextdev" && r.credits) {
    const c = r.credits;
    const head = c.asked
      ? `${n(c.used ?? 0)} credits used since ${day(r.since)}${c.remaining !== null ? ` · ${n(c.remaining)} left` : ""}${
          c.refillAt && c.refillCredits !== null
            ? ` · refills to ${n(c.refillCredits)} on ${day(c.refillAt)}`
            : ""
        }${c.topup ? " · auto top-up on" : ""}`
      : `${n(c.recorded)} credits since ${day(r.since)} by Job Signal's count (Context.dev didn't answer)`;
    const lines = [head];
    if (Object.keys(r.by).length) lines.push(`by station: ${list(r.by, n)}${failed}`);
    const gap = (c.used ?? 0) - c.recorded;
    if (c.asked && gap > 0)
      lines.push(
        `Context.dev counts ${n(gap)} more than Job Signal's ledger (older rows kept no credit count; scripts run on a copy)`,
      );
    return lines;
  }
  if (r.key === "subscription")
    return [
      `${n(r.calls)} runs this month · not charged (would have cost ${usd(r.notional ?? 0)})`,
      `by station: ${list(r.by, n)}`,
    ];
  if (r.key === "free") return [`${n(r.calls)} calls this month`, `by source: ${list(r.by, n)}`];
  const head = `${usd(r.usd)} this month${r.cap ? ` of ${usd(r.cap)}` : ""} · ${n(r.calls)} calls${failed}${
    r.estimated ? ` · ${n(r.estimated)} estimated from the price list` : ""
  }${r.key === "anthropic" ? " · billed to your Anthropic Console account" : ""}`;
  const by = Object.entries(r.by).filter(([, v]) => v > 0);
  return by.length ? [head, `by station: ${by.map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}`] : [head];
}

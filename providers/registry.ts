// Provider registry and the waterfall. Every call goes through `call`, which records
// its cost in the ledger. Providers are files in providers/ plus MCP tools from config.

import path from "node:path";
import { Glob } from "bun";
import { isLinkedIn } from "../apply/linkedin.ts";
import { loadConfig } from "../core/config.ts";
import { getSecret } from "../core/keychain.ts";
import { canSpend, record } from "../core/ledger.ts";
import { failure } from "../core/trace.ts";
import { mcpProviders } from "./mcp.ts";
import type {
  Capability,
  ContactHit,
  Person,
  PersonRef,
  Provider,
  ReadOpts,
  ReadResult,
  SearchOpts,
  SearchResult,
} from "./types.ts";

const SKIP = new Set([
  "types.ts",
  "registry.ts",
  "mcp.ts",
  "run.ts",
  "jobs.ts",
  "cli.ts",
  "http.ts",
  "contact.ts",
  "kept.ts",
]);
let loaded: Provider[] | null = null;

export async function loadProviders(): Promise<Provider[]> {
  if (loaded) return loaded;
  const files = Array.from(new Glob("*.ts").scanSync({ cwd: import.meta.dir })).filter(
    (f) => !SKIP.has(f) && !f.endsWith(".test.ts"),
  );
  const out: Provider[] = [];
  for (const f of files.sort()) {
    const mod = (await import(path.join(import.meta.dir, f))) as { default?: Provider };
    if (mod.default?.name) out.push(mod.default);
  }
  loaded = [...out, ...mcpProviders()];
  return loaded;
}

/** For tests. */
export function setProviders(list: Provider[] | null): void {
  loaded = list;
}

export function isAvailable(p: Provider): boolean {
  if (p.key && !getSecret(p.key)) return false;
  return p.available ? p.available() : true;
}

export async function getProvider(name: string): Promise<Provider | undefined> {
  return (await loadProviders()).find((p) => p.name === name);
}

type Ctx = { station: string; thread?: string };

// A Work run's provider budget. Paid calls past it, or past the monthly cap, are skipped so the
// waterfall falls through to free providers; what was skipped is kept for the thread to show.
let budget: { usd: number; spent: number } | null = null;
let skips: string[] = [];
export function setRunBudget(usd: number | null): void {
  budget = usd === null ? null : { usd, spent: 0 };
  skips = [];
}
/** The paid steps skipped since the run budget was set ("Hunter skipped · monthly cap"). */
export function skipped(): string[] {
  return [...new Set(skips)];
}

/** A config price override ([provider.<name>] cost = { search = 0.007 }), if there is one. */
function configCost(p: Provider, cap: Capability): number | undefined {
  const v = loadConfig().provider[p.name]?.cost?.[cap];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The price a call is checked against before it runs: config first, then the provider file. */
export function declaredCost(p: Provider, cap: Capability, args: unknown[] = []): number | undefined {
  return configCost(p, cap) ?? p.estimate?.(cap, args) ?? p.cost[cap];
}

// Every paid call checks the monthly cap, whatever path it came from; a run budget only adds a limit.
function affordable(p: Provider, cap: Capability, args: unknown[]): string | null {
  const est = declaredCost(p, cap, args) ?? 0;
  if (est <= 0) return null;
  if (budget && budget.spent + est > budget.usd + 1e-9) return "this run's lookup budget";
  if (!canSpend(est)) return "monthly cap";
  return null;
}

/**
 * Whether a call that threw may still have been billed. An HTTP error the provider answered isn't,
 * except a 404 it processed (Context.dev charges those); a timeout or a dropped connection may
 * have been, so it keeps the estimate.
 */
export function billedFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status === 404;
}

const webLink = (url: string): boolean => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** Run one capability on one provider, recording its cost. */
export async function call<C extends Capability>(
  p: Provider,
  cap: C,
  args: unknown[],
  ctx: Ctx,
): Promise<
  C extends "search"
    ? SearchResult[]
    : C extends "read"
      ? ReadResult
      : C extends "people"
        ? Person[]
        : C extends "contact"
          ? ContactHit[]
          : C extends "map"
            ? SearchResult[]
            : never
> {
  const fn = p[cap] as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (!fn) throw new Error(`${p.name} has no ${cap}`);
  // A page read through a provider is still a page read: never LinkedIn's.
  if (cap === "read" && isLinkedIn(String(args[0]))) throw new Error("LinkedIn pages are never read");
  // And only a web page: never a file or another scheme, which a reader could be handed and open.
  if (cap === "read" && !webLink(String(args[0]))) throw new Error("Only web pages are read");
  const why = affordable(p, cap, args);
  if (why) {
    skips.push(`${p.label} skipped · ${why}`);
    throw new Error(`${p.label} skipped · ${why}`);
  }
  let out: unknown;
  let failed: unknown = null;
  try {
    out = await fn(...args);
    return out as never;
  } catch (err) {
    failed = err ?? new Error("failed");
    throw err;
  } finally {
    const usd = failed && !billedFailure(failed) ? 0 : (p.lastCost?.(out) ?? declaredCost(p, cap, args) ?? 0);
    const usage = failed ? undefined : p.lastUsage?.(out);
    if (budget) budget.spent += usd;
    record({
      kind: "provider",
      station: ctx.station,
      provider: p.name,
      usd,
      ...(usage ? { usage } : {}),
      note: cap,
      ...(failed ? { failed: true } : {}),
      ...(ctx.thread ? { thread: ctx.thread } : {}),
    });
  }
}

export async function ordered(cap: Capability): Promise<Provider[]> {
  const all = (await loadProviders()).filter((p) => typeof p[cap] === "function" && isAvailable(p));
  const order = loadConfig().providers[cap] ?? [];
  const rank = (p: Provider) => {
    const i = order.indexOf(p.name);
    return i < 0 ? order.length : i;
  };
  // Only providers named in the order run in the waterfall; others run when asked for by name.
  return all.filter((p) => order.includes(p.name)).sort((a, b) => rank(a) - rank(b));
}

/** The providers side by side, in one line, beside their price lines (checked 12 Nov 2026). */
export const PRICE_NOTE =
  "Context.dev is the only one that covers everything Job Signal asks for: web search, page reading, company and people lookups. After the free allowance it is also the cheapest web search ($0.002), then Parallel ($0.005).";

/**
 * The web searches connected, in the [providers] search order: keyed ones only (HN's and GitHub's
 * searches aren't the web). Board search and discovery's web search both run on these.
 */
export const webSearches = async (): Promise<Provider[]> => (await ordered("search")).filter((p) => p.key);

export type WaterfallStep<T> = { provider: string; result?: T; error?: string };

/** Try providers in the configured order; stop at the first confident result. */
export async function waterfall<T>(
  cap: Capability,
  args: unknown[],
  ctx: Ctx,
  confident: (r: T) => boolean,
): Promise<{ result: T | null; by: string | null; steps: WaterfallStep<T>[] }> {
  const steps: WaterfallStep<T>[] = [];
  let best: { r: T; by: string } | null = null;
  for (const p of await ordered(cap)) {
    try {
      const r = (await call(p, cap, args, ctx)) as T;
      steps.push({ provider: p.name, result: r });
      if (confident(r)) return { result: r, by: p.name, steps };
      best ??= { r, by: p.name };
    } catch (err) {
      steps.push({ provider: p.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!best && steps.some((s) => s.error))
    failure("provider", `${cap} (${ctx.station})`, steps.map((s) => `${s.provider}: ${s.error}`).join("; "), {
      ...(ctx.thread ? { thread: ctx.thread } : {}),
    });
  return { result: best?.r ?? null, by: best?.by ?? null, steps };
}

export const search = (q: string, opts: SearchOpts, ctx: Ctx) =>
  waterfall<SearchResult[]>("search", [q, opts], ctx, (r) => r.length > 0);
export const read = (url: string, opts: ReadOpts, ctx: Ctx) =>
  waterfall<ReadResult>("read", [url, opts], ctx, (r) => r.text.trim().length > 200);
export const people = (domain: string, roles: string[], ctx: Ctx, company?: string) =>
  waterfall<Person[]>("people", [domain, roles, company], ctx, (r) => r.length > 0);
export const contact = (person: PersonRef, ctx: Ctx) =>
  waterfall<ContactHit[]>("contact", [person], ctx, (r) => r.some((h) => h.confidence === "verified"));

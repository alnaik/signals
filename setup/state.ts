// First-run setup, shown once before the queue exists. Daily settings stay in config.toml.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pdfs } from "../apply/me.ts";
import { loadFilters } from "../ats/filters.ts";
import { loadConfig } from "../core/config.ts";
import { getSecret, setSecret } from "../core/keychain.ts";
import { entries, monthSpend, monthStart, spendHistory } from "../core/ledger.ts";
import { claudeSignedIn, connection } from "../core/model.ts";
import { dataDir, ensureLayout, isCloudSynced, paths, saveDataDir } from "../core/paths.ts";
import { updateState } from "../core/state.ts";
import { isConnected as gmailConnected } from "../gmail/client.ts";
import { declaredCost, isAvailable, loadProviders, PRICE_NOTE } from "../providers/registry.ts";
import type { Capability } from "../providers/types.ts";
import { spendNow } from "../report/spend.ts";
import { isConnected as xConnected } from "../xapi/client.ts";

const doneFile = () => path.join(dataDir(), "setup.json");

export const KEYS = [
  {
    name: "anthropic",
    label:
      "Anthropic API key (runs the model when Claude Code isn't signed in, or when picked; billed per token)",
  },
  { name: "contextdev", label: "Context.dev (web search, page reading, company and people lookups)" },
  { name: "parallel", label: "Parallel (web search, people and email lookups)" },
  { name: "exa", label: "Exa (web search and page reading)" },
  { name: "firecrawl", label: "Firecrawl (web search and page reading)" },
  { name: "hunter", label: "Hunter (finds a person's work email)" },
  { name: "github", label: "GitHub token (optional: lets more GitHub lookups run each hour)" },
  { name: "x_client_id", label: "X app's client ID (for your bookmarks; then press Connect X below)" },
  { name: "gmail_client_id", label: "Gmail app's client ID (steps on Sources > Gmail replies)" },
  { name: "gmail_client_secret", label: "Gmail app's client secret (then press Connect Gmail below)" },
  {
    name: "job_mail_password",
    label:
      "Job mail: the spare mailbox's app password (never your main mailbox's); set it on Sources > Job mail",
  },
];

export function isDone(): boolean {
  return existsSync(doneFile());
}

export function finish(): void {
  writeFileSync(doneFile(), JSON.stringify({ done: new Date().toISOString() }));
}

/** Who pays for background runs: written to config.toml's [runner] section. */
export function setRunnerMode(mode: string): void {
  if (!["claude-code-api-key", "claude-code-subscription"].includes(mode))
    throw new Error("Unknown runner mode");
  const f = paths.config();
  let text = existsSync(f) ? readFileSync(f, "utf8") : "";
  if (/^\[runner\]/m.test(text))
    text = text.replace(/(^\[runner\][^[]*?^mode\s*=\s*)"[^"]*"/m, `$1"${mode}"`);
  if (!/^\[runner\][\s\S]*?^mode\s*=/m.test(text)) text += `\n[runner]\nmode = "${mode}"\n`;
  writeFileSync(f, text);
}

// config.toml edits keep the file as written: one section's lines change, the rest stays.
function editSection(text: string, header: string, edit: (body: string) => string): string {
  const esc = header.replace(/[.[\]]/g, "\\$&");
  const head = new RegExp(`^${esc}[ \t]*(#.*)?$\n?`, "m").exec(text);
  if (!head) {
    const body = edit("");
    return body.trim() ? `${text.replace(/\n*$/, text ? "\n\n" : "")}${header}\n${body}` : text;
  }
  const start = head.index + head[0].length;
  const next = /^\[/m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  const body = edit(text.slice(start, end));
  // A section left with nothing in it goes.
  if (!body.trim()) return text.slice(0, head.index) + text.slice(end).replace(/^\n+/, "");
  return text.slice(0, start) + body + text.slice(end);
}

function writeConfig(text: string): void {
  Bun.TOML.parse(text); // never write a file the next load can't read
  writeFileSync(paths.config(), text);
}
const configText = () => (existsSync(paths.config()) ? readFileSync(paths.config(), "utf8") : "");

export const CAPS: Capability[] = ["search", "read", "people", "contact"];

/** The waterfall order for one capability: rewrites that one line of [providers]. */
export async function setProviderOrder(cap: string, order: unknown): Promise<void> {
  if (!CAPS.includes(cap as Capability)) throw new Error("Unknown capability");
  if (!Array.isArray(order)) throw new Error("order must be a list");
  const all = await loadProviders();
  const names = [...new Set(order.map(String))];
  for (const n of names)
    if (!all.some((p) => p.name === n && typeof p[cap as Capability] === "function"))
      throw new Error(`Unknown provider for ${cap}: ${n}`);
  const line = `${cap} = [${names.map((n) => JSON.stringify(n)).join(", ")}]`;
  const re = new RegExp(`^${cap}\\s*=\\s*\\[[^\\]]*\\]`, "m");
  writeConfig(
    editSection(configText(), "[providers]", (body) =>
      re.test(body) ? body.replace(re, line) : `${line}\n${body}`,
    ),
  );
}

const orderOf = (cap: Capability) => [...(loadConfig().providers[cap] ?? [])];

/**
 * A lookup provider whose key was just saved joins the order of each of its web capabilities
 * (search, read) it isn't in yet, last: one connected with nothing else is then used, without
 * editing config.toml. Never moved ahead of what is there.
 */
export async function joinOrders(name: string): Promise<void> {
  const p = (await loadProviders()).find((x) => x.name === name);
  if (!p) return;
  for (const cap of ["search", "read"] as const)
    if (typeof p[cap] === "function" && !orderOf(cap).includes(name))
      await setProviderOrder(cap, [...orderOf(cap), name]);
}

/** The Sources screen's pick: this provider first for web search and page reading. */
export async function useFirst(name: string): Promise<void> {
  const p = (await loadProviders()).find((x) => x.name === name);
  if (!p) throw new Error("Unknown provider");
  for (const cap of ["search", "read"] as const)
    if (typeof p[cap] === "function")
      await setProviderOrder(cap, [name, ...orderOf(cap).filter((n) => n !== name)]);
}

// The limits a person sets in Settings, each one line of config.toml: [section] key, and what it is.
// Dollars, except a `count` (whole numbers): the background checks a day, board search's searches.
export const LIMITS: { section: string; key: string; label: string; count?: boolean }[] = [
  { section: "caps", key: "month_usd", label: "Real money a month, everything together" },
  { section: "caps", key: "run_usd", label: "One Work run's model, on an API key" },
  { section: "caps", key: "run_provider_usd", label: "One Work run's paid lookups" },
  { section: "caps", key: "pages_month_usd", label: "Reading careers pages with the small model, a month" },
  { section: "discovery", key: "exa_month_usd", label: "Exa searches, a month" },
  {
    section: "caps",
    key: "background_day",
    label: "Background model checks a day, on a Claude subscription (a count, not dollars)",
    count: true,
  },
  {
    section: "source.board-search",
    key: "month_credits",
    label: "Board searches a month (a count, not dollars; Context.dev's free month is 1,000)",
    count: true,
  },
];

/** A limit's value in the config: its section may be dotted ([source.board-search]). */
function limitValue(section: string, key: string): number {
  const at = section
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], loadConfig()) as
    | Record<string, unknown>
    | undefined;
  return Number(at?.[key] ?? 0);
}

/** One limit, in dollars or a count: rewrites that one line of its section. */
export function setLimit(section: string, key: string, usd: unknown): void {
  const limit = LIMITS.find((l) => l.section === section && l.key === key);
  if (!limit) throw new Error("Unknown limit");
  const n = Number(usd);
  if (String(usd).trim() === "" || !Number.isFinite(n) || n < 0)
    throw new Error("A limit is a number, 0 or more");
  const line = `${key} = ${limit.count ? Math.round(n) : n}`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  writeConfig(
    editSection(configText(), `[${section}]`, (body) =>
      re.test(body) ? body.replace(re, line) : `${line}\n${body}`,
    ),
  );
}

/** A price override, [provider.<name>] cost = { cap = usd }; a blank usd removes it. */
export async function setProviderPrice(name: string, cap: string, usd: unknown): Promise<void> {
  if (!CAPS.includes(cap as Capability)) throw new Error("Unknown capability");
  if (!(await loadProviders()).some((p) => p.name === name)) throw new Error(`Unknown provider: ${name}`);
  const blank = usd === null || usd === undefined || String(usd).trim() === "";
  const n = Number(usd);
  if (!blank && !(Number.isFinite(n) && n >= 0)) throw new Error("The price must be a number, 0 or more");
  const text = configText();
  if (new RegExp(`^\\[provider\\.${name}\\.cost\\]`, "m").test(text))
    throw new Error(`config.toml has a [provider.${name}.cost] table; edit it there`);
  const re = /^cost\s*=\s*\{([^}\n]*)\}[^\n]*\n?/m;
  writeConfig(
    editSection(text, `[provider.${name}]`, (body) => {
      const m = re.exec(body);
      const prices = new Map(
        [...(m?.[1] ?? "").matchAll(/([\w-]+)\s*=\s*([^,\s]+)/g)].map((x) => [x[1]!, x[2]!]),
      );
      if (blank) prices.delete(cap);
      else prices.set(cap, String(n));
      const line = prices.size ? `cost = { ${[...prices].map(([k, v]) => `${k} = ${v}`).join(", ")} }\n` : "";
      return m ? body.replace(re, line) : `${line}${body}`;
    }),
  );
}

export type ProviderRow = {
  name: string;
  label: string;
  available: boolean;
  missing: "no key" | "not set up" | null; // why it's not available
  enabled: boolean;
  price: number | null;
  priceSource: "config" | "provider" | "reported";
  monthUsd: number;
};

/** Per capability, the providers that have it: the configured order first, then the rest. */
export async function providerRows(): Promise<Record<Capability, ProviderRow[]>> {
  const cfg = loadConfig();
  const since = monthStart().toISOString();
  const spent = new Map<string, number>();
  for (const e of entries())
    if (e.provider && e.ts >= since) spent.set(e.provider, (spent.get(e.provider) ?? 0) + e.usd);
  const all = await loadProviders();
  const out = {} as Record<Capability, ProviderRow[]>;
  for (const cap of CAPS) {
    const order = cfg.providers[cap] ?? [];
    const has = all.filter((p) => typeof p[cap] === "function");
    const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
    out[cap] = has
      .sort((a, b) => rank(a.name) - rank(b.name))
      .map((p) => ({
        name: p.name,
        label: p.label,
        available: isAvailable(p),
        missing: isAvailable(p) ? null : p.key && !getSecret(p.key) ? "no key" : "not set up",
        enabled: order.includes(p.name),
        price: declaredCost(p, cap) ?? null,
        priceSource: p.lastCost
          ? "reported"
          : typeof cfg.provider[p.name]?.cost?.[cap] === "number"
            ? "config"
            : "provider",
        monthUsd: spent.get(p.name) ?? 0,
      }));
  }
  return out;
}

/** The profile as Settings shows it: its filters as scoring reads them (remote_ok always set). */
function profileShown(): Record<string, unknown> {
  const file = paths.me("profile.json");
  const p = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return { ...p, filters: loadFilters() };
}

export async function status() {
  const me = (f: string) => existsSync(paths.me(f));
  return {
    done: isDone(),
    dataDir: dataDir(),
    cloudSynced: isCloudSynced(dataDir()),
    // A lookup provider's key carries its price line (providers/*.ts).
    keys: await (async () => {
      const prices = new Map((await loadProviders()).map((p) => [p.key ?? p.name, p.price]));
      return KEYS.map((k) => ({ ...k, set: !!getSecret(k.name), price: prices.get(k.name) ?? null }));
    })(),
    prices: PRICE_NOTE,
    runner: loadConfig().runner.mode,
    // What runs the model: either connection runs every step (core/model.ts).
    model: {
      on: connection(),
      signedIn: claudeSignedIn().in,
      plan: claudeSignedIn().plan,
      installed: !!(process.env.JOBSIGNAL_CLAUDE_BIN ?? Bun.which("claude")),
      key: !!getSecret("anthropic"),
    },
    profile: profileShown(),
    // X and Gmail signed in (Settings' Connect buttons), as `jobsignal x connect` / `gmail connect` leave them.
    connected: { x: xConnected(), gmail: gmailConnected() },
    positioning: me("positioning.md"),
    evidence: me("evidence.jsonl"),
    cv: pdfs().length > 0,
    // Real money this month against caps.month_usd. Never shown on the Threads screen.
    spend: { month: monthSpend(), cap: loadConfig().caps.month_usd, history: spendHistory() },
    limits: LIMITS.map((l) => ({ ...l, usd: limitValue(l.section, l.key) })),
    // Per paid service: Context.dev's own count for its period, the rest from the ledger.
    usage: await spendNow(),
    providers: await providerRows(),
    prompt: readFileSync(path.join(import.meta.dir, "positioning-prompt.txt"), "utf8"),
  };
}

export function setDataDir(dir: string): string {
  const abs = path.resolve(dir.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (isCloudSynced(abs))
    throw new Error(
      "That folder is cloud-synced (iCloud, Dropbox…), which can corrupt the index. Pick a plain folder.",
    );
  saveDataDir(abs);
  ensureLayout();
  return abs;
}

export async function setKey(name: string, value: string): Promise<void> {
  if (!KEYS.some((k) => k.name === name)) throw new Error("Unknown key");
  if (!value.trim()) throw new Error("Empty value");
  setSecret(name, value.trim());
  await joinOrders(name);
}

export function setSourceEnabled(key: string, name: string, enabled: boolean): void {
  updateState((s) => {
    s.sources[key] = { ...(s.sources[key] ?? { name, connected: true, failures: 0 }), enabled };
  });
}

/**
 * One setting in config.toml's [source.<key>]: board search's `on`, the fund portals' `picks`.
 * Rewrites that one line of the section, keeping the rest.
 */
export function setSourceValue(
  key: string,
  field: string,
  value: boolean | number | string | string[],
): void {
  const line = `${field} = ${JSON.stringify(value).replace(/,/g, ", ")}`;
  const re = new RegExp(`^${field}\\s*=.*$`, "m");
  writeConfig(
    editSection(configText(), `[source.${key}]`, (body) =>
      re.test(body) ? body.replace(re, line) : `${line}\n${body}`,
    ),
  );
}

const PROFILE_FIELDS = [
  "full_name",
  "email",
  "phone",
  "location",
  "country",
  "linkedin",
  "github",
  "website",
  "work_authorization",
  "needs_sponsorship",
];

/** Saves the profile; with new filters, says how many companies left that only failing posts named. */
export async function saveProfile(p: Record<string, unknown>): Promise<string> {
  const file = paths.me("profile.json");
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const k of PROFILE_FIELDS) if (k in p) cur[k] = p[k];
  // Settings sends the filters it edits; the rest (`metros`, set by hand) stay.
  if (p.filters && typeof p.filters === "object") cur.filters = { ...cur.filters, ...p.filters };
  writeFileSync(file, JSON.stringify(cur, null, 2));
  if (!p.filters) return "Saved";
  // New filters: every open role is scored again now (the Inbox would on its next read anyway).
  void import("../intake/refresh.ts").then((m) => m.ensureScored());
  // Posts a source took in under the old filters (HN, LinkedIn alerts) are checked again.
  const { discoverSources } = await import("../intake/run.ts");
  const { refilter } = await import("../intake/prune.ts");
  const gone = refilter(await discoverSources()).companies.length;
  return gone
    ? `Saved. ${gone} compan${gone > 1 ? "ies" : "y"} named only by posts outside your filters left`
    : "Saved";
}

/** The positioning chat's output: positioning.md and the evidence JSON Lines. */
export function savePositioning(md: string, evidence: string): void {
  if (md.trim()) writeFileSync(paths.me("positioning.md"), `${md.trim()}\n`);
  if (evidence.trim()) {
    const lines = evidence
      .trim()
      .split("\n")
      .filter((l) => {
        try {
          return !!JSON.parse(l).claim;
        } catch {
          return false;
        }
      });
    if (lines.length) writeFileSync(paths.me("evidence.jsonl"), `${lines.join("\n")}\n`);
  }
}

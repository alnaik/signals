// Small-model calls (Haiku) for the named stations in section 4. Every call is recorded in
// the ledger; none on the API key starts once the month's spend has reached its cap (canSpend),
// none on the subscription once the day's background calls are used ([caps] background_day).
// Either connection runs every call: a signed-in Claude Code subscription (through Claude Code) or
// the Anthropic API key. [runner] mode picks when both are there; with one, that one; with
// neither, model steps are skipped and say so.
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.ts";
import { getSecret } from "./keychain.ts";
import { backgroundToday, canSpend, record } from "./ledger.ts";
import { modelCost } from "./prices.ts";
import { failure } from "./trace.ts";

export const CONNECT_MODEL = "sign in to Claude Code, or add an Anthropic API key in Settings > Keys";
export const NO_MODEL = `No model connected: ${CONNECT_MODEL}`;
export class NoModelKey extends Error {
  constructor() {
    super(NO_MODEL);
  }
}
export class OverCap extends Error {
  constructor() {
    super("monthly cap");
  }
}
/**
 * On a Claude subscription, the day's background calls are used ([caps] background_day): the
 * step waits until tomorrow, as it waits past the monthly cap on a key.
 */
export class DayLimit extends OverCap {
  constructor() {
    super();
    this.message = "today's limit of background checks";
  }
}

let client: { key: string; c: Anthropic } | null = null;
export function anthropic(): Anthropic {
  const apiKey = getSecret("anthropic");
  if (!apiKey) throw new NoModelKey();
  // Rebuilt when the key changes; fetch is looked up per call, never captured.
  if (client?.key !== apiKey) {
    client = { key: apiKey, c: new Anthropic({ apiKey, fetch: (url, init) => globalThis.fetch(url, init) }) };
  }
  return client.c;
}

export function hasModelKey(): boolean {
  return getSecret("anthropic") !== null;
}

const claudeBin = () => process.env.JOBSIGNAL_CLAUDE_BIN ?? Bun.which("claude");

export type Signed = { in: boolean; plan: string | null };
// The last answer, and when to look again: 5 minutes after an answer, a minute after a look that
// had none (the CLI didn't answer in time).
let signed: { until: number; v: Signed } | null = null;
let checking: Promise<Signed> | null = null;
let signedStub: Signed | null = null;
/** Tests: what `claude auth status` says, or null for the real one. */
export function setSignedIn(v: Signed | null): void {
  signedStub = v;
  signed = null;
}

let authWaitMs = 10_000;
/** Tests: how long a look waits for `claude auth status` (a minute again after it didn't answer). */
export function setAuthWait(ms: number): void {
  authWaitMs = ms;
}

/**
 * `claude auth status`, run without blocking; `answered` false when it didn't answer within the
 * wait. A Claude Code too old to say, or not answering, is taken as signed in, as before.
 */
async function authStatus(): Promise<{ v: Signed; answered: boolean }> {
  const bin = claudeBin();
  if (!bin) return { v: { in: false, plan: null }, answered: true };
  let v: Signed = { in: true, plan: null };
  try {
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
    const proc = Bun.spawn([bin, "auth", "status", "--json"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    // Bounded for real: a child it started can keep its output open after it is stopped, so past
    // the wait its output is let go too (else the waiting process, a tick, never ends).
    const output = proc.stdout.getReader();
    const read = async () => {
      let text = "";
      const dec = new TextDecoder();
      for (let r = await output.read(); !r.done; r = await output.read())
        text += dec.decode(r.value, { stream: true });
      return text;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), authWaitMs);
    });
    const out = await Promise.race([read().catch(() => ""), late]).finally(() => clearTimeout(timer));
    if (out === null) {
      proc.kill();
      proc.unref();
      await output.cancel().catch(() => {});
      return { v, answered: false };
    }
    const a = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    // Signed in with a Console key instead (authMethod "api_key"…) is no subscription.
    if (typeof a.loggedIn === "boolean")
      v = { in: a.loggedIn && !/api|console/i.test(a.authMethod ?? ""), plan: a.subscriptionType ?? null };
  } catch {}
  return { v, answered: true };
}

/** Look now (one look at a time) and keep the answer; the board starts one at launch, a tick waits for it. */
export function checkSignedIn(): Promise<Signed> {
  if (signedStub) return Promise.resolve(signedStub);
  checking ??= authStatus()
    .then(({ v, answered }) => {
      signed = { until: Date.now() + (answered ? 300_000 : Math.min(60_000, 6 * authWaitMs)), v };
      return v;
    })
    .finally(() => {
      checking = null;
    });
  return checking;
}

/**
 * Wait for this process's first look, once (10 seconds at most): a choice of connection made
 * before it would act on the guess (a Work run built for the subscription while Claude Code is
 * signed out or on a Console key).
 */
export async function firstLook(): Promise<void> {
  if (!signedStub && !signed) await checkSignedIn();
}

/**
 * Is Claude Code installed and signed in to a subscription on this Mac: the last answer of
 * `claude auth status`, looked at again in the background once it is 5 minutes old, so asking
 * never waits on the CLI. Before the first answer: signed in if Claude Code is installed.
 */
export function claudeSignedIn(): Signed {
  if (signedStub) return signedStub;
  if (!signed || Date.now() >= signed.until) void checkSignedIn();
  return signed?.v ?? { in: !!claudeBin(), plan: null };
}

export type Connection = "subscription" | "api-key";
/**
 * What runs the model now: the one [runner] mode picks when it is there, else the other, else
 * null (model steps are skipped).
 */
export function connection(): Connection | null {
  const key = hasModelKey();
  const sub = () => claudeSignedIn().in;
  if (loadConfig().runner.mode === "claude-code-subscription")
    return sub() ? "subscription" : key ? "api-key" : null;
  return key ? "api-key" : sub() ? "subscription" : null;
}

export function onSubscription(): boolean {
  return connection() === "subscription";
}

/**
 * Background checks left today on the subscription, or null when no day limit applies (the API
 * key has its money caps instead, and no model runs nothing).
 */
export function backgroundLeft(now = new Date()): { limit: number; used: number; left: number } | null {
  if (connection() !== "subscription") return null;
  const limit = Math.max(0, Number(loadConfig().caps.background_day) || 0);
  const used = backgroundToday(now);
  return { limit, used, left: Math.max(0, limit - used) };
}

/** Whether a small-model station can run now, on either connection. */
export function canUseSmallModel(): boolean {
  return connection() !== null;
}

type SmallOpts = {
  station: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  thread?: string;
  board?: number; // the board whose page this reads, for its ledger line
  maxTokens?: number;
};

/** One headless Claude Code call with no tools at all: the prompt in, the schema's JSON out. */
async function viaClaudeCode(opts: SmallOpts, model: string): Promise<{ json: unknown; usd: number }> {
  const bin = claudeBin();
  if (!bin) throw new Error("Claude Code isn't installed");
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
  const proc = Bun.spawn(
    [
      bin,
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(opts.schema),
      "--max-turns",
      "3",
      "--restricted",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      opts.system,
    ],
    { cwd: os.tmpdir(), env, stdin: new Blob([opts.user]), stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), 120_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));
  let res: { structured_output?: unknown; total_cost_usd?: number; is_error?: boolean } = {};
  try {
    res = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  } catch {}
  if (code !== 0 || res.is_error || res.structured_output === undefined)
    throw new Error(`${opts.station}: Claude Code ${err.trim().split("\n").at(-1) || "gave no answer"}`);
  return { json: res.structured_output, usd: res.total_cost_usd ?? 0 };
}

/** One structured-output call to the small model. Returns the parsed JSON. */
export async function smallJson<T>(opts: SmallOpts): Promise<T> {
  // The first call in a process waits for the first look, so it runs on the right connection.
  await firstLook();
  const via = connection();
  if (!via) throw new NoModelKey();
  const viaSubscription = via === "subscription";
  if (!viaSubscription && !canSpend(0.01)) throw new OverCap(); // the subscription costs nothing real
  // The subscription costs no money but draws on the plan: a day's background calls are bounded.
  if (viaSubscription && backgroundLeft()?.left === 0) throw new DayLimit();
  try {
    return await smallJsonOnce<T>(opts, viaSubscription);
  } catch (err) {
    // Callers often fall back quietly (a recipe not learned, a lead left pending): trace it here.
    failure("model", opts.station, err, opts.thread ? { thread: opts.thread } : undefined);
    throw err;
  }
}

async function smallJsonOnce<T>(opts: SmallOpts, viaSubscription: boolean): Promise<T> {
  const model = loadConfig().models.small;
  if (viaSubscription) {
    const { json, usd } = await viaClaudeCode(opts, model);
    record({
      kind: "model",
      station: opts.station,
      model,
      usd: 0, // the subscription: no real charge
      notional_usd: usd,
      note: "claude-code-subscription",
      ...(opts.thread ? { thread: opts.thread } : {}),
      ...(opts.board ? { board: opts.board } : {}),
    });
    return json as T;
  }
  const maxTokens = opts.maxTokens ?? 2000;
  const res = await anthropic().messages.create({
    model,
    max_tokens: maxTokens,
    // A text cut inside an emoji leaves half of it, which JSON writes as a lone \ud83d and the
    // API refuses ("unexpected end of hex escape"): such a half becomes U+FFFD.
    system: opts.system.toWellFormed(),
    messages: [{ role: "user", content: opts.user.toWellFormed() }],
    output_config: { effort: "low", format: { type: "json_schema", schema: opts.schema } },
  });
  record({
    kind: "model",
    station: opts.station,
    model,
    usd: modelCost(model, res.usage),
    usage: res.usage as unknown as Record<string, number>,
    ...(opts.thread ? { thread: opts.thread } : {}),
    ...(opts.board ? { board: opts.board } : {}),
  });
  if (res.stop_reason === "refusal") throw new Error(`${opts.station}: the model declined`);
  const text = res.content.find((b) => b.type === "text");
  // Cut off mid-answer, the JSON doesn't parse: said as such, with its end for the failure log.
  if (res.stop_reason === "max_tokens") {
    const end = text?.type === "text" ? text.text.slice(-200) : "";
    throw new Error(`${opts.station}: answer cut off at ${maxTokens} tokens${end ? `: …${end}` : ""}`);
  }
  if (text?.type !== "text") throw new Error(`${opts.station}: no text in response`);
  return JSON.parse(text.text) as T;
}

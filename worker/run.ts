// The worker runner: one headless Claude Code run per thread, locked down to Job Signal's
// own tools. Who pays is whichever model connection there is (core/model.ts connection):
//   claude-code-api-key       the Console key in the Keychain ("anthropic")
//   claude-code-subscription  the person's own Claude Code login
// [runner] mode picks when both are there.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { profile } from "../apply/me.ts";
import { loadConfig } from "../core/config.ts";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { getSecret } from "../core/keychain.ts";
import { capLeft, record } from "../core/ledger.ts";
import { append, read } from "../core/log.ts";
import { connection, firstLook, NO_MODEL } from "../core/model.ts";
import { dataDir, paths } from "../core/paths.ts";
import { setAgent } from "../core/state.ts";
import { failure } from "../core/trace.ts";
import { ulid } from "../core/ulid.ts";
import { isRunNote } from "../core/vocab.ts";
import { setRunBudget, skipped } from "../providers/registry.ts";
import { gather } from "./gather.ts";

const SKILL = path.join(import.meta.dir, "SKILL.md");
const SERVER = path.join(import.meta.dir, "mcp-server.ts");

export function skillBody(file = SKILL): string {
  return readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
}

/** Flags for one locked-down headless run: a skill, one MCP server of our own, budget caps. */
export function stationArgs(o: {
  server: string;
  serverArgs: string[];
  skillFile: string;
  prompt: string;
  model: string;
  budget?: number;
  turns?: number;
}): string[] {
  const cfg = loadConfig();
  const mcp = {
    mcpServers: {
      jobsignal: {
        type: "stdio",
        command: process.execPath,
        args: [o.server, ...o.serverArgs],
        env: { JOBSIGNAL_DATA: dataDir(), PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    },
  };
  return [
    "-p",
    o.prompt,
    "--model",
    o.model,
    // Turns bound a subscription run; dollars bound a run only where they are real (an API key):
    // its own share, caps.run_usd, or what is left of the month when that is less. A run stopped
    // with no cost reported is counted at this, so one hung run never spends the month.
    ...(connection() === "subscription"
      ? ["--max-turns", String(o.turns ?? MAX_TURNS)]
      : ["--max-budget-usd", (o.budget ?? Math.min(capLeft(), Number(cfg.caps.run_usd))).toFixed(2)]),
    "--output-format",
    "json",
    // Lockdown: no built-in tools at all, no user/project settings, only our MCP server.
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcp),
    "--allowedTools",
    "mcp__jobsignal",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--system-prompt",
    skillBody(o.skillFile),
  ];
}

const MAX_TURNS = 12; // aiming for one or two calls: the facts are already in the prompt

function readMe(file: string, max = 20_000): string {
  const f = paths.me(file);
  return existsSync(f) ? readFileSync(f, "utf8").slice(0, max) : "";
}

/** The prompt: the gathered facts, numbered, then the candidate's positioning and evidence. */
export function prompt(id: string): string {
  const d = derive(read(id));
  const facts = d.facts
    .filter((f) => !f.failed)
    .map(
      (f) =>
        `${f.n}. [${f.group}] ${f.text} — "${(f.source?.quote ?? "").slice(0, 400)}" (${f.source?.url ?? ""})`,
    );
  const who = d.contact?.name
    ? `Gathered contact: ${d.contact.name}, ${d.contact.role}.`
    : "No contact was gathered.";
  // Whose run it is: the name in About you, else plainly "the candidate".
  const name = String(profile().full_name ?? "").trim();
  const whose = name ? `${name}'s` : "The candidate's";
  return [
    name ? `The candidate: ${name}.` : "",
    `Thread ${id}: ${d.company || id}. Roles: ${d.roles.map((r) => r.title).join("; ") || "none"}.`,
    `Facts:\n${facts.join("\n") || "(none)"}`,
    who,
    `${whose} positioning:\n${readMe("positioning.md") || "(not written yet)"}`,
    `${whose} evidence (claims with links):\n${readMe("evidence.jsonl") || "(none)"}`,
    "Write the block with write_block, once.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** `run` is the run's id: the run_done its write_block writes carries it, so a run counts only
 * its own finish. */
export function claudeArgs(id: string, run?: string): string[] {
  return stationArgs({
    server: SERVER,
    serverArgs: run ? [id, run] : [id],
    skillFile: SKILL,
    prompt: prompt(id),
    model: loadConfig().models.worker,
  });
}

export type HeadlessResult = {
  total_cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  subtype?: string;
  usage?: Record<string, number>;
};

/** Why a run can't start on this Mac (no binary, no key), or null when it can. */
export function canStart(): string | null {
  if (!(process.env.JOBSIGNAL_CLAUDE_BIN ?? Bun.which("claude")))
    return "Work can't start: it runs on Claude Code, which isn't installed on this Mac. Install it (in Terminal: curl -fsSL https://claude.ai/install.sh | bash), then sign in to it or add an Anthropic API key in Settings > Keys";
  if (!connection()) return `Work can't start. ${NO_MODEL}`;
  return null;
}

/**
 * What one Work run costs at most, in words, before it is pressed: on an API key its model run's
 * share (the month's rest when that is less) and its paid lookups; on the subscription the model
 * draws on the plan, and only paid lookups cost money. Null when no run could start.
 */
export function workCost(): string | null {
  if (canStart()) return null;
  const caps = loadConfig().caps;
  const lookups = Number(caps.run_provider_usd);
  if (connection() === "subscription")
    return `the model runs on your Claude Code plan; paid lookups up to $${lookups.toFixed(2)} a run`;
  return `up to $${(Math.max(0, Math.min(capLeft(), Number(caps.run_usd))) + lookups).toFixed(2)} a run on your API key`;
}

/** Spawn Claude Code headless. Throws when it can't start (no binary, no key). */
export async function runHeadless(
  args: string[],
  cwd: string,
): Promise<{ result: HeadlessResult; code: number; err: string; usd: number }> {
  const why = canStart();
  if (why) throw new Error(why);
  const bin = (process.env.JOBSIGNAL_CLAUDE_BIN ?? Bun.which("claude"))!;
  const cfg = loadConfig();
  const started = Date.now();
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    env: runnerEnv(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  // A hung run would hold the tick lock and stop every other job.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, cfg.caps.run_minutes * 60_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer));
  let result: HeadlessResult = {};
  try {
    result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  } catch {}
  if (timedOut) result.subtype ??= "timed_out";
  // No cost reported: a quick failure (no key, bad flag) spent nothing, but a run that got
  // going and then died may have spent up to its budget, so count that against the month.
  const cap = args.includes("--max-budget-usd") ? Number(args[args.indexOf("--max-budget-usd") + 1]) || 0 : 0;
  const usd = result.total_cost_usd ?? (timedOut || Date.now() - started > 60_000 ? cap : 0);
  return { result, code, err, usd };
}

function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
  // canStart has checked the key is there. Only in the child's environment, never in a shell profile.
  if (connection() === "api-key") env.ANTHROPIC_API_KEY = getSecret("anthropic") ?? "";
  return env;
}

export type RunResult = { ok: boolean; reason?: string; usd?: number; turns?: number };

/** Work: the free gather, then one model run that writes Problem / Person / Proof. Every way out
 * without run_done leaves a run_incomplete note, so "researching" never outlives the run. */
export async function runWorker(id: string, progress: (line: string) => void = () => {}): Promise<RunResult> {
  // The board's Work and the nightly queue are separate processes: one run at a time, any thread.
  const unlock = lockWork();
  if (!unlock) return { ok: false, reason: "already running" };
  const company = derive(read(id)).company || id;
  try {
    // Its flags, its environment and whether it can start follow the connection: the real one.
    await firstLook();
    return await work(id, company, progress, ulid());
  } catch (err) {
    // It never got going (no binary, no key) or the gather threw: final, so the nightly queue
    // doesn't try again; Work again once it's fixed.
    const reason = (err as Error).message;
    append(id, {
      actor: "worker",
      kind: "note",
      data: { event: "run_incomplete", final: true, text: `run stopped: ${reason}`.slice(0, 200) },
    });
    failure("worker", id, err);
    index.reindex(id);
    setAgent("worker", "idle", `stopped · ${company}`);
    return { ok: false, reason };
  } finally {
    setRunBudget(null);
    unlock();
  }
}

/** Take the work lock, or null while another live run holds it: one Work run at a time on the
 * machine, so the board's runs and the nightly queue never run two at once. A lock whose pid is
 * gone, or older than two hours (pids get reused), is stale. */
export function lockWork(): (() => void) | null {
  const file = path.join(dataDir(), "work.lock");
  mkdirSync(dataDir(), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => {
        try {
          unlinkSync(file);
        } catch {}
      };
    } catch {
      let live = false;
      try {
        const fresh = Date.now() - statSync(file).mtimeMs < 2 * 3_600_000;
        process.kill(Number(readFileSync(file, "utf8")), 0);
        live = fresh;
      } catch {}
      if (live) return null;
      try {
        unlinkSync(file);
      } catch {}
    }
  }
  return null;
}

async function work(
  id: string,
  company: string,
  progress: (line: string) => void,
  run: string,
): Promise<RunResult> {
  const cfg = loadConfig();
  setAgent("worker", "working", `on ${company} · gathering`);
  // Paid lookups in the gather share one run's provider budget.
  setRunBudget(cfg.caps.run_provider_usd);
  const g = await gather(id, (line) => {
    progress(line);
    setAgent("worker", "working", `on ${company} · ${line}`);
  });
  const paidSkips = skipped();
  setRunBudget(null);
  const skips = [...g.skipped, ...paidSkips];
  if (skips.length)
    append(id, {
      actor: "gather",
      kind: "note",
      data: { event: "gather_skipped", text: skips.join("; ").slice(0, 600) },
    });
  // A cap never fails a run. On an API key past the monthly cap, the model run is the paid step
  // that's skipped: the facts are on the thread, and the run is done.
  const subscription = connection() === "subscription";
  if (!subscription && capLeft() <= 0) {
    append(id, {
      actor: "worker",
      kind: "note",
      data: { event: "run_done", run, text: "facts gathered · model run skipped · monthly cap" },
    });
    index.reindex(id);
    setAgent("worker", "idle", `done · ${company}`);
    return { ok: true, reason: "model run skipped · monthly cap" };
  }
  progress("writing Problem / Person / Proof");
  // An empty folder, not the thread's: the log is never in reach of the run.
  const cwd = mkdtempSync(path.join(tmpdir(), "jobsignal-work-"));
  const { result, code, err, usd } = await runHeadless(claudeArgs(id, run), cwd).finally(() =>
    rmSync(cwd, { recursive: true, force: true }),
  );
  // On the subscription the run costs nothing real: notional dollars are kept, never counted.
  record({
    kind: "model",
    station: "worker",
    model: cfg.models.worker,
    thread: id,
    usd: subscription ? 0 : usd,
    notional_usd: usd,
    usage: {
      calls: result.num_turns ?? 0,
      cache_read: result.usage?.cache_read_input_tokens ?? 0,
      output: result.usage?.output_tokens ?? 0,
    },
    note: subscription ? "claude-code-subscription" : "claude-code-api-key",
  });
  const finished = read(id).some((e) => isRunNote(e, "run_done") && e.data.run === run);
  if (!finished) {
    const reason =
      result.subtype ?? (code !== 0 ? err.trim().split("\n").at(-1) : "no finish") ?? "no finish";
    append(id, {
      actor: "worker",
      kind: "note",
      data: { event: "run_incomplete", text: `run stopped: ${reason}`.slice(0, 200) },
    });
    failure("worker", id, `run stopped: ${reason}`, {
      exit: code,
      turns: result.num_turns,
      usd,
      stderr: err.trim().split("\n").slice(-5).join("\n"),
    });
  }
  index.reindex(id);
  setAgent("worker", "idle", finished ? `done · ${company}` : `stopped · ${company}`);
  return {
    ok: finished,
    usd,
    turns: result.num_turns,
    ...(finished ? {} : { reason: result.subtype ?? "no finish" }),
  };
}

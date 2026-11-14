import { afterAll, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { setSecret } from "../core/keychain.ts";
import { capLeft, entries } from "../core/ledger.ts";
import { append, read } from "../core/log.ts";
import { setSignedIn } from "../core/model.ts";
import { dataDir, paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { owed } from "./queue.ts";
import { lockWork, runWorker } from "./run.ts";

const data = tempData();
afterAll(data.cleanup);
const ARGS = path.join(os.tmpdir(), `fake-claude-args-${process.pid}.json`);
const TOOLS = path.join(os.tmpdir(), `fake-claude-tools-${process.pid}.json`);
process.env.JOBSIGNAL_CLAUDE_BIN = path.join(import.meta.dir, "..", "fixtures", "fake-claude-bin");
const CONF = path.join(os.tmpdir(), `fake-claude-conf-${process.pid}.json`);
const script = (name: string) =>
  writeFileSync(CONF, JSON.stringify({ script: name, args: ARGS, tools: TOOLS }));
writeFileSync(
  process.env.JOBSIGNAL_CLAUDE_BIN,
  `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dir, "..", "fixtures", "fake-claude.ts")}" "${CONF}" "$@"\n`,
  { mode: 0o755 },
);

// The gather's lookups all miss: these tests are about the model run. gather.test.ts covers it.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

// These runs are on the API key (the default is the subscription).
const API_KEY = '[runner]\nmode = "claude-code-api-key"\n';
let n = 0;
const src = (url: string, quote: string) => ({ type: "page" as const, url, quote });
function working(): string {
  const id = `t${++n}.dev`;
  append(id, { actor: "intake", kind: "signal", data: { company: "Tessera Labs", source_tag: "posting" } });
  append(id, { actor: "board", kind: "decision", data: { action: "work" } });
  append(id, {
    actor: "gather",
    kind: "fact",
    data: { group: "product", text: "Invites arrive late" },
    source: src("https://tessera.dev/docs", "Invitations are sent in the nightly digest. Maya Chen"),
  });
  append(id, {
    actor: "gather",
    kind: "fact",
    data: { group: "product", text: "The invite rework slipped" },
    source: src("https://tessera.dev/changelog", "Invite flow rework: moved to Q1."),
  });
  index.reindex(id);
  return id;
}
beforeEach(() => {
  setSecret("anthropic", "sk-test");
  script("full");
  writeFileSync(paths.config(), `${API_KEY}[caps]\nmonth_usd = 100\n`);
});

test("Work gathers, then one run writes Problem / Person / Proof citing facts", async () => {
  const id = working();
  const lines: string[] = [];
  const r = await runWorker(id, (l) => lines.push(l));
  expect(r).toMatchObject({ ok: true, usd: 0.19, turns: 2 });
  expect(lines).toContain("reading the certificate log");
  expect(lines.at(-1)).toBe("writing Problem / Person / Proof");
  const d = derive(read(id));
  expect(d.status).toBeNull(); // the block names a person, but no contact was gathered
  expect(d.research).toMatchObject({
    problem: { facts: [1], uncited: false },
    person: { name: "Maya Chen", role: "Head of Engineering" },
    proof: { budget: "2h", facts: [2] },
    uncited: 0,
  });
  expect(d.problem).toBe("New teams stall before the first invite.");
  expect(read(id).some((e) => e.data.event === "gather_skipped")).toBe(true);
  expect(entries().at(-1)).toMatchObject({
    station: "worker",
    usd: 0.19,
    notional_usd: 0.19,
    usage: { calls: 2, cache_read: 5000, output: 300 },
    thread: id,
    model: "claude-sonnet-5-5",
  });
});

test("the prompt carries the numbered facts, the person's positioning and evidence; no money language", async () => {
  writeFileSync(paths.me("profile.json"), JSON.stringify({ full_name: "Sam Rivera" }));
  writeFileSync(paths.me("positioning.md"), "# Sam\nGrowth engineer.\n");
  writeFileSync(paths.me("evidence.jsonl"), `${JSON.stringify({ claim: "activation +18%" })}\n`);
  await runWorker(working());
  const { argv } = JSON.parse(readFileSync(ARGS, "utf8"));
  const prompt: string = argv[argv.indexOf("-p") + 1];
  expect(prompt).toContain('1. [product] Invites arrive late — "Invitations are sent in the nightly digest');
  expect(prompt).toContain("Sam Rivera's positioning:\n# Sam\nGrowth engineer.");
  expect(prompt).toContain("activation +18%");
  const skill = readFileSync(path.join(import.meta.dir, "SKILL.md"), "utf8");
  expect(`${prompt}\n${skill}`).not.toMatch(/\$|budget is|costs? money|usd/i);
});

test("the run is locked down: no built-in tools, only our server, one tool, key only in the child", async () => {
  writeFileSync(paths.config(), `${API_KEY}[caps]\nmonth_usd = 3\n`);
  const left = capLeft();
  await runWorker(working());
  const { argv, env } = JSON.parse(readFileSync(ARGS, "utf8"));
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  expect(flag("--tools")).toBe("");
  expect(argv).toContain("--restricted");
  expect(argv).toContain("--strict-mcp-config");
  expect(flag("--allowedTools")).toBe("mcp__jobsignal");
  // On an API key the run is bounded by its own share or what's left of the month, not by turns.
  // Set after the gather, so its paid lookups have come off it already.
  expect(Number(flag("--max-budget-usd"))).toBeLessThanOrEqual(Math.min(left, 0.5) + 0.005);
  expect(Number(flag("--max-budget-usd"))).toBeGreaterThan(0);
  expect(argv).not.toContain("--max-turns");
  expect(flag("--permission-mode")).toBe("dontAsk");
  expect(Object.keys(JSON.parse(flag("--mcp-config")).mcpServers)).toEqual(["jobsignal"]);
  expect(env).toContain("ANTHROPIC_API_KEY");
  expect(JSON.stringify(argv)).not.toContain("sk-test"); // the key never in the run's flags
  expect(JSON.parse(readFileSync(TOOLS, "utf8"))).toEqual(["write_block"]);
});

test("subscription mode: no API key, turns bound the run, nothing real counted", async () => {
  writeFileSync(paths.config(), '[runner]\nmode = "claude-code-subscription"\n');
  setSignedIn({ in: true, plan: "max" });
  await runWorker(working()).finally(() => setSignedIn({ in: false, plan: null }));
  const { argv, env } = JSON.parse(readFileSync(ARGS, "utf8"));
  expect(env).not.toContain("ANTHROPIC_API_KEY");
  expect(argv).not.toContain("--max-budget-usd");
  expect(argv[argv.indexOf("--max-turns") + 1]).toBe("12");
  expect(entries().at(-1)).toMatchObject({ usd: 0, notional_usd: 0.19 });
});

test("a fresh process on the subscription with Claude Code signed out waits for the look and runs on the key", async () => {
  writeFileSync(paths.config(), '[runner]\nmode = "claude-code-subscription"\n');
  // Installed, but its `auth status` says signed out (or on a Console key), a moment after asked.
  const bin = process.env.JOBSIGNAL_CLAUDE_BIN!;
  const out = path.join(os.tmpdir(), `fake-claude-out-${process.pid}.sh`);
  writeFileSync(
    out,
    `#!/bin/sh\nif [ "$1" = auth ]; then sleep 0.3; echo '{"loggedIn":false}'; exit 0; fi\nexec "${bin}" "$@"\n`,
    { mode: 0o755 },
  );
  process.env.JOBSIGNAL_CLAUDE_BIN = out;
  setSignedIn(null);
  try {
    await runWorker(working());
  } finally {
    process.env.JOBSIGNAL_CLAUDE_BIN = bin;
    setSignedIn({ in: false, plan: null });
  }
  const { argv, env } = JSON.parse(readFileSync(ARGS, "utf8"));
  expect(argv).toContain("--max-budget-usd");
  expect(env).toContain("ANTHROPIC_API_KEY");
});

test("hostile content changes nothing outside the thread folder, and a recalled name is refused", async () => {
  const before = readdirSync(data.dir).sort();
  const id = working();
  script("hostile");
  expect((await runWorker(id)).ok).toBe(true);
  expect(readdirSync(data.dir).sort()).toEqual(before);
  expect(derive(read(id)).research?.person.name).toBe("Maya Chen");
});

test("a run that stops early is noted, retried once more, then left for you", async () => {
  const id = working();
  script("stop");
  expect(await runWorker(id)).toMatchObject({ ok: false, reason: "error_max_turns" });
  expect(owed(id)).toBe(true);
  expect(derive(read(id)).status).toBe("researching");
  await runWorker(id);
  expect(owed(id)).toBe(false);
  expect(derive(read(id)).status).toBeNull();
});

test("a hung run is stopped and counted at its own share, so Work isn't locked out for the month", async () => {
  script("hang");
  writeFileSync(paths.config(), `${API_KEY}[caps]\nmonth_usd = 100\nrun_minutes = 0.01\n`);
  const id = working();
  const before = capLeft();
  const r = await runWorker(id);
  const { argv } = JSON.parse(readFileSync(ARGS, "utf8"));
  expect(r).toMatchObject({ ok: false, reason: "timed_out" });
  expect(r.usd).toBe(Number(argv[argv.indexOf("--max-budget-usd") + 1]));
  expect(r.usd).toBe(0.5);
  expect(before - capLeft()).toBeLessThan(0.6); // the run, and what the gather paid
  expect(read(id).at(-1)?.data.text).toBe("run stopped: timed_out");
});

test("past the monthly cap on an API key, the model run is skipped and the run still finishes", async () => {
  writeFileSync(paths.config(), `${API_KEY}[caps]\nmonth_usd = 0.01\n`);
  const id = working();
  expect(await runWorker(id)).toEqual({ ok: true, reason: "model run skipped · monthly cap" });
  expect(derive(read(id)).status).toBeNull();
  expect(read(id).at(-1)?.data.text).toBe("facts gathered · model run skipped · monthly cap");
});

test("a run counts only its own finish, outside the thread's folder", async () => {
  writeFileSync(paths.config(), ""); // the subscription: earlier tests spent the API key's cap
  const id = working();
  const r = await runWorker(id);
  expect(r).toMatchObject({ ok: true, turns: 2 });
  const done = read(id).findLast((e) => e.data.event === "run_done")!;
  expect(done.data.run).toMatch(/^[0-9A-Z]{26}$/);
  const { argv, cwd } = JSON.parse(readFileSync(ARGS, "utf8"));
  expect(JSON.parse(argv[argv.indexOf("--mcp-config") + 1]).mcpServers.jobsignal.args.at(-1)).toBe(
    done.data.run,
  );
  expect(path.resolve(cwd)).not.toBe(path.resolve(paths.thread(id)));
});

test("a run already going, on any thread, means no second run", async () => {
  const id = working();
  const unlock = lockWork()!;
  const before = read(id).length;
  expect(await runWorker(id)).toEqual({ ok: false, reason: "already running" });
  expect(read(id).length).toBe(before);
  unlock();
  const again = lockWork();
  expect(again).not.toBeNull();
  again!();
  // A lock left by a run that died, or one older than two hours whatever its pid, is taken over.
  const file = path.join(dataDir(), "work.lock");
  writeFileSync(file, "999999");
  const dead = lockWork();
  expect(dead).not.toBeNull();
  dead!();
  writeFileSync(file, String(process.pid));
  const old = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(file, old, old);
  const stale = lockWork();
  expect(stale).not.toBeNull();
  stale!();
});

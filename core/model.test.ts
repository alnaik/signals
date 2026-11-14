import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setRunnerMode } from "../setup/state.ts";
import { setSecret } from "./keychain.ts";
import { entries, record } from "./ledger.ts";
import {
  backgroundLeft,
  canUseSmallModel,
  checkSignedIn,
  claudeSignedIn,
  connection,
  DayLimit,
  OverCap,
  setAuthWait,
  setSignedIn,
  smallJson,
} from "./model.ts";
import { tempData } from "./testing.ts";

const data = tempData();
const before = { bin: process.env.JOBSIGNAL_CLAUDE_BIN, key: process.env.ANTHROPIC_API_KEY };
afterAll(() => {
  for (const [k, v] of [
    ["JOBSIGNAL_CLAUDE_BIN", before.bin],
    ["ANTHROPIC_API_KEY", before.key],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  data.cleanup();
});

// A fake Claude Code: records its args, stdin and whether an API key reached it, then answers
// with the structured output Claude Code prints for --json-schema.
const SEEN = path.join(os.tmpdir(), `fake-claude-small-${process.pid}`);
const BIN = path.join(os.tmpdir(), `fake-claude-small-${process.pid}.sh`);
writeFileSync(
  BIN,
  `#!/bin/sh
printf '%s\\n' "$@" > "${SEEN}.args"
cat > "${SEEN}.stdin"
printf '%s' "\${ANTHROPIC_API_KEY:-none}" > "${SEEN}.key"
echo '{"type":"result","is_error":false,"total_cost_usd":0.0003,"structured_output":{"supported":true}}'
`,
  { mode: 0o755 },
);
process.env.JOBSIGNAL_CLAUDE_BIN = BIN;
setSecret("anthropic", "sk-test");
process.env.ANTHROPIC_API_KEY = "sk-leak";

const schema = { type: "object", properties: { supported: { type: "boolean" } }, required: ["supported"] };

test("on the subscription, small-model calls run through Claude Code with no key and no tools", async () => {
  setRunnerMode("claude-code-subscription");
  setSignedIn({ in: true, plan: "pro" });
  expect(canUseSmallModel()).toBe(true);
  const out = await smallJson<{ supported: boolean }>({
    station: "probe",
    system: "sys",
    user: "the page",
    schema,
  });
  expect(out).toEqual({ supported: true });
  const seen = (f: string) => readFileSync(`${SEEN}.${f}`, "utf8");
  expect(seen("stdin")).toBe("the page"); // the prompt goes over stdin, not argv
  expect(seen("key")).toBe("none");
  const args = seen("args").split("\n");
  expect(args[args.indexOf("--json-schema") + 1]).toBe(JSON.stringify(schema));
  expect(args.slice(args.indexOf("--restricted"), args.indexOf("--restricted") + 4)).toEqual([
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
  ]);
  expect(entries().at(-1)).toMatchObject({
    station: "probe",
    usd: 0,
    notional_usd: 0.0003,
    note: "claude-code-subscription",
  });
});

test("on the subscription, background calls stop at the day's limit; Work's runs don't count", async () => {
  writeFileSync(
    path.join(data.dir, "config.toml"),
    '[runner]\nmode = "claude-code-subscription"\n[caps]\nbackground_day = 2\n',
  );
  setSignedIn({ in: true, plan: "pro" });
  const used = backgroundLeft()!.used; // the first test's call
  record({ kind: "model", station: "worker", model: "m", usd: 0, note: "claude-code-subscription" });
  expect(backgroundLeft()).toEqual({ limit: 2, used, left: 2 - used });
  await smallJson({ station: "classify", system: "s", user: "u", schema });
  expect(backgroundLeft()?.left).toBe(0);
  await expect(smallJson({ station: "classify", system: "s", user: "u", schema })).rejects.toBeInstanceOf(
    DayLimit,
  );
  writeFileSync(path.join(data.dir, "config.toml"), "");
});

test("picked the subscription, signed out, with a key: the key runs it, within the cap", async () => {
  setRunnerMode("claude-code-subscription");
  setSignedIn({ in: false, plan: null });
  expect(connection()).toBe("api-key");
  const realFetch = globalThis.fetch;
  let asked = "";
  globalThis.fetch = (async (url: string) => {
    asked = String(url);
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"supported":false}' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
  }) as unknown as typeof fetch;
  try {
    const out = await smallJson<{ supported: boolean }>({
      station: "pick",
      system: "sys",
      user: "the results",
      schema,
    });
    expect(out).toEqual({ supported: false });
    expect(asked).toContain("api.anthropic.com");
    expect(entries().at(-1)?.station).toBe("pick");
    expect(entries().at(-1)?.usd).toBeGreaterThan(0);
    expect(entries().at(-1)?.note).toBeUndefined();
    // Past the month's cap it never starts.
    writeFileSync(
      path.join(data.dir, "config.toml"),
      '[runner]\nmode = "claude-code-subscription"\n[caps]\nmonth_usd = 0\n',
    );
    asked = "";
    await expect(smallJson({ station: "pick", system: "sys", user: "u", schema })).rejects.toBeInstanceOf(
      OverCap,
    );
    expect(asked).toBe("");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a Claude Code that never answers whether it is signed in holds the look for its wait only, and is looked at again later", async () => {
  // Its `auth status` hangs, and a child it started keeps its output open after it is stopped.
  const stuck = path.join(os.tmpdir(), `fake-claude-stuck-${process.pid}.sh`);
  writeFileSync(stuck, "#!/bin/sh\nsleep 8 &\nsleep 8\n", { mode: 0o755 });
  process.env.JOBSIGNAL_CLAUDE_BIN = stuck;
  setSignedIn(null);
  setAuthWait(200);
  try {
    const t0 = Date.now();
    // Installed, plan unknown: what it was taken as before the first answer.
    expect(await checkSignedIn()).toEqual({ in: true, plan: null });
    expect(Date.now() - t0).toBeLessThan(1500);
    // Looked at again a little later (a minute; six waits here), not kept for 5 minutes.
    process.env.JOBSIGNAL_CLAUDE_BIN = BIN.replace(".sh", "-out.sh");
    writeFileSync(process.env.JOBSIGNAL_CLAUDE_BIN, `#!/bin/sh\necho '{"loggedIn":false}'\n`, {
      mode: 0o755,
    });
    expect(claudeSignedIn()).toEqual({ in: true, plan: null });
    await Bun.sleep(1300);
    claudeSignedIn();
    await Bun.sleep(300);
    expect(claudeSignedIn()).toEqual({ in: false, plan: null });
  } finally {
    setAuthWait(10_000);
    process.env.JOBSIGNAL_CLAUDE_BIN = BIN;
    setSignedIn({ in: false, plan: null });
  }
});

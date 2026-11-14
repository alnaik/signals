import { afterAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type RunnerCompany, type RunnerResult, runRunner, setRunner } from "../ats/reader.ts";
import { open, setMeta } from "../core/db.ts";
import { setSecret } from "../core/keychain.ts";
import { lockHolder } from "../core/lock.ts";
import { setOnline } from "../core/online.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { setProviders } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import { batchStatus, runBatch, stopBatch } from "./batch.ts";
import { upsertCompany } from "./companies.ts";
import { runBoardsStep, tick } from "./run.ts";

const data = tempData();
const realFetch = globalThis.fetch;
afterAll(() => {
  setRunner(runRunner);
  setProviders(null);
  globalThis.fetch = realFetch;
  data.cleanup();
});

// The small model answers through fetch (the API key): never a real call. Its pick: nothing fits.
globalThis.fetch = (async () =>
  Response.json({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ pick: 0, domain: "", query: "", why: "none fits" }) }],
    usage: { input_tokens: 500, output_tokens: 30 },
  })) as unknown as typeof fetch;
const searched: string[] = [];
const search: Provider = {
  name: "contextdev",
  label: "Context.dev",
  key: "contextdev",
  cost: { search: 0 },
  search: async (q) => {
    searched.push(q);
    return [];
  },
};
setProviders([search]);
setSecret("contextdev", "k");
setSecret("anthropic", "sk-test");

// Every company's site: looked at, no board.
let onDetect = () => {};
const detected: string[] = [];
setRunner(async (_mode, cs: RunnerCompany[]) =>
  cs.map((c): RunnerResult => {
    detected.push(c.name ?? c.domain);
    onDetect();
    return {
      domain: c.domain,
      ok: true,
      detect: { provider: null, problem: "pages fetched, no board found" },
    };
  }),
);

beforeEach(() => {
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies; DELETE FROM meta;",
  );
  writeFileSync(paths.config(), "[discovery]\nsearch = false\n");
  detected.length = 0;
  searched.length = 0;
  onDetect = () => {};
  setOnline(true);
});

const queued = (n: number) => {
  const at = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const id = upsertCompany({ name: `Co ${i}`, domain: `co${i}.dev` });
    open().query("UPDATE companies SET discovery = 'queued', last_signal_at = ? WHERE id = ?").run(at, id);
  }
};
const count = (where: string) =>
  (open().query(`SELECT count(*) AS n FROM companies WHERE ${where}`).get() as { n: number }).n;
const lockFile = (name: string) => path.join(data.dir, `${name}.lock`);

test("while a batch run holds its lock the tick skips discovery and says so; a stale lock doesn't stop it", async () => {
  queued(2);
  writeFileSync(lockFile("batch"), String(process.pid)); // a live run: this process
  const lines: string[] = [];
  await runBoardsStep(new Date(), (l) => lines.push(l));
  expect(lines).toContain("discover: skipped, a batch run started on Sources is finding boards");
  expect(detected).toEqual([]);
  expect(count("discovery = 'queued'")).toBe(2);
  // Its process gone (a crash, the Mac restarted): stale, and the run shows as stopped partway.
  writeFileSync(lockFile("batch"), "999999");
  setMeta(
    "batch",
    JSON.stringify({ started: "2026-11-12T10:00:00Z", total: 9, done: 4, boards: 1, on: "x" }),
  );
  expect(lockHolder("batch")).toBeNull();
  expect(batchStatus()).toMatchObject({ running: false, partway: true });
  await runBoardsStep(new Date(), () => {});
  expect(detected.sort()).toEqual(["Co 0", "Co 1"]);
  expect(count("discovery = 'queued'")).toBe(0);
});

test("a batch run waits for a tick's discovery already going, then looks at every company waiting, past the tick's time", async () => {
  queued(20);
  writeFileSync(paths.config(), "[discovery]\nsearch = false\ntick_seconds = 0\n");
  writeFileSync(lockFile("discover"), String(process.pid)); // a tick finding boards
  setTimeout(() => writeFileSync(lockFile("discover"), "999999"), 100);
  const b = await runBatch(() => {}, 20);
  expect(b).toMatchObject({ done: 20, boards: 0, total: 20 });
  expect(b?.why).toStartWith("Done");
  expect(count("discovery = 'queued'")).toBe(0);
  expect(lockHolder("batch")).toBeNull();
  expect(lockHolder("discover")).toBeNull();
});

test("Stop ends a batch run after the companies in hand; the rest stay waiting for the next one", async () => {
  queued(20);
  onDetect = (() => {
    let asked = false;
    return () => {
      if (asked) return;
      asked = true;
      expect(stopBatch()).toBe("Stopping after the companies in hand");
    };
  })();
  const b = await runBatch(() => {});
  // The first eight were in hand: written; the other twelve wait, as they were.
  expect(detected.length).toBe(8);
  expect(b?.why).toStartWith("Stopped: 8 companies looked at");
  expect(count("discovery = 'queued'")).toBe(12);
  expect(batchStatus()).toMatchObject({ running: false, partway: false, stopping: false });
});

test("with no internet a tick and a batch run read nothing and count nothing; losing it partway leaves the rest waiting", async () => {
  queued(2);
  setOnline(false);
  const lines: string[] = [];
  expect(await tick(new Date(), (l) => lines.push(l))).toBe(true);
  expect(lines).toEqual(["no internet: this read was skipped"]);
  expect(lockHolder("tick")).toBeNull();
  const b = await runBatch(() => {});
  expect(b?.why).toStartWith("Ended: no internet");
  expect(detected).toEqual([]);
  // The internet goes while the sites are looked at: nothing found isn't written, they stay queued.
  setOnline(true);
  onDetect = () => setOnline(false);
  const partway = await runBatch(() => {});
  expect(detected.length).toBe(2);
  expect(count("discovery = 'queued' AND discovery_at IS NULL")).toBe(2);
  expect(partway?.why).toStartWith("Ended: no internet");
});

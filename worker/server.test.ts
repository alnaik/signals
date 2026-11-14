import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { deleteSecret } from "../core/keychain.ts";
import { append, read } from "../core/log.ts";
import { setSignedIn } from "../core/model.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { feature, idle, start } from "./server.ts";

const data = tempData();
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
process.env.JOBSIGNAL_CLAUDE_BIN = "/nonexistent/claude";
writeFileSync(paths.config(), '[runner]\nmode = "claude-code-subscription"\n');
setSignedIn({ in: true, plan: "max" });
afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.JOBSIGNAL_CLAUDE_BIN;
  data.cleanup();
});

const thread = (id: string) => {
  append(id, { actor: "intake", kind: "signal", data: { company: id } });
  index.reindex(id);
  return id;
};
const work = (id: string) => {
  const route = feature.routes!["/api/work/:id"] as { POST: (req: unknown) => Promise<Response> | Response };
  return route.POST({ params: { id } });
};

test("while a run is going, Work is next in line and runs right after it", async () => {
  const busy = thread("busy.dev");
  append(busy, { actor: "board", kind: "decision", data: { action: "work" } });
  const going = start(busy);
  const id = thread("late.dev");
  const r = await work(id);
  expect((await r.json()).toast).toBe("Next in line · late.dev");
  expect(derive(read(id))).toMatchObject({ status: "researching", tonight: true });
  await going;
  await idle();
  // The run after busy.dev's was late.dev's: it ended (no claude here), so it's no longer researching.
  expect(read(id).some((e) => e.kind === "note" && e.actor === "worker")).toBe(true);
});

test("Work refuses when no run could start, and nothing enters researching", async () => {
  writeFileSync(paths.config(), '[runner]\nmode = "claude-code-api-key"\n');
  deleteSecret("anthropic");
  setSignedIn({ in: false, plan: null });
  const id = thread("nokey.dev");
  const r = await work(id);
  setSignedIn({ in: true, plan: "max" });
  expect(r.status).toBe(400);
  expect((await r.json()).toast).toStartWith("Work can't start. No model connected");
  expect(derive(read(id)).status).toBeNull();
  writeFileSync(paths.config(), '[runner]\nmode = "claude-code-subscription"\n');
});

test("two runs in a row that don't finish stop the line: the rest wait for the nightly pass", async () => {
  const ids = ["one.dev", "two.dev", "three.dev"].map(thread);
  for (const id of ids)
    append(id, { actor: "board", kind: "decision", data: { action: "work", tonight: true } });
  for (const id of ids) index.reindex(id);
  await start(ids[0]!);
  await idle();
  // No claude here: one.dev's and two.dev's runs stopped, so three.dev is still in line.
  expect(derive(read(ids[1]!)).status).not.toBe("researching");
  expect(derive(read(ids[2]!))).toMatchObject({ status: "researching", tonight: true });
  const running = feature.routes!["/api/work"] as { GET: () => Response };
  expect(await running.GET().json()).toEqual({ running: null, queued: 1 });
});

test("Work on a company with no website looks for it first, and the thread says when there's none", async () => {
  const id = thread("nameonly.no-domain");
  const r = await work(id);
  expect(r.status).toBe(200);
  expect((await r.json()).toast).toBe(
    "Looking for nameonly.no-domain's website · Work starts when it's found",
  );
  expect(read(id).some((e) => e.data.action === "work")).toBe(true);
  // No company behind this thread: nothing to look for, and the thread says so.
  await new Promise((done) => setTimeout(done, 50));
  expect(derive(read(id)).ran).toBe("no website found");
});

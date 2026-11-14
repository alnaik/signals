import { afterAll, beforeAll, expect, test } from "bun:test";
import * as index from "../core/index-db.ts";
import * as log from "../core/log.ts";
import { tempData } from "../core/testing.ts";
import { startServer } from "../server/main.ts";

const data = tempData();
let app: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  app = await startServer({ port: 0 });
});
afterAll(() => {
  app.stop();
  data.cleanup();
});

async function nextEvents(res: Response, want: string, ms = 3000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    buf += dec.decode(r.value);
    if (buf.includes(want)) break;
  }
  reader.cancel();
  return buf;
}

test("a log write reaches the index and the event stream", async () => {
  const res = await fetch(`${app.url}api/events`);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  await Bun.sleep(100);
  log.append("live.dev", { actor: "intake", kind: "signal", data: { company: "Live" } });
  const text = await nextEvents(res, "live.dev");
  expect(text).toContain("event: thread.changed");
  expect(text).toContain('"id":"live.dev"');
  expect(index.get("live.dev")?.company).toBe("Live");
});

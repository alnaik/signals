import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import * as index from "./index-db.ts";
import * as log from "./log.ts";
import { paths } from "./paths.ts";
import { tempData } from "./testing.ts";

const data = tempData();
afterAll(data.cleanup);

describe("thread log", () => {
  test("threadId normalises domains and URLs", () => {
    expect(log.threadId("https://www.Tessera.dev/careers?x=1")).toBe("tessera.dev");
    expect(() => log.threadId("not a domain")).toThrow();
  });
});

describe("index", () => {
  test("rebuild from folders matches incremental indexing", () => {
    log.append("a.dev", { actor: "intake", kind: "signal", data: { company: "A" } });
    log.append("b.dev", { actor: "intake", kind: "signal", data: { company: "B" } });
    log.append("b.dev", { actor: "board", kind: "decision", data: { action: "work" } });
    index.reindex("a.dev");
    index.reindex("b.dev");
    const before = index.all().sort((x, y) => x.id.localeCompare(y.id));
    index.close();
    rmSync(paths.index());
    const after = index.all().sort((x, y) => x.id.localeCompare(y.id));
    expect(after).toEqual(before);
    expect(after.map((s) => s.status)).toEqual([null, "researching"]);
  });

  test("an index.db from before the redesign is dropped and rebuilt", () => {
    index.close();
    rmSync(paths.index(), { force: true });
    const old = new Database(paths.index(), { create: true });
    old.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, last_ts TEXT, summary TEXT)");
    old.close();
    log.append("c.dev", { actor: "intake", kind: "signal", data: { company: "C" } });
    expect(index.get("c.dev")?.company).toBe("C");
  });
});

// Its own thread, after the index test, which counts every thread.
test("an entry appended after a torn line is kept", () => {
  log.append("torn.dev", { actor: "intake", kind: "signal", data: { company: "T" } });
  appendFileSync(paths.log("torn.dev"), '{"id":"broken","ts');
  log.append("torn.dev", { actor: "board", kind: "note", data: { event: "pdf_chosen" } });
  expect(log.read("torn.dev").map((e) => e.kind)).toEqual(["signal", "note"]);
});

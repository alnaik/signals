import { afterAll, beforeEach, expect, test } from "bun:test";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import { tempData } from "../core/testing.ts";
import { setProviders } from "../providers/registry.ts";
import { addAsFact, runWatches, watch, watches } from "./actions.ts";

const data = tempData();
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  setProviders(null);
  data.cleanup();
});

let hits = [
  { url: "https://news.ycombinator.com/item?id=1", title: "Show HN: Tessera", snippet: "We built invites" },
];
beforeEach(() => {
  setProviders([
    { name: "hn", label: "HN", cost: { search: 0 }, search: async () => hits },
    { name: "paid", label: "Paid", key: "paid", cost: { search: 0.01 }, search: async () => [] },
  ]);
});
const ID = "tessera.dev";
append(ID, { actor: "intake", kind: "signal", data: { company: "Tessera" } });
index.reindex(ID);

test("a watched search adds only new results, marked new", async () => {
  addAsFact(ID, { ...hits[0]!, provider: "hn" }); // already a fact: not new
  watch(ID, "tessera", ["hn"], true);
  expect(watches(ID).map((w) => w.query)).toEqual(["tessera"]);
  hits = [
    ...hits,
    { url: "https://news.ycombinator.com/item?id=2", title: "Tessera raises", snippet: "Series A" },
  ];
  expect(await runWatches()).toBe("1 new from 1 watched searches");
  expect(await runWatches()).toBe("0 new from 1 watched searches");
  const added = derive(read(ID)).facts.at(-1)!;
  expect(added).toMatchObject({ text: "Tessera raises", late: true });
  watch(ID, "tessera", ["hn"], false);
  expect(watches(ID)).toEqual([]);
});

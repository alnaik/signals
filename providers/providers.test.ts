import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setSecret } from "../core/keychain.ts";
import { entries, record } from "../core/ledger.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { webSearch } from "../intake/search.ts";
import { mcpProviders } from "./mcp.ts";
import { search, setProviders, waterfall } from "./registry.ts";
import type { Provider } from "./types.ts";

const data = tempData();
afterAll(data.cleanup);
afterEach(() => setProviders(null));

const fake = (name: string, results: number, cost = 0.01, extra: Partial<Provider> = {}): Provider => ({
  name,
  label: name,
  cost: { search: cost },
  search: async (q) =>
    Array.from({ length: results }, (_, i) => ({
      url: `https://${name}.test/${i}`,
      title: `${q} ${i}`,
      snippet: "s",
    })),
  ...extra,
});

test("the waterfall follows the configured order and stops at the first confident result", async () => {
  writeFileSync(paths.config(), '[providers]\nsearch = ["empty", "good", "never"]\n');
  setProviders([fake("never", 3), fake("good", 2, 0.02), fake("empty", 0, 0.001), fake("unlisted", 9)]);
  const r = await search("tessera", {}, { station: "test", thread: "t.dev" });
  expect(r.by).toBe("good");
  expect(r.steps.map((s) => s.provider)).toEqual(["empty", "good"]);
  const spent = entries().filter((e) => e.station === "test");
  expect(spent.map((e) => [e.provider, e.usd])).toEqual([
    ["empty", 0.001],
    ["good", 0.02],
  ]);
});

test("providers that need a missing key are skipped; failures fall through", async () => {
  writeFileSync(paths.config(), '[providers]\nsearch = ["keyed", "broken", "ok"]\n');
  setProviders([
    fake("keyed", 1, 0, { key: "nokey" }),
    fake("broken", 0, 0, { search: async () => Promise.reject(new Error("503")) }),
    fake("ok", 1),
  ]);
  const r = await waterfall("search", ["x", {}], { station: "test" }, (x: unknown[]) => x.length > 0);
  expect(r.by).toBe("ok");
  expect(r.steps).toEqual([expect.objectContaining({ provider: "broken", error: "503" }), expect.anything()]);
});

test("an MCP server's tool becomes a provider through config alone", async () => {
  setSecret("fake", "s3cret");
  const server = path.join(import.meta.dir, "..", "fixtures", "mcp", "fake-server.ts");
  writeFileSync(
    paths.config(),
    `[provider.mcp.fakesearch]
command = ["${process.execPath}", "${server}"]
env = { FAKE_KEY = "keychain:fake" }
[provider.mcp.fakesearch.search]
tool = "web_search"
args = { query = "{query}" }
list = "hits"
fields = { url = "link", title = "name", snippet = "blurb" }
cost = 0.002
`,
  );
  const [p] = mcpProviders();
  expect(p?.name).toBe("fakesearch");
  const results = await p!.search!("tessera labs", {});
  expect(results).toEqual([
    { url: "https://example.com/tessera%20labs", title: "About tessera labs", snippet: "secret=s3cret" },
  ]);
  expect(p!.cost.search).toBe(0.002);
});

test("paid calls stop at the monthly cap even with no run budget", async () => {
  writeFileSync(paths.config(), '[caps]\nmonth_usd = 0.05\n[providers]\nsearch = ["dear", "free"]\n');
  setProviders([fake("dear", 3, 0.5), fake("free", 2, 0)]);
  const r = await search("tessera", {}, { station: "cap-test" });
  expect(r.by).toBe("free");
  expect(r.steps[0]?.error).toContain("monthly cap");
});

test("Exa isn't asked past its own monthly limit; the next web search is", async () => {
  writeFileSync(
    paths.config(),
    '[providers]\nsearch = ["exa", "other"]\n\n[discovery]\nexa_month_usd = 0.01\n',
  );
  const asked: string[] = [];
  const paid = (name: string) =>
    fake(name, 1, 0.007, {
      key: name,
      search: async () => {
        asked.push(name);
        return [{ url: `https://${name}.test/1`, title: "Brindle Robotics", snippet: "s" }];
      },
    });
  setSecret("exa", "k");
  setSecret("other", "k");
  setProviders([paid("exa"), paid("other")]);
  record({ kind: "provider", station: "test", provider: "exa", usd: 0.01 });
  expect(await webSearch("brindle robotics")).toHaveLength(1);
  expect(asked).toEqual(["other"]);
});

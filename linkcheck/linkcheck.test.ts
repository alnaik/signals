import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { setProviders } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import { checkThread, containsQuote } from "./check.ts";

const data = tempData();
// The small model on the API key (mocked below), never a real Claude Code run.
writeFileSync(paths.config(), '[runner]\nmode = "claude-code-api-key"\n');
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A literal public IP, so no DNS is needed; the page itself is mocked.
const PAGE = "https://93.184.215.14/docs/invites";
const HTML =
  "<html><body><h1>Invites</h1><p>Invitations are sent in the nightly&nbsp;digest, not right away.</p></body></html>";
let modelSays = false;
function mockWeb() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url.includes("api.anthropic.com")) {
      return Response.json({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ supported: modelSays }) }],
        usage: { input_tokens: 900, output_tokens: 10 },
      });
    }
    if (url.startsWith(PAGE)) return new Response(HTML, { headers: { "content-type": "text/html" } });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

function thread(id: string, quote: string) {
  append(id, { actor: "intake", kind: "signal", data: { company: "Tessera Labs" } });
  append(id, { actor: "board", kind: "decision", data: { action: "work" } });
  append(id, {
    actor: "worker",
    kind: "fact",
    data: { group: "product", text: "Invites arrive late" },
    source: { type: "page", url: PAGE, quote },
  });
  append(id, {
    actor: "worker",
    kind: "research",
    data: {
      problem: { text: "late invites", facts: [1] },
      person: { name: "", role: "", text: "no person found", facts: [] },
      proof: { text: "a repro", budget: "1h", facts: [1] },
    },
  });
  append(id, { actor: "worker", kind: "note", data: { event: "run_done" } });
  index.reindex(id);
}

test("quote matching ignores case, spacing, curly quotes and markdown", () => {
  expect(containsQuote("We ship **small** — often.", "we ship small - often")).toBe(true);
  expect(containsQuote("It’s fast", "It's fast")).toBe(true);
  expect(
    containsQuote(
      "first part here and more text then second part here",
      "first part here … second part here",
    ),
  ).toBe(true);
  expect(containsQuote("something else", "first part")).toBe(false);
});

test("a deliberately wrong quote marks the fact failed and the lines citing it uncited", async () => {
  mockWeb();
  deleteSecret("anthropic");
  thread("bad.dev", "Invites are delivered instantly to every teammate");
  expect((await checkThread("bad.dev")).failed).toEqual(["fact 1"]);
  const d = derive(read("bad.dev"));
  expect(d.facts[0]?.failed).toBe(true);
  expect([d.research?.problem.uncited, d.research?.proof.uncited]).toEqual([true, true]);
});

test("the small model may accept a faithful paraphrase, and only that", async () => {
  mockWeb();
  setSecret("anthropic", "sk-test");
  modelSays = true;
  thread("para.dev", "Invites go out in a nightly batch");
  expect((await checkThread("para.dev")).failed).toEqual([]);
  expect(read("para.dev").find((e) => e.data.event === "linkcheck")?.data.how).toBe("paraphrase");
  modelSays = false;
  thread("para2.dev", "Invites go out instantly");
  expect((await checkThread("para2.dev")).failed).toEqual(["fact 1"]);
});

test("LinkedIn and pages robots.txt refuses are left unchecked, never sent to a paid reader", async () => {
  const fetched: string[] = [];
  let readerCalls = 0;
  setProviders([
    {
      name: "spy",
      label: "Spy",
      cost: { read: 0.01 },
      read: async () => {
        readerCalls++;
        return { url: "", text: "x".repeat(500), fetched_at: "" };
      },
    } as Provider,
  ]);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /", { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const fact = (id: string, url: string) => {
    append(id, { actor: "intake", kind: "signal", data: {} });
    append(id, {
      actor: "worker",
      kind: "fact",
      data: { text: "x" },
      source: { type: "page", url, quote: "q" },
    });
  };
  fact("li.dev", "https://linkedin.com/comm/jobs/view/4410263225");
  fact("robots.dev", "https://93.184.215.15/jobs/1");
  try {
    for (const id of ["li.dev", "robots.dev"]) {
      expect(await checkThread(id)).toEqual({ checked: 1, failed: [] });
      expect(read(id).find((e) => e.data.event === "linkcheck")?.data).toMatchObject({
        result: "unchecked",
        how: "refused",
      });
      expect(derive(read(id)).facts[0]?.failed).toBe(false);
    }
    expect(readerCalls).toBe(0);
    expect(fetched.some((u) => u.includes("linkedin"))).toBe(false);
  } finally {
    setProviders(null);
  }
});

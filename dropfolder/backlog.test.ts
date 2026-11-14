import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  BatchCreateParams,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import { close, open } from "../core/db.ts";
import { setSecret } from "../core/keychain.ts";
import { entries } from "../core/ledger.ts";
import { setSignedIn } from "../core/model.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { ANSWERED, type Answer } from "../intake/classify.ts";
import {
  type Backlog,
  type Batches,
  backlogLines,
  follow as followLink,
  localBatches,
  type Outcome,
  PARKED,
  sortBacklogs,
} from "./backlog.ts";
import { processFile } from "./process.ts";
import { feature } from "./server.ts";

const data = tempData();
afterAll(data.cleanup);
setSecret("anthropic", "sk-test");

// An X bookmarks export (twitter-web-exporter): posts that name no company the rules can tell.
type Tweet = { text: string; at?: string };
const dropX = (name: string, tweets: Tweet[]) => {
  const file = paths.drop(name);
  writeFileSync(
    file,
    JSON.stringify(
      tweets.map((t, i) => ({
        id: `${name.length}${i + 1}`,
        created_at: t.at ?? "2025-06-01T00:00:00.000Z",
        full_text: t.text,
        screen_name: `u${i}`,
      })),
    ),
  );
  return processFile(file);
};
const backlog = () => open().query("SELECT * FROM backlogs ORDER BY id DESC").get() as Backlog;
const posts = (id: number) =>
  open().query("SELECT * FROM signals WHERE backlog_id = ? ORDER BY id").all(id) as {
    id: number;
    text: string;
    posted_at: string;
    received_at: string;
    classify_tries: number;
    company_id: number | null;
  }[];

// The big drop: 160 posts, the first eight the ones the tests look at.
const big: Tweet[] = [
  { text: "Wendle is hiring a founding engineer https://t.co/wendle", at: "2026-01-02T00:00:00.000Z" },
  { text: "Acme is hiring https://t.co/pic", at: "2026-01-05T00:00:00.000Z" },
  { text: "Brio is hiring, come build with us", at: "2026-01-01T00:00:00.000Z" },
  { text: "Today Fennory raised $23M https://t.co/gone", at: "2026-01-10T00:00:00.000Z" },
  { text: "seven repos for Python" },
  { text: "errored" },
  { text: "cut off" },
  { text: "unreadable" },
  ...Array.from({ length: 152 }, (_, i) => ({ text: `thought number ${i}` })),
];
const landed: Record<string, string> = {
  "https://t.co/wendle": "https://wendle.travel/jobs",
  "https://t.co/pic": "https://x.com/acme/status/2/photo/1",
};
const follow = async (u: string) => landed[u] ?? u;

// The Batches API, faked: what was sent, and the answers once it has ended.
const sends: BatchCreateParams.Request[][] = [];
let ended = false;
let results: MessageBatchIndividualResponse[] = [];
const fake: Batches = {
  send: async (r) => {
    sends.push(r);
    return "msgbatch_1";
  },
  ended: async () => ended,
  results: async () =>
    (async function* () {
      yield* results;
    })(),
};
const usage = {
  input_tokens: 200,
  output_tokens: 20,
  cache_read_input_tokens: 2700,
  cache_creation_input_tokens: 0,
};
const answer = (id: number, a: Answer | string, stop = "end_turn") =>
  ({
    custom_id: String(id),
    result: {
      type: "succeeded",
      message: {
        stop_reason: stop,
        content: [{ type: "text", text: typeof a === "string" ? a : JSON.stringify(a) }],
        usage,
      },
    },
  }) as unknown as MessageBatchIndividualResponse;

test("a small drop waits for the nightly classifier as before; a big one is parked", async () => {
  expect(await dropX("small.json", [{ text: "we're hiring" }, { text: "nice post" }])).toMatchObject({
    kept: 2,
  });
  expect(open().query("SELECT count(*) AS n FROM backlogs").get()).toEqual({ n: 0 });
  expect(
    open().query("SELECT classify_tries, backlog_id FROM signals WHERE company_id IS NULL").all(),
  ).toEqual([
    { classify_tries: 0, backlog_id: null },
    { classify_tries: 0, backlog_id: null },
  ]);

  expect(await dropX("bookmarks.json", big)).toMatchObject({ kept: 160 });
  const b = backlog();
  expect(b).toMatchObject({ file: "bookmarks.json", posts: 160, stage: "waiting", batch_id: null });
  expect(posts(b.id).every((s) => s.classify_tries === PARKED)).toBe(true);
});

test("Sort now marks the backlog; the tick follows its links and sends one batch", async () => {
  const sort = (feature.routes!["/api/backlogs/:bid/sort"] as { POST: (req: unknown) => Response }).POST;
  expect(sort({ params: { bid: String(backlog().id) } }).status).toBe(200);
  expect(sort({ params: { bid: String(backlog().id) } }).status).toBe(409); // already asked
  expect(backlog().stage).toBe("links");

  // Past this month's cap the batch isn't sent: it waits.
  writeFileSync(paths.config(), "[caps]\nmonth_usd = 0\n");
  try {
    await sortBacklogs({ batches: fake, follow });
    expect(sends.length).toBe(0);
    expect(backlog().batch_id).toBeNull();
    expect(backlogLines()[0]!.line).toContain("past this month's cap");
  } finally {
    rmSync(paths.config());
  }

  await sortBacklogs({ batches: fake, follow });
  const [wendle, acme, , fennory] = posts(backlog().id);
  expect(wendle!.text).toBe("Wendle is hiring a founding engineer https://wendle.travel/jobs");
  expect(acme!.text).toBe("Acme is hiring [media]");
  expect(fennory!.text).toBe("Today Fennory raised $23M https://t.co/gone"); // went nowhere
  expect(backlog()).toMatchObject({ stage: "sent", batch_id: "msgbatch_1" });

  expect(sends.length).toBe(1);
  const [first] = sends[0]!;
  expect(sends[0]!.length).toBe(160);
  expect(first!.custom_id).toBe(String(wendle!.id));
  expect(first!.params).toMatchObject({
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    system: [{ type: "text", cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema" } },
  });
  expect(first!.params).not.toHaveProperty("temperature");
  expect(first!.params.messages).toEqual([
    { role: "user", content: expect.stringContaining("wendle.travel/jobs") },
  ]);
});

test("a batch once sent is never sent again, through a restart", async () => {
  await sortBacklogs({ batches: fake, follow });
  close(); // a new process: everything it knows is in the db
  await sortBacklogs({ batches: { ...fake }, follow });
  expect(sends.length).toBe(1);
  expect(backlog().stage).toBe("sent");
  expect(backlogLines()[0]!.line).toBe(
    "Sorting 160 posts from bookmarks.json: sent to the model, waiting for its answers",
  );
});

test("its answers are filed hiring last, newest hiring last of all; failures go back to the nightly classifier", async () => {
  const ids = posts(backlog().id).map((s) => s.id);
  const id = (i: number) => ids[i]!;
  results = [
    answer(id(0), { signal: "hiring", company: "Wendle", domain: "wendle.travel" }),
    answer(id(1), { signal: "hiring", company: "Acme", domain: "" }),
    answer(id(2), { signal: "hiring", company: "Brio", domain: "" }),
    answer(id(3), { signal: "funding", company: "Fennory", domain: "" }),
    answer(id(4), { signal: "none", company: "", domain: "" }),
    {
      custom_id: String(id(5)),
      result: { type: "errored", error: {} },
    } as unknown as MessageBatchIndividualResponse,
    answer(id(6), '{"signal": "hir', "max_tokens"),
    answer(id(7), "not json"),
    // The last ten have no answer at all.
    ...ids.slice(8, 150).map((s) => answer(s, { signal: "none", company: "", domain: "" })),
  ];
  ended = true;
  await sortBacklogs({ batches: fake, follow });
  expect(sends.length).toBe(1);

  const b = backlog();
  expect(b.stage).toBe("done");
  const outcome = JSON.parse(b.outcome!) as Outcome;
  expect(outcome).toMatchObject({ file: 4, unknown: 0, answered: 143, failed: 13 });
  expect(backlogLines()[0]!.line).toMatch(
    /^bookmarks\.json: filed 4 · 0 company unknown · 143 not a signal · 13 back to the nightly classifier · \$0\.\d\d$/,
  );

  // Discovery takes the newest last_signal_at first: the newest hiring post's company, then older hiring.
  const order = (
    open()
      .query(
        "SELECT name FROM companies WHERE name IN ('Wendle', 'Acme', 'Brio', 'Fennory') ORDER BY last_signal_at",
      )
      .all() as { name: string }[]
  ).map((c) => c.name);
  expect(order).toEqual(["Fennory", "Brio", "Wendle", "Acme"]);
  expect(open().query("SELECT domain FROM companies WHERE name = 'Wendle'").get()).toEqual({
    domain: "wendle.travel",
  });

  const after = posts(b.id);
  // Dated by the post, so the Inbox doesn't take the backlog as new.
  expect(after.every((s) => s.received_at === s.posted_at)).toBe(true);
  for (const i of [5, 6, 7, 150, 159])
    expect(after[i]).toMatchObject({ classify_tries: 0, company_id: null });
  expect(after[4]).toMatchObject({ classify_tries: ANSWERED, company_id: null });
  // Nothing is left parked: each post is filed, answered or back with the nightly classifier.
  expect(after.some((s) => s.company_id === null && s.classify_tries === PARKED)).toBe(false);

  // The real cost, half price, once.
  const spent = entries().filter((e) => e.note === `drop backlog ${b.id} batch msgbatch_1`);
  expect(spent.length).toBe(1);
  expect(spent[0]!.usd).toBeCloseTo(outcome.usd);
  expect(spent[0]!.usage).toEqual({
    ...usage,
    input_tokens: 200 * 149,
    output_tokens: 20 * 149,
    cache_read_input_tokens: 2700 * 149,
  });

  await sortBacklogs({ batches: fake, follow }); // done: nothing more happens
  expect(entries().filter((e) => e.note?.startsWith("drop backlog")).length).toBe(1);
});

test("on the subscription the batch is asked here through Claude Code, its answers kept as they come", async () => {
  const bin = path.join(data.dir, "claude.sh");
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >/dev/null\necho '{"type":"result","is_error":false,"total_cost_usd":0.0001,"structured_output":{"signal":"none","company":"","domain":""}}'\n`,
    { mode: 0o755 },
  );
  process.env.JOBSIGNAL_CLAUDE_BIN = bin;
  setSignedIn({ in: true, plan: "pro" });
  try {
    const req = (custom_id: string) =>
      ({
        custom_id,
        params: {
          model: "claude-haiku-5-5",
          max_tokens: 1024,
          system: [{ type: "text", text: "sys" }],
          messages: [{ role: "user", content: "a post" }],
          output_config: { format: { type: "json_schema", schema: { type: "object" } } },
        },
      }) as BatchCreateParams.Request;
    const id = await localBatches.send([req("1"), req("2")]);
    expect(await localBatches.ended(id)).toBe(true);
    const got: string[] = [];
    for await (const r of await localBatches.results(id)) got.push(`${r.custom_id} ${r.result.type}`);
    expect(got.sort()).toEqual(["1 succeeded", "2 succeeded"]);
    expect(entries().at(-1)).toMatchObject({ station: "classify", usd: 0 });
  } finally {
    setSignedIn({ in: false, plan: null });
    delete process.env.JOBSIGNAL_CLAUDE_BIN;
  }
});

test("a short link is followed only to public addresses, each checked before it is asked", async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return new Response(null, { status: 301, headers: { location: "https://inside.invalid/admin" } });
  }) as typeof fetch;
  try {
    // A name that doesn't point to a public address is named, never asked.
    expect(await followLink("https://93.184.215.14/a")).toBe("https://inside.invalid/admin");
    expect(asked).toEqual(["https://93.184.215.14/a"]);
    expect(await followLink("http://10.0.0.1/a")).toBe("http://10.0.0.1/a");
    expect(asked).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

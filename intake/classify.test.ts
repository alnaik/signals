import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { open } from "../core/db.ts";
import { setSecret } from "../core/keychain.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import {
  type Answer,
  COMPANY_UNKNOWN,
  check,
  classifyPending,
  nameShown,
  type PostInput,
  sameName,
} from "./classify.ts";
import { intakeLead } from "./leads.ts";
import type { Lead } from "./types.ts";

const data = tempData();
// The small model on the API key (mocked below), never a real Claude Code run.
writeFileSync(paths.config(), '[runner]\nmode = "claude-code-api-key"\n');
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
setSecret("anthropic", "sk-test");

let sent: Record<string, unknown> | null = null;
const answer = (out: Answer) =>
  (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(out) }],
      usage: { input_tokens: 300, output_tokens: 20 },
    });
  }) as unknown as typeof fetch;

// A lead whose company no rule can tell: kept as a signal with no company.
const waiting = (lead: Partial<Lead> & { url: string }) =>
  expect(intakeLead({ source: "x", source_tag: "X bookmark", ...lead }).result).toBe("pending");
const placed = () =>
  open()
    .query(
      "SELECT c.domain, c.name, s.url FROM signals s JOIN companies c ON c.id = s.company_id ORDER BY s.id",
    )
    .all() as { domain: string | null; name: string; url: string }[];
const tries = (url: string) =>
  (open().query("SELECT classify_tries AS n FROM signals WHERE url = ?").get(url) as { n: number }).n;

test("a waiting signal is classified directly and placed under its company", async () => {
  waiting({
    url: "https://x.com/wrenna_builds/status/1",
    text: "We're hiring a design engineer at Fernhill (fernhill.io)",
  });
  globalThis.fetch = answer({ signal: "hiring", company: "Fernhill", domain: "fernhill.io" });
  expect(await classifyPending()).toBe("1 classified, 0 pending");
  expect(placed()).toEqual([
    { domain: "fernhill.io", name: "Fernhill", url: "https://x.com/wrenna_builds/status/1" },
  ]);
  // The model thinks before it answers: 300 tokens cut it off.
  expect(sent?.max_tokens).toBe(1024);
  expect(sent?.temperature).toBeUndefined();
});

test("a failed call is tried once more, then dropped", async () => {
  waiting({ url: "https://x.com/a/status/2", text: "hi" });
  globalThis.fetch = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
  expect(await classifyPending()).toBe("0 classified, 1 pending");
  expect(await classifyPending()).toBe("0 classified, 0 pending");
});

test('"Unknown" from the model places nothing; a hiring post waits for more to see', async () => {
  waiting({
    url: "https://news.ycombinator.com/item?id=4",
    text: "I'm applying for the Growth Lead role",
    source: "hn",
    source_tag: "HN",
  });
  globalThis.fetch = answer({ signal: "hiring", company: "Unknown", domain: "unknownharbor.example" });
  const before = placed().length;
  await classifyPending();
  expect(placed().length).toBe(before);
  expect(
    (open().query("SELECT count(*) AS n FROM companies WHERE name = 'Unknown'").get() as { n: number }).n,
  ).toBe(0);
  expect(tries("https://news.ycombinator.com/item?id=4")).toBe(COMPANY_UNKNOWN);
  expect(await classifyPending()).toBe("0 classified, 0 pending");
});

const post = (o: Partial<PostInput>): PostInput => ({ url: "https://x.com/someone/status/1", ...o });

describe("name check", () => {
  test("case, punctuation, spaces, @ and the possessive don't matter", () => {
    expect(nameShown("Tessly", "I quit my job to join Tessly's team")).toBe(true);
    expect(nameShown("Ferro Weave", "Hiring engineers for @FerroWeave")).toBe(true);
    expect(nameShown("@quillmark", "hiring at @Quillmark")).toBe(true);
    expect(nameShown("Café Bloom", "join cafe bloom!")).toBe(true);
  });
  test("one name written another way is the same name; a name inside another isn't", () => {
    expect(sameName("Brindlepost", "Brindlepost (YC W19)")).toBe(true);
    expect(sameName("Larkhaven Corporation", "Larkhaven")).toBe(true);
    expect(sameName("VORTALIN", "Vortalin")).toBe(true);
    expect(sameName("Q-GROUP, INC.", "Q Group, Inc.")).toBe(true);
    expect(sameName("Tarn", "Tarnwell")).toBe(false);
    expect(sameName("BrimTech", "BrimTech Consulting")).toBe(false);
  });
});

describe("check", () => {
  test("a failed name check is unknown for any label", () => {
    const p = post({ text: "we raised a seed round" });
    expect(check(p, { signal: "funding", company: "Halvane", domain: "" })).toEqual({
      name: "fail",
      domain: "empty",
      decision: { state: "unknown" },
    });
  });
  test("a domain counts only when shown, and never a platform's", () => {
    const p = post({
      text: "Wendle is hiring https://docs.google.com/forms/d/x and https://www.wendle.travel/careers",
    });
    expect(check(p, { signal: "hiring", company: "Wendle", domain: "wendle.travel" })).toEqual({
      name: "pass",
      domain: "kept",
      decision: { state: "file", name: "Wendle", domain: "wendle.travel" },
    });
    expect(check(p, { signal: "hiring", company: "Wendle", domain: "docs.google.com" }).domain).toBe(
      "platform",
    );
    expect(check(p, { signal: "hiring", company: "Wendle", domain: "wendle.com" }).domain).toBe("not_shown");
    expect(
      check(p, { signal: "hiring", company: "Wendle", domain: "https://wendle.travel/careers" }).domain,
    ).toBe("kept");
  });
});

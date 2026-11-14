import { afterAll, afterEach, expect, test } from "bun:test";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { record } from "../core/ledger.ts";
import { tempData } from "../core/testing.ts";
import { describeRow, spendNow } from "./spend.ts";

const data = tempData();
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  deleteSecret("contextdev");
  data.cleanup();
});

const now = new Date("2026-11-04T12:00:00Z");
const at = (iso: string) => ({ ts: iso });

test("one row per service: Context.dev over its own period from its own count, the rest over the month", async () => {
  // Before Context.dev's period (the 10th) and before the month: counted by neither.
  record({
    ...at("2026-10-09T00:00:00Z"),
    kind: "provider",
    station: "discover-search",
    provider: "contextdev",
    usd: 0,
    usage: { credits: 5 },
  });
  // In its period, before the month.
  record({
    ...at("2026-10-20T00:00:00Z"),
    kind: "provider",
    station: "discover-search",
    provider: "contextdev",
    usd: 0,
    usage: { credits: 2 },
  });
  record({
    ...at("2026-11-02T00:00:00Z"),
    kind: "provider",
    station: "board-search",
    provider: "contextdev",
    usd: 0,
    usage: { credits: 1 },
  });
  record({
    ...at("2026-11-02T00:00:01Z"),
    kind: "provider",
    station: "linkcheck",
    provider: "contextdev",
    usd: 0,
    note: "read",
    failed: true,
  });
  record({ ...at("2026-11-02T00:00:00Z"), kind: "provider", station: "work", provider: "exa", usd: 0.006 });
  record({
    ...at("2026-11-02T00:00:00Z"),
    kind: "provider",
    station: "work",
    provider: "exa",
    usd: 0.007,
    usage: { estimated: 1 },
  });
  record({
    ...at("2026-11-02T00:00:00Z"),
    kind: "model",
    station: "read-page",
    model: "claude-haiku-5-5",
    usd: 0.002,
  });
  record({
    ...at("2026-11-02T00:00:00Z"),
    kind: "model",
    station: "worker",
    model: "claude-sonnet-5-5",
    usd: 0,
    notional_usd: 0.05,
    note: "claude-code-subscription",
  });
  record({ ...at("2026-11-02T00:00:00Z"), kind: "provider", station: "work", provider: "github", usd: 0 });

  setSecret("contextdev", "k");
  let asked = 0;
  globalThis.fetch = (async (url: string) => {
    asked++;
    expect(String(url)).toEndWith("/org/usage");
    return Response.json({
      credits_remaining: 900,
      period: { start: "2026-10-10T07:01:00.000Z", credits_used: 10 },
      next_refill: { at: "2026-11-10T08:01:00.000Z", credits: 1000 },
      auto_topup: { enabled: false },
    });
  }) as typeof fetch;

  const rows = await spendNow(now);
  expect(rows.map((r) => r.key)).toEqual(["contextdev", "exa", "anthropic", "subscription", "free"]);
  const cd = rows[0]!;
  expect(cd.since).toBe("2026-10-10T07:01:00.000Z");
  expect(cd.by).toEqual({ "discover-search": 2, "board-search": 1, linkcheck: 0 }); // a failed call spent none
  expect(cd.credits).toMatchObject({ used: 10, recorded: 3, remaining: 900, asked: true });
  expect(describeRow(cd)[0]).toBe("10 credits used since Oct 10 · 900 left · refills to 1,000 on Nov 10");
  expect(describeRow(cd)[2]).toStartWith("Context.dev counts 7 more than Job Signal's ledger");
  expect(rows[1]).toMatchObject({ calls: 2, estimated: 1 });
  expect(rows[1]!.usd).toBeCloseTo(0.013);
  expect(rows[2]).toMatchObject({ calls: 1, by: { "read-page": 0.002 } });
  expect(rows[3]).toMatchObject({ calls: 1, usd: 0, notional: 0.05 });
  expect(rows[4]).toMatchObject({ calls: 1, by: { github: 1 } });

  // Asked again within the minute: the last answer, no second call.
  await spendNow(now);
  expect(asked).toBe(1);
});

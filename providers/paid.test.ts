import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { DAY } from "../core/db.ts";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { entries } from "../core/ledger.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import contextdev, { creditsThisMonth, titleHolds } from "./contextdev.ts";
import exa from "./exa.ts";
import hunter from "./hunter.ts";
import * as kept from "./kept.ts";
import { call, setProviders } from "./registry.ts";

const data = tempData();
afterAll(() => {
  // Later test files must never find a paid key (detection's board search would call out).
  for (const k of ["exa", "contextdev", "parallel", "hunter", "firecrawl"]) deleteSecret(k);
  data.cleanup();
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setProviders(null);
});
for (const k of ["exa", "contextdev", "parallel", "hunter", "firecrawl"]) setSecret(k, `${k}-key`);

type Route = (url: string, body: Record<string, unknown> | null, headers: Headers) => unknown;
const calls: { url: string; body: Record<string, unknown> | null }[] = [];
function mock(route: Route) {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const out = route(url, body, new Headers(init?.headers));
    if (out instanceof Response) return out;
    return Response.json(out);
  }) as typeof fetch;
}

test("exa: two calls at once keep their own cost; a failed call never takes the one before's", async () => {
  mock((_url, b) => ({
    results: [{ url: `https://t.dev/${b!.query}`, title: String(b!.query) }],
    costDollars: { total: b!.query === "a" ? 0.005 : 0.009 },
  }));
  await Promise.all([
    call(exa, "search", ["a", {}], { station: "t-two" }),
    call(exa, "search", ["b", {}], { station: "t-two" }),
  ]);
  const two = entries().filter((e) => e.station === "t-two");
  expect(two.map((e) => e.usd).sort()).toEqual([0.005, 0.009]);
  // Exa answered with an error: not billed, marked failed.
  mock(() => new Response("bad", { status: 400 }));
  await expect(call(exa, "search", ["c", {}], { station: "t-fail" })).rejects.toThrow("HTTP 400");
  expect(entries().at(-1)).toMatchObject({ station: "t-fail", usd: 0, failed: true });
  expect(entries().at(-1)?.usage).toBeUndefined();
  // No answer at all (a dropped connection): it may have been billed, so the price list's estimate.
  mock(() => {
    throw new Error("socket closed");
  });
  await expect(call(exa, "search", ["d", {}], { station: "t-fail" })).rejects.toThrow();
  expect(entries().at(-1)).toMatchObject({ usd: 0.007, failed: true });
  // Answered without a cost: the estimate, not marked as Exa's own figure.
  mock(() => ({ results: [] }));
  await call(exa, "search", ["e", {}], { station: "t-est" });
  expect(entries().at(-1)).toMatchObject({ usd: 0.007, usage: { estimated: 1 } });
});

test("context.dev web search and map go through call, each priced by its own credits", async () => {
  writeFileSync(paths.config(), "[provider.contextdev]\nusd_per_credit = 0.001\n");
  mock((url) =>
    url.endsWith("/web/search")
      ? {
          results: [
            {
              url: "https://jobs.ashbyhq.com/quillmark/9",
              title: "Engineer",
              description: "Quillmark · Denver",
            },
          ],
          key_metadata: { credits_consumed: 2 },
        }
      : {
          success: true,
          domain: "larkspur.example",
          urls: [{ url: "https://larkspur.example/careers", title: "Careers" }],
        },
  );
  const found = await call(
    contextdev,
    "search",
    ["quillmark engineer", { n: 20, includeDomains: ["jobs.ashbyhq.com", "quillmark.dev"] }],
    { station: "t" },
  );
  expect(found).toEqual([
    { url: "https://jobs.ashbyhq.com/quillmark/9", title: "Engineer", snippet: "Quillmark · Denver" },
  ]);
  expect(calls[0]!.body).toEqual({
    query: "quillmark engineer",
    numResults: 20,
    includeDomains: ["jobs.ashbyhq.com", "quillmark.dev"],
  });
  expect(entries().at(-1)).toMatchObject({ provider: "contextdev", note: "search" });
  expect(entries().at(-1)?.usd).toBeCloseTo(0.002);
  const urls = await call(contextdev, "map", ["larkspur.example", { search: "careers" }], { station: "t" });
  expect(urls.map((u) => u.url)).toEqual(["https://larkspur.example/careers"]);
  expect(calls.at(-1)!.url).toContain("/web/urls?domain=larkspur.example");
  expect(calls.at(-1)!.url).toContain("search=careers");
  // No credits reported: priced as declared, 2 credits for a map with a search term.
  expect(entries().at(-1)).toMatchObject({ note: "map" });
  expect(entries().at(-1)?.usd).toBeCloseTo(0.002);
  // Free credits (price 0): the month's count comes from the credits each call recorded, not NaN.
  expect(entries().at(-1)?.usage).toEqual({ credits: 2 });
  const before = creditsThisMonth().t ?? 0;
  writeFileSync(paths.config(), "[provider.contextdev]\nusd_per_credit = 0\n");
  await call(contextdev, "search", ["quillmark engineer", { n: 10 }], { station: "t" });
  expect(creditsThisMonth().t).toBe(before + 2);
  // A call Context.dev refused (a blocked site) spent nothing.
  mock(() => new Response('{"error_code":"WEBSITE_BLOCKED"}', { status: 403 }));
  await expect(call(contextdev, "read", ["https://blocked.dev", {}], { station: "t" })).rejects.toThrow();
  expect(entries().at(-1)).toMatchObject({ usd: 0, failed: true });
  expect(creditsThisMonth().t).toBe(before + 2);
});

test("context.dev people: by the company's name, a title at a time, only people at this employer with that title", async () => {
  writeFileSync(paths.config(), "[provider.contextdev]\nusd_per_credit = 0\n");
  const person = (name: string, title: string, domain: string | null) => ({
    name,
    profiles: [`https://linkedin.com/in/${name.split(" ")[0]!.toLowerCase()}`],
    role: { title, company: domain ? { name: "x", domain } : null },
  });
  mock((url, body) => {
    expect(url).toEndWith("/people/search");
    const q = String(body?.query);
    if (q.startsWith("Engineering Manager")) return new Response("timeout", { status: 408 });
    if (q.startsWith("Head of Engineering"))
      // Right employer, wrong title; right title, a namesake employer: neither counts.
      return {
        results: [
          person("Ann Lee", "Software Engineer", "tallowly.com"),
          person("Bo Diaz", "Head of Engineering", "tallowlyads.net"),
        ],
        key_metadata: { credits_consumed: 10 },
      };
    return {
      results: [
        person("Cy Park", "Director of Engineering, Cloud", "cloud.tallowly.com"),
        person("Di Wu", "Director, Engineering", null),
      ],
      key_metadata: { credits_consumed: 10 },
    };
  });
  const found = await call(
    contextdev,
    "people",
    [
      "tallowly.com",
      ["Engineering Manager", "Head of Engineering", "Director of Engineering", "VP Engineering"],
      "Tallowly",
    ],
    { station: "t" },
  );
  expect(found).toEqual([
    {
      name: "Cy Park",
      role: "Director of Engineering, Cloud",
      profile_urls: ["https://linkedin.com/in/cy"],
      source: "contextdev",
    },
  ]);
  // Stops at the first title that finds someone; the timeout cost nothing.
  expect(calls.map((c) => c.body?.query)).toEqual([
    "Engineering Manager at Tallowly",
    "Head of Engineering at Tallowly",
    "Director of Engineering at Tallowly",
  ]);
  expect(entries().at(-1)).toMatchObject({ provider: "contextdev", note: "people", usage: { credits: 20 } });
  expect(titleHolds("Sr. Engineering Manager", "Engineering Manager")).toBe(true);
  expect(titleHolds("Co-Founder & CTO", "CTO")).toBe(true);
  expect(titleHolds("Product Manager", "Engineering Manager")).toBe(false);
});

test("context.dev people: a search asked in the last 90 days is answered from its kept answer, at no credit", async () => {
  writeFileSync(paths.config(), "[provider.contextdev]\nusd_per_credit = 0\n");
  mock((_url, body) => {
    const q = String(body?.query);
    if (q === "CTO at Flaky") return new Response("timeout", { status: 408 });
    if (q === "CTO at Broke") return new Response("out of credits", { status: 402 });
    if (q.startsWith("founder")) return { results: [], key_metadata: { credits_consumed: 0 } };
    const at = q.endsWith("Beta") ? "beta.dev" : q.endsWith("Oldco") ? "oldco.dev" : "acme.dev";
    return {
      results: [
        { name: `Ann ${q}`, profiles: [], role: { title: q.split(" at ")[0], company: { domain: at } } },
      ],
      key_metadata: { credits_consumed: 10 },
    };
  });
  const ask = (domain: string, title: string, company?: string) =>
    call(contextdev, "people", [domain, [title], company], { station: "t-kept" });
  const first = await ask("acme.dev", "CTO", "Acme");
  expect(first.map((p) => p.name)).toEqual(["Ann CTO at Acme"]);
  expect(entries().at(-1)?.usage).toEqual({ credits: 10 });
  // The same question, however it is written: not asked again, the same people, no credit.
  expect(await ask("acme.dev", "CTO", "Acme")).toEqual(first);
  expect(await ask("acme.dev", "cto", "  ACME ")).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(entries().at(-1)?.usage).toEqual({ credits: 0 });
  // Another title, another company: asked.
  await ask("acme.dev", "Head of Engineering", "Acme");
  await ask("beta.dev", "CTO", "Beta");
  expect(calls.map((c) => c.body?.query)).toEqual([
    "CTO at Acme",
    "Head of Engineering at Acme",
    "CTO at Beta",
  ]);
  // No one found is kept too: not asked again.
  calls.length = 0;
  expect(await ask("acme.dev", "founder", "Acme")).toEqual([]);
  expect(await ask("acme.dev", "founder", "Acme")).toEqual([]);
  expect(calls).toHaveLength(1);
  // An answer kept 91 days ago is asked again; one kept 89 days ago isn't.
  calls.length = 0;
  const old = { results: [], key_metadata: { credits_consumed: 0 } };
  kept.put("contextdev", "people-search", "CTO at Oldco", old, new Date(Date.now() - 91 * DAY));
  kept.put("contextdev", "people-search", "CTO at Newco", old, new Date(Date.now() - 89 * DAY));
  expect((await ask("oldco.dev", "CTO", "Oldco")).map((p) => p.name)).toEqual(["Ann CTO at Oldco"]);
  expect(await ask("newco.dev", "CTO", "Newco")).toEqual([]);
  expect(calls.map((c) => c.body?.query)).toEqual(["CTO at Oldco"]);
  // A failed call, or out of credits, keeps nothing: asked again.
  calls.length = 0;
  for (const company of ["Flaky", "Flaky", "Broke", "Broke"])
    await ask(`${company.toLowerCase()}.dev`, "CTO", company);
  expect(calls).toHaveLength(4);
});

test("context.dev people: a kept answer isn't priced against the caps; a question not kept still is", async () => {
  writeFileSync(paths.config(), "[caps]\nmonth_usd = 0\n\n[provider.contextdev]\nusd_per_credit = 0.001\n");
  kept.put("contextdev", "people-search", "CTO at Capco", { results: [] });
  expect(contextdev.estimate?.("people", ["capco.dev", ["CTO"], "Capco"])).toBe(0);
  expect(contextdev.estimate?.("people", ["capco.dev", ["CTO", "founder"], "Capco"])).toBeCloseTo(0.01);
  mock(() => {
    throw new Error("no network");
  });
  expect(await call(contextdev, "people", ["capco.dev", ["CTO"], "Capco"], { station: "t" })).toEqual([]);
  await expect(
    call(contextdev, "people", ["capco.dev", ["founder"], "Capco"], { station: "t" }),
  ).rejects.toThrow("monthly cap");
  writeFileSync(paths.config(), "[provider.contextdev]\nusd_per_credit = 0\n");
});

test("hunter: a cited email is verified, an uncited one a pattern, nothing found is empty", async () => {
  const person = { name: "Maya Chen", role: "CTO", profile_urls: [], source: "t", domain: "tessera.dev" };
  mock((url, _b, h) => {
    expect(h.get("x-api-key")).toBe("hunter-key");
    expect(new URL(url).searchParams.get("last_name")).toBe("Chen");
    return { data: { email: "maya@tessera.dev", score: 91, sources: [{ uri: "https://tessera.dev/team" }] } };
  });
  expect(await call(hunter, "contact", [person], { station: "t" })).toEqual([
    {
      channel: "email",
      value: "maya@tessera.dev",
      confidence: "verified",
      source: "hunter",
      url: "https://tessera.dev/team",
    },
  ]);
  mock(() => ({ data: { email: "maya@tessera.dev", score: 80, sources: [] } }));
  expect((await call(hunter, "contact", [person], { station: "t" }))[0]?.confidence).toBe("pattern");
  mock(() => ({ data: { email: null } }));
  expect(await call(hunter, "contact", [person], { station: "t" })).toEqual([]);
});

test("context.dev: one call at a time, and a 429 is waited out and asked again", async () => {
  writeFileSync(paths.config(), "[provider.contextdev]\nusd_per_credit = 0\n");
  const orig = Bun.sleep;
  const waits: number[] = [];
  (Bun as { sleep: unknown }).sleep = async (ms: number) => {
    waits.push(ms);
  };
  let inFlight = 0;
  let most = 0;
  let first = true;
  globalThis.fetch = (async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (first) {
      first = false;
      return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
    }
    return Response.json({
      results: [{ url: "https://t.dev/", title: "T" }],
      key_metadata: { credits_consumed: 1 },
    });
  }) as unknown as typeof fetch;
  try {
    const [a, b] = await Promise.all([
      call(contextdev, "search", ["a", {}], { station: "t" }),
      call(contextdev, "search", ["b", {}], { station: "t" }),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(most).toBe(1);
    expect(waits).toEqual([2000]);
  } finally {
    (Bun as { sleep: unknown }).sleep = orig;
  }
});

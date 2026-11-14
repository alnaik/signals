import { afterAll, afterEach, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isLinkedIn } from "../apply/linkedin.ts";
import { jsonLdJobs } from "../ats/careers.ts";
import { publicRequests } from "../ats/render.ts";
import { lock } from "../intake/run.ts";
import { mcpProviders } from "../providers/mcp.ts";
import { search, setProviders, setRunBudget } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import { assertPublicHost, isPublicUrl, politeGet, readCapped } from "./http.ts";
import { paths } from "./paths.ts";
import { tempData } from "./testing.ts";
import { failure, failures, redact } from "./trace.ts";

const data = tempData();
afterAll(data.cleanup);
afterEach(() => {
  setProviders(null);
  setRunBudget(null);
});

test("thread paths refuse anything but a domain", () => {
  expect(paths.thread("linear.app")).toEndWith("threads/linear.app");
  for (const bad of ["../../me", "..", "a/b.com", "x.com/../..", ""])
    expect(() => paths.thread(bad)).toThrow();
});

test("a body is read only up to its cap", async () => {
  const big = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    }),
  );
  const text = await readCapped(big, 200_000);
  expect(text.length).toBe(200_000);
});

test("paid lookups stop at the run budget and fall through to free ones", async () => {
  const paid: Provider = { name: "paid", label: "Paid", cost: { search: 0.05 }, search: async () => [] };
  const free: Provider = {
    name: "free",
    label: "Free",
    cost: { search: 0 },
    search: async () => [{ url: "https://a.dev", title: "a", snippet: "" }],
  };
  setProviders([paid, free]);
  writeFileSync(paths.config(), '[caps]\nmonth_usd = 100\n[providers]\nsearch = ["paid", "free"]\n');
  setRunBudget(0.12);
  const steps = [];
  for (let i = 0; i < 3; i++) steps.push((await search("q", {}, { station: "worker" })).steps[0]);
  expect(steps.map((s) => s?.error ?? "ran")).toEqual([
    "ran",
    "ran",
    "Paid skipped · this run's lookup budget",
  ]);
});

test("reserved ranges are refused; a URL is public only if it's http(s) on a public host", async () => {
  for (const ip of ["192.0.0.8", "198.18.4.1", "198.19.255.1", "240.0.0.1", "127.0.0.1", "10.1.1.1"])
    await expect(assertPublicHost(ip)).rejects.toThrow("private");
  await expect(assertPublicHost("93.184.215.14")).resolves.toBeUndefined();
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://localhost/x",
    "http://127.0.0.1/",
    "http://intranet/",
  ])
    expect(isPublicUrl(bad)).toBe(false);
  expect(isPublicUrl("https://acme.dev/careers/1")).toBe(true);
});

test("a careers page's JSON-LD postings keep only public web links", () => {
  const post = (url: string) => ({ "@type": "JobPosting", title: url, url });
  const jobs = jsonLdJobs(
    [
      post("https://acme.dev/jobs/1"),
      post("javascript:alert(1)"),
      post("file:///etc/hosts"),
      post("http://127.0.0.1/x"),
    ],
    "https://acme.dev/careers",
  );
  expect(jobs.map((j) => j.url)).toEqual(["https://acme.dev/jobs/1"]);
});

test("the browser never loads file: URLs; its own data: assets are fine", async () => {
  const ok = publicRequests();
  expect(await ok("file:///etc/passwd")).toBe(false);
  expect(await ok("ftp://example.com/x")).toBe(false);
  expect(await ok("data:image/png;base64,AAAA")).toBe(true);
});

test("LinkedIn pages are never read, by host, a redirect hop included", async () => {
  for (const u of [
    "https://uk.linkedin.com/jobs/view/1",
    "https://www.linkedin.com./in/x",
    "https://lnkd.in/abc",
  ]) {
    expect(isLinkedIn(u)).toBe(true);
    await expect(politeGet(u)).rejects.toThrow("LinkedIn pages are never read");
    expect(await publicRequests()(u)).toBe(false);
  }
  expect(isLinkedIn("https://linkedin.com.evil.example/jobs")).toBe(false);
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL) => {
    asked.push(String(url));
    return url.pathname === "/robots.txt"
      ? new Response("")
      : new Response(null, { status: 302, headers: { location: "https://www.linkedin.com/jobs/view/1" } });
  }) as unknown as typeof fetch;
  try {
    await expect(politeGet("https://93.184.215.14/careers")).rejects.toThrow("LinkedIn pages are never read");
  } finally {
    globalThis.fetch = real;
  }
  expect(asked.some((u) => u.includes("linkedin"))).toBe(false);
});

test("a page or robots.txt that redirects into the person's network is never asked there", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: URL) => {
    asked.push(String(url));
    return url.pathname === "/robots.txt"
      ? new Response(null, { status: 301, headers: { location: "http://127.0.0.1/robots.txt" } })
      : new Response(null, { status: 302, headers: { location: "http://10.0.0.1/admin" } });
  }) as unknown as typeof fetch;
  try {
    await expect(politeGet("https://93.184.215.40/careers")).rejects.toThrow("refused private address");
  } finally {
    globalThis.fetch = real;
  }
  expect(asked).toEqual(["https://93.184.215.40/robots.txt", "https://93.184.215.40/careers"]);
});

test("token-like strings are redacted before a failure is stored", () => {
  failure(
    "test",
    "redact",
    new Error("401 with sk-ant-api03-abcdefghijklmnop and Bearer abcdefghijklmnopqrstuvwxyz"),
    {
      url: "https://api.example.com/v1?api_key=SECRET123&q=ok",
      hash: "a".repeat(40),
    },
  );
  const f = failures(new Date(0)).at(-1)!;
  expect(f.error).toBe("401 with sk-ant-[redacted] and Bearer [redacted]");
  expect(f.context).toEqual({
    url: "https://api.example.com/v1?api_key=[redacted]&q=ok",
    hash: "[redacted]",
  });
  expect(redact("thread tessera.dev, entry 01JB2X3Y4Z5A6B7C8D9E0F1G2H")).toBe(
    "thread tessera.dev, entry 01JB2X3Y4Z5A6B7C8D9E0F1G2H",
  );
});

test("an MCP tool with no declared cost doesn't run", () => {
  writeFileSync(
    paths.config(),
    '[provider.mcp.brave]\ncommand = ["true"]\n[provider.mcp.brave.search]\ntool = "s"\n[provider.mcp.free]\ncommand = ["true"]\n[provider.mcp.free.search]\ntool = "s"\ncost = 0\n',
  );
  const list = mcpProviders();
  expect(list.find((p) => p.name === "brave")?.search).toBeUndefined();
  expect(list.find((p) => p.name === "free")?.cost.search).toBe(0);
});

test("a Context.dev crawl is priced at its page cap before it runs", async () => {
  const { default: contextdev } = await import("../providers/contextdev.ts");
  writeFileSync(paths.config(), "");
  expect(contextdev.cost.read).toBeGreaterThan(0);
  expect(contextdev.estimate?.("read", ["https://a.dev", { site: true, max_pages: 50 }])).toBeCloseTo(
    50 * contextdev.cost.read!,
  );
  expect(contextdev.estimate?.("read", ["https://a.dev", {}])).toBeUndefined();
});

test("a tick lock older than two hours is stale, even if its pid is alive", () => {
  const lockFile = path.join(data.dir, "tick.lock");
  writeFileSync(lockFile, String(process.pid)); // alive: this process
  expect(lock()).toBeNull();
  const old = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(lockFile, old, old);
  const release = lock();
  expect(release).not.toBeNull();
  release?.();
});

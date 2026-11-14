import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  assertPublicHost,
  htmlToText,
  parseRobots,
  robotsAllow,
  robotsAllowed,
  robotsMatch,
} from "../core/http.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { failuresFile } from "../core/trace.ts";
import hn, { parseComment } from "../sources/hn/index.ts";

const data = tempData();
afterAll(data.cleanup);
// The sources' reads go through politeGet with fetch stood in: no need to space them a second apart.
writeFileSync(paths.config(), "[polling]\nper_host_rps = 1000\n");

test("HN comments yield the company and its own link", () => {
  const html =
    'Tessera Labs | Design Engineer | London or REMOTE (UK) | <a href="https:&#x2F;&#x2F;tessera.dev&#x2F;jobs">https:&#x2F;&#x2F;tessera.dev&#x2F;jobs</a><p>We rebuilt onboarding...';
  const p = parseComment(html);
  expect(p.company).toBe("Tessera Labs");
  expect(p.domain).toBe("tessera.dev");
  expect(p.text).toContain("We rebuilt onboarding");
  expect(
    parseComment('Ask about <a href="https://news.ycombinator.com/item?id=1">this</a>').domain,
  ).toBeUndefined();
});

test("HN reads the thread in one request; a comment the filters skipped is read again after they change", async () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const children = [
    { id: 1, author: "a", text: "Acme | Engineer | London", created_at_i: 1_790_000_000 },
    { id: 2, author: "b", text: "Globex | Engineer | Austin, TX", created_at_i: 1_790_000_000 },
    { id: 3, author: null, text: null },
  ];
  globalThis.fetch = (async (u: URL | string) => {
    const url = String(u);
    asked.push(url);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url.includes("/user/whoishiring")) return Response.json({ submitted: [100] });
    if (url.includes("/item/100.json")) return Response.json({ id: 100, title: "Ask HN: Who is hiring?" });
    if (url === "https://hn.algolia.com/api/v1/items/100") return Response.json({ id: 100, children });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  try {
    writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: { locations: ["London"] } }));
    expect((await hn.fetch(null)).map((l) => l.company_hint)).toEqual(["Acme"]);
    expect(hn.read).toBe(2);
    expect(asked.filter((u) => u.includes("algolia.com/api")).length).toBe(1);
    writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: { locations: ["London", "Austin"] } }));
    expect((await hn.fetch(null)).map((l) => l.company_hint)).toEqual(["Globex"]);
    expect(hn.read).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
    writeFileSync(paths.me("profile.json"), "{}");
  }
});

test("robots.txt wildcards and private hosts", async () => {
  const r = parseRobots("User-agent: *\nAllow: /*.json$\nDisallow: /");
  expect(robotsAllow(r, "/v0/item/1.json")).toBe(true);
  expect(robotsAllow(r, "/v0/item/1")).toBe(false);
  // A rule with many wildcards can't freeze the app (a regular expression took seconds to forever).
  const t = performance.now();
  expect(robotsMatch(`/${"*a".repeat(20)}$`, `/${"a".repeat(60)}b`)).toBe(false);
  expect(performance.now() - t).toBeLessThan(50);
  for (const h of ["127.0.0.1", "::ffff:10.0.0.1", "192.168.1.1", "::1"])
    await expect(assertPublicHost(h)).rejects.toThrow();
  await expect(assertPublicHost("93.184.215.14")).resolves.toBeUndefined();
  expect(htmlToText("<p>a&amp;b</p><script>x()</script><li>c</li>")).toBe("a&b\nc");
});

test("robots.txt is honoured except under a configured prefix, and each use is logged", async () => {
  // Two exceptions of the person's own, under a path the site's robots.txt disallows (a host that
  // resolves: robots.txt is read only from a public address, so a .example host would read none).
  writeFileSync(
    paths.config(),
    `[polling]\nper_host_rps = 1000\n[robots]\nexceptions = [
  { prefix = "https://www.example.com/api/v1/careers/", reason = "the careers page's own request" },
  { prefix = "https://www.example.com/api/v1/postings/", reason = "the posting page's own request" },
]\n`,
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).endsWith("/robots.txt")
      ? new Response("User-agent: *\nDisallow: /api/\n")
      : new Response("{}")) as typeof fetch;
  try {
    expect(await robotsAllowed("https://www.example.com/api/v1/careers/0d4d80f6/jobs")).toBe(true);
    expect(await robotsAllowed("https://www.example.com/api/v1/postings/x")).toBe(true);
    expect(await robotsAllowed("https://www.example.com/api/v1/other/x")).toBe(false);
    const logged = readFileSync(failuresFile(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logged.filter((f) => f.area === "robots-exception").map((f) => f.context.url)).toEqual([
      "https://www.example.com/api/v1/careers/0d4d80f6/jobs",
      "https://www.example.com/api/v1/postings/x",
    ]);
  } finally {
    globalThis.fetch = realFetch;
    writeFileSync(paths.config(), "[polling]\nper_host_rps = 1000\n");
  }
});

test("Form D writes a funding fact on the watched company, no Inbox row; same-named companies don't collide", async () => {
  const { companyByDomain, fundingOf, upsertCompany, watchCompany } = await import("../intake/companies.ts");
  const { open } = await import("../core/db.ts");
  const formD = (await import("../sources/form-d/index.ts")).default;
  watchCompany(upsertCompany({ name: "Tessera Labs", domain: "tessera.dev" }), "manual");
  watchCompany(upsertCompany({ name: "Acme Technologies", domain: "acme.dev" }), "manual");
  const idx = `D                Tessera Labs, Inc.                                            1704188     20261020    edgar/data/1704188/0001704188-26-000003.txt
D                ACME LABS INC                                                 55          20261020    edgar/data/55/z.txt`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(idx, { status: 200 })) as unknown as typeof fetch;
  try {
    expect(await formD.fetch(null)).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(fundingOf(companyByDomain("tessera.dev")!)).toEqual({
    form: "D",
    date: "2026-10-20",
    url: "https://www.sec.gov/Archives/edgar/data/1704188/0001704188-26-000003.txt",
    cik: "1704188",
  });
  expect(fundingOf(companyByDomain("acme.dev")!)).toBeNull();
  expect(open().query("SELECT count(*) AS n FROM signals").get()).toEqual({ n: 0 });
});

import { afterAll, afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { setSecret } from "../core/keychain.ts";
import { entries } from "../core/ledger.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import xBookmarks from "../sources/x-bookmarks/index.ts";
import { bookmarks, connect, readPosts } from "./client.ts";

const data = tempData();
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init?: RequestInit };
function mockX(pages: Record<string, unknown>[][], opts: { rejectPostFields?: boolean } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/oauth2/token")) {
      return Response.json({ access_token: "AT", refresh_token: "RT2", expires_in: 7200 });
    }
    if (opts.rejectPostFields && url.includes("post.fields")) return new Response("bad", { status: 400 });
    if (url.includes("/users/me")) return Response.json({ data: { id: "42" } });
    if (url.includes("/bookmarks")) {
      const token = new URL(url).searchParams.get("pagination_token");
      const i = token ? Number(token) : 0;
      return Response.json({
        data: pages[i],
        includes: { users: [{ id: "7", username: "quarry_builds" }] },
        meta: i + 1 < pages.length ? { next_token: String(i + 1) } : {},
      });
    }
    if (url.includes("/tweets")) {
      return Response.json({
        data: [{ id: "9", text: "hi", author_id: "7" }],
        includes: { users: [{ id: "7", username: "quarry_builds" }] },
      });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const post = (id: string, urls: string[] = []) => ({
  id,
  text: `post ${id}`,
  author_id: "7",
  created_at: "2026-10-21T10:00:00Z",
  entities: { urls: urls.map((u) => ({ expanded_url: u })) },
});

test("bookmarks page until a seen post, costing $0.001 each", async () => {
  setSecret("x_client_id", "CID");
  setSecret("x_refresh_token", "RT");
  const calls = mockX([
    [post("5"), post("4")],
    [post("3"), post("2")],
  ]);
  const got = await bookmarks(new Set(["3"]));
  expect(got.map((p) => p.id)).toEqual(["5", "4"]);
  expect(calls.filter((c) => c.url.includes("/bookmarks")).length).toBe(2);
  const cost = entries()
    .filter((e) => e.station === "x-bookmarks")
    .reduce((s, e) => s + e.usd, 0);
  expect(cost).toBeCloseTo(0.004);
});

test("past the monthly cap, no bookmark or post is read", async () => {
  writeFileSync(paths.config(), "[caps]\nmonth_usd = 0\n");
  try {
    const calls = mockX([[post("30")]]);
    expect(await bookmarks(new Set())).toEqual([]);
    expect(await readPosts(["9"])).toEqual([]);
    expect(calls.filter((c) => /\/bookmarks|\/tweets/.test(c.url))).toEqual([]);
  } finally {
    rmSync(paths.config());
  }
});

test("the source reads one page on first run, then only new posts", async () => {
  mockX([[post("20", ["https://quarry.so"]), post("19")], [post("18")]]);
  expect((await xBookmarks.fetch(null)).length).toBe(2);
  mockX([[post("21"), post("20"), post("19")]]);
  const next = await xBookmarks.fetch(null);
  expect(next.map((l) => l.url)).toEqual(["https://x.com/quarry_builds/status/21"]);
});

test("connect runs PKCE through a local callback and stores the rotated refresh token", async () => {
  const calls = mockX([]);
  const { getSecret } = await import("../core/keychain.ts");
  await connect(async (url) => {
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toContain("bookmark.read");
    await realFetch(`${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&code=CODE`);
  });
  const tokenCall = calls.find((c) => c.url.includes("/oauth2/token"))!;
  expect(String(tokenCall.init?.body)).toContain("code_verifier=");
  expect(getSecret("x_refresh_token")).toBe("RT2");
});

import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { deleteSecret } from "../core/keychain.ts";
import { setSignedIn } from "../core/model.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import feeds, { linkLeads, parseFeed } from "./feeds/index.ts";

const { cleanup } = tempData();
afterAll(cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FEED = "https://example.com/feed";
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toUTCString();
const RSS = `<?xml version="1.0"?><rss><channel><title>Jobs digest</title>
<item><title><![CDATA[Anduril and Quarry are hiring]]></title><link>https://example.com/p/one</link>
<guid>one</guid><pubDate>${day(1)}</pubDate>
<content:encoded><![CDATA[<p><a href="https://www.anduril.com/">Anduril</a> is hiring, and
<a href="https://jobs.ashbyhq.com/quarry/123">a founding engineer at Quarry</a>.
See <a href="https://example.com/investments">https://example.com/investments</a> and
<a href="https://forms.gle/abc">apply here</a>.</p>]]></content:encoded></item>
<item><title>Old news</title><link>https://example.com/p/old</link><guid>old</guid>
<pubDate>${day(40)}</pubDate><description>&lt;a href="https://old.io/"&gt;Old&lt;/a&gt;</description></item>
</channel></rss>`;

test("an RSS entry's links come in without a model only when they point at a board or a site their text names", () => {
  const [e] = parseFeed(RSS, FEED);
  expect(e!.title).toBe("Anduril and Quarry are hiring");
  expect(
    linkLeads(e!, FEED, new Date().toISOString()).map((l) => [
      l.kind,
      l.company_hint ?? null,
      l.domain ?? null,
      l.url,
    ]),
  ).toEqual([
    ["company", "Anduril", "anduril.com", "https://www.anduril.com/"],
    ["posting", null, null, "https://jobs.ashbyhq.com/quarry/123"],
  ]);
  const atom = parseFeed(
    '<feed><entry><id>a1</id><title>Hi</title><link rel="alternate" href="/p/a1"/><updated>2026-11-10T00:00:00Z</updated><content type="html">&lt;p&gt;x&lt;/p&gt;</content></entry></feed>',
    FEED,
  );
  expect(atom).toEqual([
    {
      id: "a1",
      title: "Hi",
      url: "https://example.com/p/a1",
      html: "<p>x</p>",
      at: "2026-11-10T00:00:00.000Z",
    },
  ]);
});

test("an added feed is read once per entry, a new one's old entries counted as read", async () => {
  // No model: another test file may have left a key in the memory keychain.
  deleteSecret("anthropic");
  setSignedIn({ in: false, plan: null });
  expect(await feeds.connected()).toBe(false);
  writeFileSync(paths.config(), `[source.feeds]\nurls = ["${FEED}"]\n`);
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).endsWith("/robots.txt")
      ? new Response("", { status: 404 })
      : new Response(RSS, { headers: { "content-type": "application/rss+xml" } })) as typeof fetch;
  const leads = await feeds.fetch(null);
  expect(leads.map((l) => l.url)).toEqual([
    "https://www.anduril.com/",
    "https://jobs.ashbyhq.com/quarry/123",
  ]);
  expect(await feeds.fetch(null)).toEqual([]);
});

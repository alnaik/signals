// Crawl4AI: the free local reader for JS-heavy pages. Either a Crawl4AI Docker server
// ([provider.crawl4ai] url, token in the Keychain as "crawl4ai") or the `crwl` CLI from
// `uv tool install crawl4ai` + `crawl4ai-setup`. Free: no ledger cost.
import { loadConfig } from "../core/config.ts";
import { assertPublicHost } from "../core/http.ts";
import { getSecret } from "../core/keychain.ts";
import { api } from "./http.ts";
import type { Provider } from "./types.ts";

const serverUrl = () => loadConfig().provider.crawl4ai?.url as string | undefined;
const cli = () => Bun.which("crwl");

const crawl4ai: Provider = {
  name: "crawl4ai",
  label: "Crawl4AI",
  cost: { read: 0 },
  available: () => !!serverUrl() || !!cli(),
  read: async (url) => {
    await assertPublicHost(new URL(url).hostname);
    const fetched_at = new Date().toISOString();
    if (serverUrl()) {
      type R = {
        success: boolean;
        results: { url?: string; markdown?: string | { raw_markdown?: string } }[];
      };
      const r = await api<R>(`${serverUrl()}/crawl`, {
        headers: { authorization: `Bearer ${getSecret("crawl4ai") ?? ""}` },
        body: {
          urls: [url],
          browser_config: { type: "BrowserConfig", params: { headless: true } },
          crawler_config: { type: "CrawlerRunConfig", params: { cache_mode: "bypass", stream: false } },
        },
        timeoutMs: 120_000,
      });
      const md = r.results?.[0]?.markdown;
      const text = typeof md === "string" ? md : (md?.raw_markdown ?? "");
      if (!r.success || !text) throw new Error("crawl4ai: no markdown");
      return { url, text, fetched_at };
    }
    const p = Bun.spawn([cli()!, url, "-o", "markdown"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const timer = setTimeout(() => p.kill(), 120_000);
    const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    clearTimeout(timer);
    if (code !== 0 || !text.trim()) throw new Error(`crawl4ai: crwl exited ${code}`);
    return { url, text, fetched_at };
  },
};

export default crawl4ai;

// Firecrawl: web search (2 credits per 10 results, with includeDomains and a date filter) and
// page reads (1 credit a page, rendered by Firecrawl, as markdown). The free plan is 1,000 credits
// a month, 10 searches or reads a minute; past its credits Firecrawl answers 402 and bills nothing.
// The Hobby plan is $19 for 5,000 credits a month (a search about $0.008).
// Credits are priced by config: [provider.firecrawl] usd_per_credit (0, the free plan, unless set).
// API shapes and prices from docs.firecrawl.dev (v2) and firecrawl.dev/pricing, 2026-11-12; one
// live search (2 credits) and one page read (1 credit) answered.
import { loadConfig } from "../core/config.ts";
import { getSecret } from "../core/keychain.ts";
import { api } from "./http.ts";
import type { Provider, SearchResult } from "./types.ts";

const BASE = "https://api.firecrawl.dev/v2";
const headers = () => ({ authorization: `Bearer ${getSecret("firecrawl") ?? ""}` });
const perCredit = () => Number(loadConfig().provider.firecrawl?.usd_per_credit ?? 0);
const usd = (c: number) => c * perCredit();
const searchCredits = (n = 10) => 2 * Math.ceil(n / 10);

// Credits each call spent, kept with its result (two calls may run at once).
const spent = new WeakMap<object, number>();
function priced<T extends object>(result: T, credits: number): T {
  spent.set(result, credits);
  return result;
}

// The free plan allows 10 requests a minute: a 429 is waited out (Retry-After, else 6 s) and
// asked again, a few times.
async function fc<T>(path: string, body: unknown, timeoutMs = 90_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await api<T>(`${BASE}${path}`, { headers: headers(), body, timeoutMs });
    } catch (err) {
      if ((err as { status?: number }).status !== 429 || i >= 4) throw err;
      const after = Number((err as { retryAfter?: string }).retryAfter);
      await Bun.sleep(Math.min(60, after > 0 ? after : 6) * 1000);
    }
  }
}

/** 2026-11-12 → "11/12/2026", Firecrawl's custom date range form. */
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

const firecrawl: Provider = {
  name: "firecrawl",
  label: "Firecrawl",
  price:
    "Free each month: 1,000 credits. A web search is 2 credits (about $0.008 on the $19 plan of 5,000); a page read 1. Prices checked 12 Nov 2026.",
  key: "firecrawl",
  get cost() {
    return { search: usd(searchCredits()), read: usd(1) };
  },
  estimate: (cap, args) =>
    cap === "search" ? usd(searchCredits((args[1] as { n?: number } | undefined)?.n)) : undefined,
  lastCost: (r) => {
    const c = r && typeof r === "object" ? spent.get(r) : undefined;
    return c === undefined ? undefined : usd(c);
  },
  lastUsage: (r) => {
    const c = r && typeof r === "object" ? spent.get(r) : undefined;
    return c === undefined ? undefined : { credits: c };
  },
  search: async (query, opts): Promise<SearchResult[]> => {
    type Search = {
      data?: { web?: { url: string; title?: string; description?: string }[] };
      creditsUsed?: number;
    };
    const n = Math.min(100, opts.n ?? 10);
    const r = await fc<Search>("/search", {
      query: query.slice(0, 500),
      limit: n,
      sources: ["web"],
      ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
      ...(opts.since ? { tbs: `cdr:1,cd_min:${usDate(opts.since)}` } : {}),
    });
    const web = r.data?.web ?? [];
    return priced(
      web.map((x) => ({ url: x.url, title: x.title ?? "", snippet: (x.description ?? "").slice(0, 500) })),
      r.creditsUsed ?? searchCredits(n),
    );
  },
  read: async (url) => {
    type Scrape = {
      data?: { markdown?: string; metadata?: { title?: string; url?: string; statusCode?: number } };
    };
    const r = await fc<Scrape>("/scrape", { url, formats: ["markdown"], onlyMainContent: true });
    const status = r.data?.metadata?.statusCode;
    if (r.data?.markdown === undefined || (status && status >= 400))
      throw new Error(`firecrawl: the page answered ${status ?? "nothing"}`);
    return priced(
      {
        url: r.data.metadata?.url ?? url,
        ...(r.data.metadata?.title ? { title: r.data.metadata.title } : {}),
        text: r.data.markdown,
        fetched_at: new Date().toISOString(),
      },
      1,
    );
  },
};

export default firecrawl;

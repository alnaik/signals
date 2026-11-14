// Context.dev: scrape (1 credit per page), crawl with a page cap, People Search (10 credits a
// page of people, an empty page free), People Enrich (20 credits per match, beta), web search (1 credit per
// 10 results, with includeDomains), map of a site's URLs (1 credit, 2 with a search term).
// Company Search 2 credits a page. Credits are priced by config: [provider.contextdev]
// usd_per_credit. The free plan is 1,000 credits a month from its grant day, 10 requests a minute;
// the $20 plan is 10,000 credits ($0.002 each). Checked against docs.context.dev and
// context.dev/pricing, 2026-11-12: search's freshness takes last_24_hours (no longer last_day);
// one live search answered.

import { registrable } from "../ats/reader.ts";
import { loadConfig } from "../core/config.ts";
import { getSecret } from "../core/keychain.ts";
import { entries, type LedgerEntry, monthStart } from "../core/ledger.ts";
import { api, splitName } from "./http.ts";
import * as kept from "./kept.ts";
import type { ContactHit, Person, PersonRef, Provider, SearchResult } from "./types.ts";

const BASE = "https://api.context.dev/v1";
// People Search and People Enrich answers are kept and used again for 90 days: who holds a title
// at a company, and their email, change slower than that, and each answer costs 10 or 20 credits.
const KEEP_DAYS = 90;
const peopleKey = (title: string, domain: string, company?: string) => `${title} at ${company || domain}`;
const enrichKey = (person: Pick<PersonRef, "name" | "domain">) =>
  `${registrable(person.domain)}|${person.name}`;
const keptAnswer = (kind: string, key: string) => kept.get("contextdev", kind, key, KEEP_DAYS) !== null;
// Credits each call spent, kept with its result: a module-level "last" would mix up two calls
// running at once.
const spent = new WeakMap<object, number>();
function priced<T extends object>(result: T, credits: number): T {
  spent.set(result, credits);
  return result;
}
type Hit = { url: string; title?: string; description?: string };
const toResult = (h: Hit): SearchResult => ({
  url: h.url,
  title: h.title ?? "",
  snippet: h.description ?? "",
});
const headers = () => ({ authorization: `Bearer ${getSecret("contextdev") ?? ""}` });

// Context.dev runs one request at a time per organisation; a second one is answered 429 at once
// (never billed). So calls here go one after another, and a 429 (another process on the key) is
// waited out, Retry-After or a second, and asked again.
const TRIES_429 = 8;
let queue: Promise<unknown> = Promise.resolve();
function cd<T>(url: string, init: Parameters<typeof api>[1]): Promise<T> {
  const run = async (): Promise<T> => {
    for (let i = 1; ; i++) {
      try {
        return await api<T>(url, init);
      } catch (err) {
        if ((err as { status?: number }).status !== 429 || i >= TRIES_429) throw err;
        const after = Number((err as { retryAfter?: string }).retryAfter);
        await Bun.sleep(Math.min(30, after > 0 ? after : 1) * 1000);
      }
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
// Not free for the cap check, whatever the plan: an estimate until config says otherwise.
const perCredit = () => Number(loadConfig().provider.contextdev?.usd_per_credit ?? 0.001);
const usd = (c: number) => c * perCredit();

/** The credits one ledger row spent: as recorded; a failed call none; an older row (no count kept)
 * from its price, or at a price of 0 (free credits) 1, a search's cost. */
const creditsOf = (e: LedgerEntry) =>
  e.usage?.credits ?? (e.failed ? 0 : perCredit() ? Math.round(e.usd / perCredit()) : 1);

/**
 * Context.dev credits spent since `since`, by station (discover-search, board-search, …), from the
 * credits each call recorded.
 */
export function creditsSince(since: Date): Record<string, number> {
  const iso = since.toISOString();
  const out: Record<string, number> = {};
  for (const e of entries())
    if (e.provider === "contextdev" && e.ts >= iso) out[e.station] = (out[e.station] ?? 0) + creditsOf(e);
  return out;
}

/** Context.dev credits spent this calendar month, by station. */
export const creditsThisMonth = (now = new Date()) => creditsSince(monthStart(now));

export type AccountUsage = {
  remaining: number;
  periodStart: string | null; // Context.dev's own month: from its grant day (the 10th), not the 1st
  used: number | null; // credits charged since periodStart, every caller of the key included
  refillAt: string | null;
  refillCredits: number | null;
  topup: boolean;
};
let account: { at: number; value: AccountUsage } | null = null;

/**
 * Context.dev's own count (GET /org/usage, free, outside the one-request-at-a-time limit): credits
 * left, used this period and the next refill. Asked at most once a minute; when it doesn't answer
 * within 3 s, the last answer, else null.
 */
export async function accountUsage(now = Date.now()): Promise<AccountUsage | null> {
  if (account && now - account.at < 60_000) return account.value;
  if (!getSecret("contextdev")) return null;
  type Usage = {
    credits_remaining?: unknown;
    period?: { start?: string; credits_used?: number } | null;
    next_refill?: { at?: string; credits?: number } | null;
    auto_topup?: { enabled?: boolean };
  };
  try {
    const r = await api<Usage>(`${BASE}/org/usage`, { headers: headers(), timeoutMs: 3000 });
    if (typeof r?.credits_remaining !== "number") return account?.value ?? null;
    const value: AccountUsage = {
      remaining: r.credits_remaining,
      periodStart: r.period?.start ?? null,
      used: r.period?.credits_used ?? null,
      refillAt: r.next_refill?.at ?? null,
      refillCredits: r.next_refill?.credits ?? null,
      topup: !!r.auto_topup?.enabled,
    };
    account = { at: now, value };
    return value;
  } catch {
    return account?.value ?? null;
  }
}

/**
 * A search's `since` as Context.dev's freshness window. The week takes a day's slack: a weekly
 * run's `since` is the last run, a little over 7 days back by the time each query goes, and
 * "last_month" would fill its 10 results with postings already seen.
 */
export function freshness(since: string | undefined, now = new Date()): string | undefined {
  if (!since) return undefined;
  const days = (now.getTime() - Date.parse(since)) / 86_400_000;
  return days <= 1 ? "last_24_hours" : days <= 8 ? "last_week" : days <= 31 ? "last_month" : "last_year";
}

/**
 * Company Search by name: each company it knows as a result on its homepage, with what it does
 * and where it is based. 2 credits a page of companies; none found is free.
 */
async function companySearch(name: string): Promise<SearchResult[]> {
  type Found = {
    results: {
      name: string;
      domain?: string | null;
      description?: string | null;
      headquarters?: { city?: string | null; region?: string | null; country_code?: string | null } | null;
    }[];
    key_metadata?: { credits_consumed?: number };
  };
  const r = await cd<Found>(`${BASE}/company/search`, { headers: headers(), body: { query: name } });
  const hits = r.results
    .filter((c) => c.domain)
    .map((c) => {
      const hq = [c.headquarters?.city, c.headquarters?.region, c.headquarters?.country_code].filter(Boolean);
      return {
        url: `https://${c.domain}`,
        title: c.name,
        snippet: [c.description ?? "", hq.length ? `Based in ${hq.join(", ")}` : ""]
          .filter(Boolean)
          .join(" · "),
      };
    });
  return priced(hits, r.key_metadata?.credits_consumed ?? (r.results.length ? 2 : 0));
}

// Words a title can go without and mean the same ("Head, AI" is "Head of AI"; a founder is a
// co-founder). Any other word counts, however short: VP, AI, ML, QA, UX.
const FILLER = new Set(["of", "the", "and", "for", "at", "in", "a", "an", "to", "on", "co"]);

/** Does a job title hold every word of the title asked for ("Head of Engineering" → "Head of Platform Engineering")? */
export function titleHolds(held: string, asked: string): boolean {
  const words = held.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return asked
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w))
    .every((w) => words.some((h) => h === w || h === `${w}s` || (w.length > 4 && h.startsWith(w))));
}

const contextdev: Provider = {
  name: "contextdev",
  label: "Context.dev",
  price:
    "Free each month: 1,000 credits (10 requests a minute). A web search or a page read is 1 credit, a company lookup 2, a people search 10; a credit is $0.002 on the $20 plan of 10,000. Prices checked 12 Nov 2026.",
  key: "contextdev",
  // Priced from config, so the monthly cap sees it before the call.
  get cost() {
    return { read: usd(1), contact: usd(20), search: usd(1), map: usd(1), people: usd(10) };
  },
  // A crawl costs a credit a page: priced at its page cap. A search, a credit per 10 results;
  // a map, 2 credits when it searches. People Search and Enrich: nothing for a question whose
  // answer is kept.
  estimate: (cap, args) => {
    if (cap === "search" && (args[1] as { category?: string } | undefined)?.category === "company")
      return usd(2);
    if (cap === "search") return usd(Math.ceil(((args[1] as { n?: number } | undefined)?.n ?? 10) / 10));
    if (cap === "map") return usd((args[1] as { search?: string } | undefined)?.search ? 2 : 1);
    if (cap === "people" && typeof args[0] === "string" && Array.isArray(args[1])) {
      const [domain, roles, company] = args as [string, string[], string | undefined];
      return usd(
        10 * roles.filter((t) => !keptAnswer("people-search", peopleKey(t, domain, company))).length,
      );
    }
    if (cap === "people") return usd(10 * ((args[1] as string[] | undefined)?.length ?? 1));
    const person = args[0] as PersonRef | undefined;
    if (cap === "contact" && person?.name && person.domain && keptAnswer("people-enrich", enrichKey(person)))
      return 0;
    const opts = args[1] as { site?: boolean; max_pages?: number } | undefined;
    return cap === "read" && opts?.site ? usd(opts.max_pages ?? 10) : undefined;
  },
  lastCost: (r) => {
    const c = r && typeof r === "object" ? spent.get(r) : undefined;
    return c === undefined ? undefined : usd(c);
  },
  lastUsage: (r) => {
    const c = r && typeof r === "object" ? spent.get(r) : undefined;
    return c === undefined ? undefined : { credits: c };
  },
  read: async (url, opts) => {
    if (opts.site) {
      type Crawl = {
        results: { markdown: string; metadata: { url: string; title?: string; success?: boolean } }[];
      };
      const r = await cd<Crawl>(`${BASE}/web/crawl`, {
        headers: headers(),
        body: { url, maxPages: opts.max_pages ?? 10, useMainContentOnly: true },
        timeoutMs: 180_000,
      });
      const pages = r.results
        .filter((p) => p.metadata.success !== false)
        .map((p) => ({ url: p.metadata.url, text: p.markdown }));
      return priced(
        { url, text: pages.map((p) => p.text).join("\n\n"), pages, fetched_at: new Date().toISOString() },
        pages.length,
      );
    }
    type Scrape = {
      markdown: { success: boolean; data: string };
      metadata?: { finalUrl?: string; title?: string };
      key_metadata?: { credits_consumed?: number };
    };
    const r = await cd<Scrape>(`${BASE}/web/scrape`, {
      headers: headers(),
      body: { url, formats: { markdown: true }, sharedParams: { mainContentOnly: true } },
    });
    if (!r.markdown?.success) throw new Error("contextdev: scrape failed");
    return priced(
      {
        url: r.metadata?.finalUrl ?? url,
        title: r.metadata?.title,
        text: r.markdown.data,
        fetched_at: new Date().toISOString(),
      },
      r.key_metadata?.credits_consumed ?? 1,
    );
  },
  search: async (query, opts): Promise<SearchResult[]> => {
    if (opts.category === "company") return companySearch(query);
    type Search = { results: Hit[]; key_metadata?: { credits_consumed?: number } };
    const n = opts.n ?? 10;
    const r = await cd<Search>(`${BASE}/web/search`, {
      headers: headers(),
      body: {
        query,
        numResults: n,
        ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
        ...(freshness(opts.since) ? { freshness: freshness(opts.since) } : {}),
      },
    });
    return priced(r.results.map(toResult), r.key_metadata?.credits_consumed ?? Math.ceil(n / 10));
  },
  map: async (domain, opts): Promise<SearchResult[]> => {
    type Map = { urls: Hit[]; key_metadata?: { credits_consumed?: number } };
    const q = new URLSearchParams({ domain, maxLinks: String(opts.max ?? 200) });
    if (opts.search) q.set("search", opts.search);
    const r = await cd<Map>(`${BASE}/web/urls?${q}`, { headers: headers() });
    return priced(r.urls.map(toResult), r.key_metadata?.credits_consumed ?? (opts.search ? 2 : 1));
  },
  // One search a title, by the company's name, until a title finds people: only those whose
  // current employer is this domain and whose title holds the words asked for. A search asked in
  // the last 90 days is answered from its kept answer, at no credit.
  people: async (domain, roles, company): Promise<Person[]> => {
    type Found = {
      results: {
        name: string;
        profiles?: string[];
        role?: { title?: string | null; company?: { domain?: string | null } | null } | null;
      }[];
      key_metadata?: { credits_consumed?: number };
    };
    let credits = 0;
    for (const title of roles) {
      const query = peopleKey(title, domain, company);
      let r = kept.get<Found>("contextdev", "people-search", query, KEEP_DAYS);
      const asked = !r;
      if (!r) {
        try {
          r = await cd<Found>(`${BASE}/people/search`, { headers: headers(), body: { query } });
        } catch (err) {
          if ((err as { status?: number }).status === 402) break; // out of credits: no title will do
          continue; // a timeout costs nothing; try the next title
        }
        credits += r.key_metadata?.credits_consumed ?? (r.results.length ? 10 : 0);
      }
      const found = r.results.filter(
        (p) =>
          !!p.role?.company?.domain &&
          registrable(p.role.company.domain) === registrable(domain) &&
          titleHolds(p.role.title ?? "", title),
      );
      if (asked) kept.put("contextdev", "people-search", query, r); // an empty answer too
      if (found.length)
        return priced(
          found.map((p) => ({
            name: p.name,
            role: p.role?.title ?? "",
            profile_urls: p.profiles ?? [],
            source: "contextdev",
          })),
          credits,
        );
    }
    return priced([], credits);
  },
  // People Enrich: an email for a person at the company, answered from its kept answer when the
  // same person at the same site was looked up in the last 90 days, at no credit.
  contact: async (person): Promise<ContactHit[]> => {
    type Enrich = {
      match: { status: string; score: number | null; person: { email?: string } | null };
      key_metadata?: { credits_consumed?: number };
    };
    const key = enrichKey(person);
    const known = kept.get<Enrich>("contextdev", "people-enrich", key, KEEP_DAYS);
    const r =
      known ??
      (await cd<Enrich>(`${BASE}/people/enrich`, {
        headers: headers(),
        body: {
          name: splitName(person.name),
          company: { domain: person.domain },
          ...(person.profile_urls.length ? { social_urls: person.profile_urls.slice(0, 20) } : {}),
        },
      }));
    const credits = known
      ? 0
      : (r.key_metadata?.credits_consumed ?? (r.match.status === "candidate" ? 20 : 0));
    const email = r.match.person?.email;
    if (!known) kept.put("contextdev", "people-enrich", key, r);
    if (r.match.status !== "candidate" || !email) return priced([], credits);
    return priced(
      [
        {
          channel: "email",
          value: email,
          confidence: (r.match.score ?? 0) >= 90 ? "verified" : "pattern",
          source: "contextdev",
        },
      ],
      credits,
    );
  },
};

export default contextdev;

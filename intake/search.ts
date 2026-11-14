// Web search: the last step of finding a company's board, run only when the free steps (the
// board its signal links to, the boards table, its own site) found nothing. Once per company,
// again after 30 days; at most `discovery.search_daily` companies a day. It runs on the web
// searches connected, in the [providers] search order, as board search does (by default Context.dev
// first, whose free credits never bill: out of them it answers 402; then Exa inside its own $10 a
// month). Every query's results are kept in the database for 30 days.
//
// The small model reads the posts that named the company and the
// numbered results. A company with no domain gets one search for its site first: its name and
// what its posts say of it (the model writes the query), and the model picks its domain from the
// results and the domains its posts give. The pick counts only with proof (intake/domain.ts);
// then its own site is looked at (discovery), and only if that finds nothing, the second search.
// That one is "<domain> careers": the model picks its own board or careers page, or none, and our
// own readers read the pick: a link on a job board as that board, any other page with every
// reader there. A board whose Ashby page states another website is refused. A careers page that
// lists its roles is the board only when it is the careers page itself, not one posting under
// it; one no reader reads (a YC jobs page, a Notion page) and an empty board stay its careers page.
//
// A company that came with a board and no website (a board search lead) gets the same site
// search, after those (siteFor: its Ashby board's stated website and its posts first, free); the
// pick needs the same proof and must also be its board's. It keeps its board; only the domain is
// set. Looked up once, again after 30 days, in the same daily cap.

import { loadFilters } from "../ats/filters.ts";
// @ts-expect-error plain JS module
import { careersPage } from "../ats/links.mjs";
import {
  ATS_URL,
  boardKey,
  boardRoot,
  boardUrl,
  type Job,
  label,
  leftAtDeadline,
  pastDeadline,
  type RunnerCompany,
  type RunnerResult,
  registrable,
  runBoards,
  sameTitle,
  sharesWord,
} from "../ats/reader.ts";
// @ts-expect-error plain JS module
import { SEARCHABLE } from "../ats/search.mjs";
import { loadConfig } from "../core/config.ts";
import { DAY, markChanged, open } from "../core/db.ts";
import { entries, monthStart } from "../core/ledger.ts";
import { canUseSmallModel, NoModelKey, OverCap, smallJson } from "../core/model.ts";
import { failure } from "../core/trace.ts";
import { call, getProvider, isAvailable, webSearches } from "../providers/registry.ts";
import type { SearchResult } from "../providers/types.ts";
import { sameName } from "./classify.ts";
import { type Company, type DomainFrom, getCompany, proven, type Signal, signalsOf } from "./companies.ts";
import {
  boardIsOthers,
  boardStates,
  domainFromPosts,
  offSite,
  type Proof,
  postDomains,
  prove,
} from "./domain.ts";
import { siteDomain } from "./leads.ts";

export const SEARCH_RETRY_DAYS = 30;
const CACHE_DAYS = 30;
const STATION = "discover-search";
const PICK_STATION = "discover-pick";
const DOMAIN_STATION = "discover-domain";

export function searchConfig() {
  const d = loadConfig().discovery;
  return {
    on: d.search !== false,
    daily: Number(d.search_daily),
    exaMonthUsd: Number(d.exa_month_usd),
    companyMs: Number(d.company_seconds) * 1000,
  };
}

// --- what the company was seen with ----------------------------------------------------------

/**
 * A signal's title that names a role ("Agentic Software Engineer II"), not a post's first line
 * ("Footprint | Rust Engineers | New York | ONSITE", "whitecircle.com/careers, we're building…").
 */
export function isRoleTitle(t: string): boolean {
  const s = t.trim();
  return (
    !!s &&
    s.length <= 90 &&
    s.split(/\s+/).length <= 14 &&
    !/\||https?:|www\.|\b[\w-]+\.(?:com|io|ai|dev|org|co|net|app|so|tech)\b/i.test(s)
  );
}

/** The role titles a company's signals carry, newest first. */
export function roleTitles(signals: Pick<Signal, "title">[]): string[] {
  const out = new Map<string, string>();
  for (const s of signals)
    if (s.title && isRoleTitle(s.title) && !out.has(sameTitle(s.title))) out.set(sameTitle(s.title), s.title);
  return [...out.values()];
}

/** Is this one of the titles (case, punctuation and a trailing place aside)? */
export function sameRole(title: string, titles: string[], location = ""): boolean {
  const a = sameTitle(title);
  const b = sameTitle(title, location);
  return titles.some((t) => {
    const w = sameTitle(t);
    return !!w && (w === a || w === b);
  });
}

const SENIORITY = /^(?:sr|senior|jr|junior|lead|staff|principal|mid level|entry level)\s+/;
/** The same role but for a seniority word in front: "Sr. Embedded Software Engineer" for "Embedded Software Engineer". */
export function nearRole(title: string, titles: string[], location = ""): boolean {
  const strip = (t: string) => sameTitle(t).replace(SENIORITY, "");
  const a = strip(title);
  const b = sameTitle(title, location).replace(SENIORITY, "");
  return titles.some((t) => {
    const w = strip(t);
    return !!w && (w === a || w === b);
  });
}

export type Listed = "title" | "near" | false | null;
/**
 * Which of these boards list one of their company's titles: each board's own search for a big
 * searchable one, else its list, within `ms`. "title": listed; "near": listed but for a seniority
 * word; false: read, not listed; null: not read.
 */
export async function listsTitle(
  boards: { key: string; provider: string; url: string; name: string; titles: string[] }[],
  ms: number,
): Promise<Map<string, Listed>> {
  const out = new Map<string, Listed>(boards.map((b) => [b.key, null]));
  if (!boards.length) return out;
  const want = new Map(boards.map((b) => [b.key, b]));
  await runBoards(
    "scan",
    boards.map(
      (b): RunnerCompany => ({
        domain: b.key,
        name: b.name,
        ats: { provider: b.provider, careers_url: b.url },
        ...(SEARCHABLE.includes(b.provider) ? { search: b.titles } : {}),
        deadlineMs: ms,
      }),
    ),
    (r: RunnerResult) => {
      const b = want.get(r.domain);
      if (!b || !r.ok || !r.jobs) return;
      const jobs = r.jobs;
      out.set(
        r.domain,
        jobs.some((j: Job) => sameRole(j.title, b.titles, j.location))
          ? "title"
          : jobs.some((j: Job) => nearRole(j.title, b.titles, j.location))
            ? "near"
            : false,
      );
    },
    { workers: 4 },
  ).catch((err) => failure("discover", "title check", err));
  return out;
}

/**
 * A careers site's address from a page on it: up to its careers segment, or the careers host
 * itself; null when the page isn't a careers page (a home page, a help or docs site, a forum,
 * a store category, an article that mentions careers). One rule with detection's: ats/links.mjs.
 */
export const careersRoot = (url: string): string | null => careersPage(url);

// --- the search itself -----------------------------------------------------------------------

/** Exa's spend this month (real money, from the ledger). */
const exaSpent = (now: Date) => {
  const since = monthStart(now).toISOString();
  return entries()
    .filter((e) => e.provider === "exa" && e.ts >= since)
    .reduce((s, e) => s + e.usd, 0);
};

/**
 * One query's results: from the database when asked in the last 30 days, else the web searches
 * connected, in the [providers] search order (Context.dev, Exa, Firecrawl, Parallel), the next when
 * one fails or is over its limit. Exa keeps its own monthly limit; each provider its own pace.
 */
export async function webSearch(query: string, now = new Date()): Promise<SearchResult[] | null> {
  const d = open();
  const kept = d.query("SELECT results, at FROM web_searches WHERE query = ?").get(query) as {
    results: string;
    at: string;
  } | null;
  if (kept && now.getTime() - Date.parse(kept.at) < CACHE_DAYS * DAY) return JSON.parse(kept.results);
  const cap = searchConfig().exaMonthUsd;
  for (const p of await webSearches()) {
    const name = p.name;
    if (name === "exa" && exaSpent(now) + (p.cost.search ?? 0.007) > cap + 1e-9) continue;
    try {
      const results = (await call(p, "search", [query, { n: 10 }], { station: STATION })) as SearchResult[];
      d.query(
        "INSERT INTO web_searches (query, provider, results, at) VALUES (?, ?, ?, ?) ON CONFLICT(query) DO UPDATE SET provider = excluded.provider, results = excluded.results, at = excluded.at",
      ).run(
        query,
        name,
        JSON.stringify(results.map(({ url, title, snippet }) => ({ url, title, snippet }))),
        now.toISOString(),
      );
      return results;
    } catch (err) {
      failure("discover", `web search (${name})`, err);
    }
  }
  return null;
}

/**
 * Companies by this name in Context.dev's company index, each on its own homepage: kept like a web
 * search (30 days), null when it didn't answer. Only Context.dev has one at no money.
 */
export async function companySearch(name: string, now = new Date()): Promise<SearchResult[] | null> {
  const d = open();
  const key = `company: ${name}`;
  const kept = d.query("SELECT results, at FROM web_searches WHERE query = ?").get(key) as {
    results: string;
    at: string;
  } | null;
  if (kept && now.getTime() - Date.parse(kept.at) < CACHE_DAYS * DAY) return JSON.parse(kept.results);
  const p = await getProvider("contextdev");
  if (!p?.search || !isAvailable(p)) return null;
  try {
    const results = (await call(p, "search", [name, { category: "company" }], {
      station: STATION,
    })) as SearchResult[];
    d.query(
      "INSERT INTO web_searches (query, provider, results, at) VALUES (?, ?, ?, ?) ON CONFLICT(query) DO UPDATE SET provider = excluded.provider, results = excluded.results, at = excluded.at",
    ).run(key, "contextdev", JSON.stringify(results), now.toISOString());
    return results;
  } catch (err) {
    failure("discover", "company search", err);
    return null;
  }
}

// --- the pick --------------------------------------------------------------------------------

const SYSTEM = `You find a company's own job board from web search results.

You get a company, the posts that named it, and numbered search results. Pick the one result that is THIS company's own careers page or job board: a board on Greenhouse, Ashby, Lever, Workable, Workday and the like, a careers page on its own website, or one of its own job postings.

Not a pick:
- another company with a similar name (check the posts: what the company does, its handle, its links);
- a job aggregator or a list of many companies' jobs (LinkedIn, Indeed, Wellfound, YC's job list, a VC's portfolio jobs board);
- news, a blog post or a social profile;
- a homepage, an about or a team page (only a careers page or a board is a pick).

When the posts are about a product or an open-source project, the company behind it is the company: its board counts. When a result is the board or careers page and another is one posting on it, pick the board or careers page. When both its careers page and its board on a job-board host are results, pick the board.

When no result is clearly this company's, pick 0. Many small companies have no public board, and that is a fine answer.

why: a few words.`;

const SCHEMA = {
  type: "object",
  properties: { pick: { type: "integer" }, why: { type: "string" } },
  required: ["pick", "why"],
  additionalProperties: false,
};
type Answer = { pick: number; why: string };

const QUERY_SYSTEM = `You write one web search query that finds a company's own website. You get the company's name and the posts that named it. Use the name plus the words that set it apart: what it does, its X handle (without @), a product name, its city. Not the word careers. Output only the query.`;
const QUERY_SCHEMA = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};

const DOMAIN_SYSTEM = `You find a company's own website domain. You get the company, the posts that named it, the domains those posts link or email, and numbered web search results.

Answer the domain of THIS company's own site, the one the posts mean (same business, handle, product), as it appears in a result's address, written in a result's title or text or in a post, or among the posts' domains, e.g. "altitude.xyz". Never a domain you only know or guess. Not a social profile, a job board or aggregator, a news site, a link, event or form host, or another company with a similar name. When the company is a product of a parent company, give the site the posts point to.

When no result or post domain is clearly its own site, answer "".
why: a few words.`;
const DOMAIN_SCHEMA = {
  type: "object",
  properties: { domain: { type: "string" }, why: { type: "string" } },
  required: ["domain", "why"],
  additionalProperties: false,
};

/** At most n characters; never half an emoji (a high surrogate left at the end goes). */
export const clip = (s: string | null | undefined, n: number) =>
  (s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n)
    .replace(/[\uD800-\uDBFF]$/, "");

const postLines = (c: Company) => {
  const posts = signalsOf(c.id, 4).map((s) => {
    const who = [s.source, s.author, s.posted_at?.slice(0, 10)].filter(Boolean).join(" ");
    const what = [s.title, clip(s.text, 500)].filter(Boolean).join(" — ");
    return `- [${who}] ${what} (link: ${s.url})`;
  });
  return ["Posts that named it:", ...(posts.length ? posts : ["(none)"])];
};
const results = (hits: SearchResult[]) => [
  "Search results:",
  ...hits.map((h, i) => `${i + 1}. ${h.url} — ${clip(h.title, 120)} — ${clip(h.snippet, 220)}`),
];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

// On whichever model connection there is.
const ask = <T>(
  station: string,
  system: string,
  user: string,
  schema: Record<string, unknown>,
  maxTokens: number,
) => smallJson<T>({ station, system, user, schema, maxTokens });

export type Picked = { company: Company; url: string | null; proof?: Proof | null; how: string };

/**
 * A company with a domain: "<domain> careers" and the model's pick from it; null when no search
 * answered, or discovery's deadline passed first (the search is kept: the next tick asks the model).
 */
async function pickFor(c: Company, now: Date): Promise<Picked | null> {
  const hits = await webSearch(`${c.domain} careers`, now);
  if (!hits) return null;
  if (!hits.length) return { company: c, url: null, how: "web search: no results" };
  if (pastDeadline()) return null;
  const user = [`Company: ${c.name}`, `Website: ${c.domain}`, "", ...postLines(c), "", ...results(hits)];
  const a = await ask<Answer>(PICK_STATION, SYSTEM, user.join("\n"), SCHEMA, 1500);
  const picked = Number.isInteger(a.pick) && a.pick >= 1 && a.pick <= hits.length;
  const url = picked ? hits[a.pick - 1]!.url : null;
  // A page off its own site is kept only on a job board or a page host (Notion, YC): another
  // site is another company's (Glider's pick on gliderfi.com is LoanGlide's), unless the page
  // shows it is the company's second site (lifeatcanva.com for canva.com): the page reader checks
  // that on the page it reads, so only for a proven domain. A domain that is a site's subdomain
  // (dlab.epfl.ch) is that site: siteDomain gives the registrable domain.
  const site = url && !onBoard(url) ? siteDomain(url) : null;
  if (site && site !== c.domain && site !== registrable(c.domain!) && !proven(c))
    return {
      company: c,
      url: null,
      how: `web search: ${url} is ${site}'s page, not ${c.domain}'s · ${clip(a.why, 120)}`,
    };
  return { company: c, url, how: `web search: ${clip(a.why, 120)}` };
}

/** Does one of these texts write this domain out whole (poh.org, www.poh.org; not poh.organic)? */
export function writes(texts: string[], domain: string): boolean {
  const re = new RegExp(`(?:^|[^a-z0-9-])${domain.replace(/\./g, "\\.")}(?![a-z0-9-]|\\.[a-z0-9])`, "i");
  return texts.some((t) => re.test(t));
}

/**
 * The query the model wrote for a company's site search, kept like a search (30 days) so a retry
 * asks the same. Kept by its number and its name: SQLite gives the number of a company that went
 * (a merge, a prune) to the next one made, which must not get the other's query (a tick makes its
 * companies at one time, so when it was made doesn't tell them apart).
 */
async function siteQuery(c: Company, posts: string[], now: Date): Promise<string> {
  const d = open();
  const key = `site query: ${c.id} ${c.name}`;
  const kept = d.query("SELECT results, at FROM web_searches WHERE query = ?").get(key) as {
    results: string;
    at: string;
  } | null;
  if (kept && now.getTime() - Date.parse(kept.at) < CACHE_DAYS * DAY) return JSON.parse(kept.results);
  const q = await ask<{ query: string }>(
    DOMAIN_STATION,
    QUERY_SYSTEM,
    [`Company: ${c.name}`, "", ...posts].join("\n"),
    QUERY_SCHEMA,
    300,
  );
  const query = clip(q.query, 200) || c.name;
  d.query(
    "INSERT INTO web_searches (query, provider, results, at) VALUES (?, 'model', ?, ?) ON CONFLICT(query) DO UPDATE SET provider = excluded.provider, results = excluded.results, at = excluded.at",
  ).run(key, JSON.stringify(query), now.toISOString());
  return query;
}

/**
 * A company with no domain: one search for its site, the model's pick, and the pick's proof; null
 * when no search answered, or discovery's deadline passed before a model call (none is started
 * past it; the query and the searches are kept for the next tick).
 */
export async function domainFor(c: Company, now: Date): Promise<Picked | null> {
  const posts = postLines(c);
  if (pastDeadline()) return null;
  const found = await webSearch(await siteQuery(c, posts, now), now);
  if (!found) return null;
  // The company index's namesakes go to the same pick (Tractian → tractian.com; for "Crosby", three
  // other Crosbys the posts rule out): a pick still needs its proof below.
  const known = ((await companySearch(clip(c.name, 200), now)) ?? []).slice(0, 3);
  const hits = [
    ...found,
    ...known.filter((k) => !found.some((f) => siteDomain(f.url) === siteDomain(k.url))),
  ];
  const signals = signalsOf(c.id, 20);
  const own = postDomains(signals);
  if (!hits.length && !own.length) return { company: c, url: null, how: "web search: no site found" };
  if (pastDeadline()) return null;
  const user = [
    `Company: ${c.name}`,
    "",
    ...posts,
    "",
    `Domains the posts give: ${own.join(", ") || "(none)"}`,
    "",
  ];
  const a = await ask<{ domain: string; why: string }>(
    DOMAIN_STATION,
    DOMAIN_SYSTEM,
    [...user, ...results(hits)].join("\n"),
    DOMAIN_SCHEMA,
    600,
  );
  // The pick is one of the results' sites or the posts' domains, or a domain a result or a post
  // writes out (poh.org, only in a LinkedIn snippet), and a search hit alone is no proof: the
  // posts must give it, or its homepage name the company.
  const shown = new Set([...own, ...hits.flatMap((h) => siteDomain(h.url) ?? [])]);
  const texts = [...hits.map((h) => `${h.title} ${h.snippet}`), ...signals.map((s) => s.text ?? "")];
  const pick = siteDomain(a.domain);
  const proven = pick && (shown.has(pick) || writes(texts, pick)) ? await prove(c, pick, own) : null;
  // Unproven, but the company index lists it under this very name (not a name inside it: Ramp's
  // ramp.com isn't Rampart's): kept as looked up, so its site is read for a board, and it never
  // makes two companies one.
  const indexed =
    !proven && pick && known.some((k) => siteDomain(k.url) === pick && sameName(k.title, c.name));
  const proof: Proof | null = proven ?? (indexed ? { domain: pick, from: "looked up" } : null);
  const why = clip(a.why, 100);
  return {
    company: c,
    url: null,
    proof,
    how: proof
      ? `web search: its site ${proof.domain} (${proof.from === "looked up" ? "looked up: the company index agrees" : proof.from}): ${why}`
      : `web search: no site proven${a.domain.trim() ? ` (${clip(a.domain, 60)} unproven)` : ""}: ${why}`,
  };
}

export type SiteFound = { proof: Proof; how: string } | { none: string };

/** The board a site's own careers pages give (discovery's walk of it, within `ms`), or null. */
async function siteBoard(
  c: Company,
  domain: string,
  ms: number,
): Promise<{ key: string; url: string } | null> {
  let found: { key: string; url: string } | null = null;
  await runBoards(
    "detect",
    [{ domain: String(c.id), name: c.name, site: domain, deadlineMs: ms }],
    (r: RunnerResult) => {
      const d = r.ok ? (r.detect as { provider?: string; careers_url?: string } | undefined) : undefined;
      if (!d?.provider || !d.careers_url) return;
      const url = boardUrl(d.provider, d.careers_url);
      found = { key: boardKey(d.provider, url), url };
    },
  ).catch((err) => failure("discover", "site's board", err));
  return found;
}

/**
 * The website of a company known by name, with its board or without: free first, the website its
 * own Ashby board states (under the company's name), then one its posts prove; then one web search
 * (domainFor). Only a proven domain counts, never one only looked up; with a board, a searched
 * site must also be the board's: it shares a word with the board's address or the company's name
 * (Everpure's homepage is Pentair's; its board is Pure Storage's), and its own careers pages don't
 * give another board (flex.com gives Flex Ltd's Workday board; Flex's Greenhouse board is
 * getflex.com's). null: no web search answered (out of credits, no key, past the model's cap), or
 * discovery's deadline cut it short, so nothing was decided.
 */
export async function siteFor(c: Company, now = new Date()): Promise<SiteFound | null> {
  const boards = open()
    .query("SELECT url, key FROM boards WHERE company_id = ? AND status = 'ok'")
    .all(c.id) as { url: string; key: string }[];
  for (const b of boards) {
    const said = await boardStates(b.url);
    if (said?.site && sharesWord(said.name, c.name))
      return { proof: { domain: said.site, from: "board" }, how: `its board ${b.url} states ${said.site}` };
  }
  const posts = await domainFromPosts(c).catch(() => null);
  if (posts) return { proof: posts, how: `its posts give ${posts.domain} (${posts.from})` };
  const picked = await domainFor(c, now);
  if (!picked) return null;
  const p = picked.proof;
  if (!p || p.from === "looked up") return { none: picked.how };
  if (!boards.length) return { proof: p, how: picked.how };
  const ties = (u: string) => sharesWord(label(p.domain), u) || sharesWord(c.name, label(p.domain));
  if (!boards.some((b) => ties(b.url)))
    return { none: `${picked.how} · ${p.domain} shares no word with its board or name` };
  const theirs = await siteBoard(c, p.domain, searchConfig().companyMs);
  // Its site's walk cut by discovery's deadline: nothing decided.
  if (!theirs && pastDeadline()) return null;
  if (theirs && !boards.some((b) => b.key === theirs.key))
    return { none: `${picked.how} · ${p.domain} gives another board, ${theirs.url}` };
  return { proof: p, how: picked.how };
}

/** The careers page itself (zerops.io/careers), not one posting under it. */
export const isCareersRoot = (url: string) => {
  const strip = (u: string) => u.replace(/[?#].*$/, "").replace(/\/$/, "");
  const root = careersRoot(url);
  return !!root && strip(root) === strip(url);
};

// --- readers on a careers site ---------------------------------------------------------

// A careers site's pages, their scripts and one probe read; a site's 5s crawl-delay (GEO's jobs
// site) takes about 40s.
export const PAGES_MS = 45_000;
export type OnPages = {
  provider?: string;
  careers_url?: string;
  method?: string;
  careers_read?: string;
  reasons?: string[]; // why a board the pages named couldn't be read (robots.txt, refused)
  tried?: string[]; // the pages that answered
};

/**
 * Every vendored provider's detection on these pages (a careers site, a posting a search found):
 * each page's own address, its links and scripts, the platform it gives itself away as (a
 * branded Avature, Jibe or SuccessFactors site), a SmartRecruiters posting id. A query provider
 * (Google Careers) is probed with the first saved-search title.
 */
export async function readersOn(
  items: { key: string; name: string; site: string; pages: string[] }[],
  ms = PAGES_MS,
): Promise<Map<string, OnPages>> {
  const out = new Map<string, OnPages>();
  if (!items.length) return out;
  const titles = loadFilters().title_include ?? [];
  await runBoards(
    "detect",
    items.map((i) => ({
      domain: i.key,
      name: i.name,
      site: i.site,
      pages: i.pages,
      ...(titles.length ? { search: titles.slice(0, 1) } : {}),
      deadlineMs: ms,
    })),
    (r) => {
      if (r.ok) out.set(r.domain, (r.detect ?? {}) as OnPages);
      else out.set(r.domain, { reasons: [r.error ?? "detection failed"] });
    },
    { workers: 4 },
  ).catch((err) => failure("discover", "readers on careers pages", err));
  return out;
}

/** The first reason a careers site's board couldn't be read, for its note. */
export const unreadBecause = (p: OnPages | undefined) => p?.reasons?.[0]?.slice(0, 140) ?? null;

// --- the step -----------------------------------------------------------------------------

/**
 * Companies the free steps left without a board: never searched for (however long ago their last
 * signal), or not searched for in 30 days and still active. Dismissed ones never.
 */
export function searchDue(now = new Date(), limit = 4, activeDays = 60): Company[] {
  return open()
    .query(
      `SELECT * FROM companies
       WHERE discovery = 'none' AND (watched_at IS NOT NULL OR dismissed_at IS NULL)
         AND (search_at IS NULL OR (search_at < $retry
           AND (watched_at IS NOT NULL OR last_signal_at >= $active)))
       ORDER BY last_signal_at DESC LIMIT $limit`,
    )
    .all({
      retry: new Date(now.getTime() - SEARCH_RETRY_DAYS * DAY).toISOString(),
      active: new Date(now.getTime() - activeDays * DAY).toISOString(),
      limit,
    }) as Company[];
}

/** Companies searched for since local midnight: the daily cap counts these. */
export function searchedToday(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return (
    open().query("SELECT count(*) AS n FROM companies WHERE search_at >= ?").get(midnight.toISOString()) as {
      n: number;
    }
  ).n;
}

export type Verdict =
  | { kind: "board"; provider: string; url: string; how: string }
  | { kind: "careers"; url: string; how: string; pages?: string[] }
  | { kind: "site"; domain: string; from: DomainFrom; how: string } // a domain proven: its site is next
  | { kind: "none"; how: string };

export type Searched = { company: Company; verdict: Verdict };

/** A link on a job board's host is read as that board (an empty one stays its careers page). */
const onBoard = (url: string) => ATS_URL.test(hostOf(url));

/**
 * Search for these companies' boards, or a domain for those with none, within the daily cap.
 * Returns what was decided for each company searched; companies past the cap, or whose searches
 * all failed, or with no model to pick, are left as they were. At discovery's deadline no company
 * is started and no model call made; a pick already made is kept, unless the read that checks it
 * was cut short: that company is searched next time (its search is cached).
 */
export async function searchBoards(companies: Company[], now = new Date()): Promise<Searched[]> {
  const cfg = searchConfig();
  if (!cfg.on || !canUseSmallModel()) return [];
  const room = Math.max(0, cfg.daily - searchedToday(now));
  const picks: Picked[] = [];
  for (const company of companies.slice(0, room)) {
    if (pastDeadline()) break;
    let p: Picked | null | "failed";
    try {
      p = await (company.domain ? pickFor : domainFor)(company, now);
    } catch (err) {
      // No key or the month's cap: every company waits. Any other failure (traced): this one.
      p = err instanceof NoModelKey || err instanceof OverCap ? null : "failed";
    }
    // Every provider failed (out of credits, no key), the model can't run, or the deadline passed
    // before its pick: another time.
    if (!p) {
      if (pastDeadline()) leftAtDeadline("web search", [company]);
      break;
    }
    if (p !== "failed") picks.push(p);
  }
  if (!picks.length) return [];
  // Every pick goes to every reader: a link on a job board as that board, any other page (its
  // own careers page, a YC jobs page, a Notion page) as a careers page. A page on another site
  // goes to the page reader only, which reads it once it shows it is the company's.
  const verdicts = new Map<number, Verdict>();
  const toRead: { key: string; name: string; site: string; pages: string[] }[] = [];
  for (const p of picks) {
    const id = p.company.id;
    if (p.proof) verdicts.set(id, { kind: "site", ...p.proof, how: p.how });
    else if (!p.url) verdicts.set(id, { kind: "none", how: p.how });
    else {
      const root = (onBoard(p.url) && boardRoot(p.url)) || careersRoot(p.url) || p.url;
      const pages = [...new Set([root, p.url])];
      verdicts.set(id, { kind: "careers", url: root, pages, how: p.how });
      if (!offSite(p.company, root))
        toRead.push({ key: String(id), name: p.company.name, site: p.company.domain ?? hostOf(root), pages });
    }
  }
  const onPages = await readersOn(toRead);
  // Past the deadline, a pick whose read didn't come back isn't decided: it is dropped.
  if (pastDeadline()) {
    const cut = new Set(toRead.filter((t) => !onPages.has(t.key)).map((t) => Number(t.key)));
    leftAtDeadline(
      "web search: readers on its pick",
      picks.filter((p) => cut.has(p.company.id)).map((p) => p.company),
      "its pick, made, is dropped",
    );
    for (let i = picks.length - 1; i >= 0; i--) if (cut.has(picks[i]!.company.id)) picks.splice(i, 1);
  }
  for (const [key, r] of onPages) {
    const v = verdicts.get(Number(key));
    if (v?.kind !== "careers") continue;
    const c = getCompany(Number(key));
    // A board that states another company's website or name isn't this one's (Parable:
    // askparable.com's; Spur's search gave Pear VC's).
    const board = r.provider && r.careers_url ? r.careers_url : onBoard(v.url) ? v.url : null;
    const others = board && c ? await boardIsOthers(board, c) : null;
    const said = v.how.replace(/^web search: /, "");
    if (others)
      verdicts.set(Number(key), { kind: "none", how: `web search: ${board} is ${others}'s board · ${said}` });
    else if (r.provider && r.careers_url)
      verdicts.set(Number(key), {
        kind: "board",
        provider: r.provider,
        url: r.careers_url,
        how: onBoard(v.url) ? v.how : `web search: its careers site runs ${r.provider}`,
      });
    // Its careers page lists its roles itself (a job list in its page data no ATS claims, a feed).
    else if (r.careers_read && isCareersRoot(r.careers_read))
      verdicts.set(Number(key), {
        kind: "board",
        provider: "careers-page",
        url: r.careers_read,
        how: "web search: its careers page lists its roles",
      });
    // A page that is gone (404, 410) isn't its careers page: the search's index is older than the site.
    else if (r.reasons?.some((x) => x.startsWith(`${v.url}: `) && /\(HTTP 4(?:04|10)\)/.test(x)))
      verdicts.set(Number(key), { kind: "none", how: `web search: ${v.url} is gone · ${said}` });
    // A board that answered with no roles today stays its careers page; one that didn't answer, nothing.
    else if (onBoard(v.url) && !r.reasons?.some((x) => / no roles at /.test(x)))
      verdicts.set(Number(key), { kind: "none", how: `web search: ${v.url} didn't read · ${said}` });
    else if (unreadBecause(r)) verdicts.set(Number(key), { ...v, how: `${v.how} · ${unreadBecause(r)}` });
  }
  const out: Searched[] = [];
  for (const p of picks) {
    let verdict = verdicts.get(p.company.id) ?? { kind: "none" as const, how: p.how };
    // Only a page the rule calls a careers page is kept as one (ats/links.mjs careersPage), or a board.
    if (verdict.kind === "careers" && !onBoard(verdict.url) && !careersRoot(verdict.url))
      verdict = { kind: "none", how: verdict.how };
    // A domain proven: the careers search waits for its own site to be looked at.
    open()
      .query("UPDATE companies SET search_at = ? WHERE id = ?")
      .run(verdict.kind === "site" ? null : now.toISOString(), p.company.id);
    out.push({ company: getCompany(p.company.id) ?? p.company, verdict });
  }
  markChanged(now);
  return out;
}

// --- a website for a company with a board ----------------------------------------------------

/**
 * Companies that came with a board and no website (a board search lead): never looked up, or not
 * in 30 days and still active. Dismissed ones never. Their lookup is recorded in search_at, so it
 * counts in the same daily cap as the board search.
 */
export function siteDue(now = new Date(), limit = 4, activeDays = 60): Company[] {
  return open()
    .query(
      `SELECT * FROM companies c
       WHERE domain IS NULL AND discovery = 'found' AND (watched_at IS NOT NULL OR dismissed_at IS NULL)
         AND EXISTS (SELECT 1 FROM boards b WHERE b.company_id = c.id AND b.status = 'ok')
         AND (search_at IS NULL OR (search_at < $retry
           AND (watched_at IS NOT NULL OR last_signal_at >= $active)))
       ORDER BY last_signal_at DESC LIMIT $limit`,
    )
    .all({
      retry: new Date(now.getTime() - SEARCH_RETRY_DAYS * DAY).toISOString(),
      active: new Date(now.getTime() - activeDays * DAY).toISOString(),
      limit,
    }) as Company[];
}

/**
 * Look up these boarded companies' websites (siteFor), within the daily cap. Returns a "site" or
 * "none" verdict for each company looked up; companies past the cap, or when no search answered or
 * no model could pick, are left as they were.
 */
export async function searchSites(companies: Company[], now = new Date()): Promise<Searched[]> {
  const cfg = searchConfig();
  if (!cfg.on || !canUseSmallModel()) return [];
  const room = Math.max(0, cfg.daily - searchedToday(now));
  const out: Searched[] = [];
  for (const company of companies.slice(0, room)) {
    // Past discovery's deadline none is started; one going then is kept when it finished whole.
    if (pastDeadline()) break;
    let found: SiteFound | null;
    try {
      found = await siteFor(company, now);
    } catch (err) {
      // No key or the month's cap: every company waits. Any other failure (traced): this one.
      if (err instanceof NoModelKey || err instanceof OverCap) break;
      continue;
    }
    if (!found) {
      if (pastDeadline()) leftAtDeadline("website", [company]);
      break;
    }
    out.push({
      company,
      verdict:
        "proof" in found
          ? { kind: "site", ...found.proof, how: `website: ${found.how}` }
          : { kind: "none", how: `website: ${found.none}` },
    });
  }
  return out;
}

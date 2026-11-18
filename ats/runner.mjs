// Isolated ATS runner. Runs as its own process with no API keys in its environment.
// Reads one JSON request on stdin and prints one JSON line on stdout per company as each
// finishes (so the caller can save a board's read while others are still going), then a last
// line with the robots.txt exceptions used. Writes nothing.
//
//   { mode: "detect" | "scan", userAgent, minIntervalMs, robotsExceptions,
//     companies: [{ domain, site?, name, ats?: { provider, careers_url }, hint?, after?, links?, page?, html?,
//                   validators?: { etag, lastModified }, search?: string[], searchAbove?: number, full?, deadlineMs? }] }
//
// A scan reads a board's job list only, never posting bodies (Greenhouse without content=true);
// with `search` it asks the board's own search for those terms instead (ats/search.mjs).
// Uses career-ops' providers layer (vendor/career-ops), with extra politeness on top: up to 8
// boards at once, at most 2 requests at a time to a shared job-board API host and 1 to any other
// host, a pause between requests to a company's own site while detecting, robots.txt, back-off on
// 429 and 5xx, conditional requests, and an address check before every fetch.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHttpCtx } from "../vendor/career-ops/providers/_http.mjs";
import { loadProviders, resolveProvider } from "../vendor/career-ops/providers/_registry.mjs";
import { parseResultsPage } from "../vendor/career-ops/providers/google.mjs";
import {
  applyEmailIn,
  boardBearer,
  brandedBoards,
  careersLinks,
  careersPage,
  doverLookup,
  embedBoards,
  feedJobs,
  hrefsIn,
  isDemoBoard,
  isEmbedPath,
  isFeed,
  jobIds,
  jobsFeed,
  linksIn,
  notTheirs,
  otherEmployers,
  ownJobList,
  smartRecruitersIds,
} from "./links.mjs";
import {
  allowed,
  assertPublic,
  countOf,
  excepted,
  isLinkedInHost,
  parseRobots,
  readRobots,
} from "./polite.mjs";
import { boardSize, googleDates, NEWEST_FIRST, QUERIED as QUERIED_IDS, searchBoard } from "./search.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const req = JSON.parse(await new Response(process.stdin).text());
const UA = req.userAgent;
const minInterval = req.minIntervalMs ?? 1000;
// A scan of a board read before sends its validators; a 304 means the board is unchanged.
const reading = new AsyncLocalStorage();
class NotModified extends Error {}
// URL prefixes read despite robots.txt (config.toml [robots]); the caller logs each use.
const exceptions = req.robotsExceptions ?? [];
const exceptionsUsed = new Set();
function isExcepted(url) {
  const hit = excepted(url, exceptions);
  if (hit) exceptionsUsed.add(url);
  return hit;
}
const providers = await loadProviders(path.join(here, "../vendor/career-ops/providers"));
// Job Signal's own readers (ats/providers: big companies' own job sites), after the vendored ones.
for (const [id, p] of await loadProviders(path.join(here, "providers")))
  if (!providers.has(id)) providers.set(id, p);

// --- politeness -------------------------------------------------------------------
const nextSlot = new Map(); // host → earliest next request time
const robots = new Map(); // host → { disallow: string[], delay: number } | null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Job-board API hosts shared by every company on them: two requests at a time. Any other host
// (a company's site, a tenant's own subdomain) gets one.
const SHARED_HOSTS = new Set([
  "boards-api.greenhouse.io",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "api.lever.co",
  "jobs.lever.co",
  "api.ashbyhq.com",
  "jobs.ashbyhq.com",
  "api.smartrecruiters.com",
  "careers.smartrecruiters.com",
  "apply.workable.com",
  "app.dover.com",
  "ats.rippling.com",
  "www.amazon.jobs",
  "www.ycombinator.com",
  "api.polymer.co",
]);
const slots = new Map(); // host → { busy, waiting: resolve[] }
async function acquire(host) {
  const s = slots.get(host) ?? { busy: 0, waiting: [] };
  slots.set(host, s);
  const limit = SHARED_HOSTS.has(host) ? 2 : 1;
  if (s.busy >= limit) await new Promise((r) => s.waiting.push(r));
  else s.busy++;
  return () => {
    const next = s.waiting.shift();
    if (next) next();
    else s.busy--;
  };
}

// Detection walks a company's own site: one request per interval there, as before. A board
// read paces by the host limits above and the site's own crawl-delay.
async function gate(host, delayMs) {
  const interval = req.mode === "detect" ? Math.max(minInterval, delayMs) : delayMs;
  if (!interval) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + interval);
  if (at > now) await sleep(at - now);
}

const RETRIES = 2;
/** Wait out a 429 or a 5xx: its Retry-After when it gives one (at most 30s), else 1s, 2s. */
function backoff(err, attempt) {
  const after = Number(err?.retryAfter ?? err?.headers?.get?.("retry-after"));
  return Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30_000) : 1000 * 2 ** attempt;
}

let requests = 0; // HTTP requests made, robots.txt included: reported when the run ends
const robotsPending = new Map();
function robotsFor(origin, host) {
  if (robots.has(host)) return robots.get(host);
  if (!robotsPending.has(host)) robotsPending.set(host, fetchRobots(origin, host));
  return robotsPending.get(host);
}
async function fetchRobots(origin, host) {
  let rules = null;
  const release = await acquire(host);
  try {
    await gate(host, 0);
    requests++;
    const text = await readRobots(origin, UA);
    if (text !== null) rules = parseRobots(text);
  } catch {
    rules = null; // unreachable robots.txt: treat as allow, like most crawlers
  } finally {
    release();
  }
  robots.set(host, rules);
  return rules;
}

// Wrap career-ops' fetchers: same guards, plus ours.
const base = makeHttpCtx();
async function polite(method, url, opts = {}) {
  const u = new URL(url);
  if (isLinkedInHost(u.hostname)) throw new Error("LinkedIn pages are never read");
  await assertPublic(u.hostname);
  const rules = await robotsFor(u.origin, u.hostname);
  if (!allowed(rules, u.pathname + u.search) && !isExcepted(u.href))
    throw new Error(`robots.txt disallows ${u.hostname}${u.pathname}`);
  const store = reading.getStore();
  const get = (opts.method ?? "GET") === "GET" && method !== "fetchResponse";
  // Validators go on the board's first request only: that is the one they were saved from.
  const first = get && store && !store.requested;
  if (store) store.requested = true;
  const cached = first ? store.validators : undefined;
  const headers = new Headers(opts.headers ?? {});
  if (!headers.has("user-agent")) headers.set("user-agent", UA);
  if (cached?.etag) headers.set("if-none-match", cached.etag);
  if (cached?.lastModified) headers.set("if-modified-since", cached.lastModified);
  for (let attempt = 0; ; attempt++) {
    const release = await acquire(u.hostname);
    let retryIn = 0;
    let etag = null;
    let lastModified = null;
    try {
      await gate(u.hostname, rules?.delay ?? 0);
      requests++;
      const body = await base[method](url, {
        ...opts,
        headers: Object.fromEntries(headers),
        onResponse: (res) => {
          etag = res.headers.get("etag");
          lastModified = res.headers.get("last-modified");
          opts.onResponse?.(res);
        },
      });
      if (first && (etag || lastModified)) store.saved = { etag, lastModified };
      if (method === "fetchJson") countOf(body, store);
      return body;
    } catch (err) {
      if (err?.status === 304 && cached) {
        store.saved = cached;
        throw new NotModified(url);
      }
      const transient = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
      if (!transient || attempt >= RETRIES) throw err;
      retryIn = backoff(err, attempt);
    } finally {
      release();
    }
    await sleep(retryIn);
  }
}
const ctx = {
  ...base,
  fetchJson: (url, opts) => polite("fetchJson", url, opts),
  fetchText: (url, opts) => polite("fetchText", url, opts),
  fetchResponse: (url, opts) => polite("fetchResponse", url, opts),
};
// Avature tenants that drop the card's first class (Deloitte's `<article class="article--result ">`):
// the vendored parser, kept unmodified, matches `class="article article--result"` only.
const avatureCtx = {
  ...ctx,
  fetchText: async (url, opts) =>
    String(await ctx.fetchText(url, opts)).replace(
      /<article class="article--(result|jobs)\b/g,
      '<article class="article article--$1',
    ),
};

// --- detect -------------------------------------------------------------------------

/**
 * Fetch a body of the given content type, following redirects by hand (each hop address- and
 * robots-checked). `why`, when given, says why there's no body (robots.txt, the HTTP status).
 */
async function fetchBody(url, type = /html/i, why = undefined) {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") return null;
    if (isLinkedInHost(current.hostname)) {
      if (why) why.reason = "LinkedIn pages are never read";
      return null;
    }
    await assertPublic(current.hostname);
    const rules = await robotsFor(current.origin, current.hostname);
    if (!allowed(rules, current.pathname + current.search) && !isExcepted(current.href)) {
      if (why) why.reason = `robots.txt disallows ${current.hostname}${current.pathname}`;
      return null;
    }
    const release = await acquire(current.hostname);
    let res;
    try {
      await gate(current.hostname, rules?.delay ?? 0);
      requests++;
      res = await fetch(current, {
        headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } finally {
      release();
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      continue;
    }
    // Only pages: a stylesheet or script named "jobs" is not a careers page.
    if (!res.ok || !type.test(res.headers.get("content-type") ?? "html")) {
      if (why) why.reason = res.ok ? "not a page" : `refused (HTTP ${res.status})`;
      return null;
    }
    const html = (await res.text()).slice(0, 3_000_000);
    return { url: current.href, html };
  }
  return null;
}
const fetchPage = (url, why = undefined) => fetchBody(url, /html/i, why);

const MAX_SCRIPTS = 10;
// A stylesheet, script or image on a platform's CDN (rmkcdn.successfactors.com) isn't a board.
const ASSET = /\.(?:css|js|mjs|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|mp4)$/i;
const MAX_STATIC_QUERIES = 60;

/**
 * The page as detection reads it: its HTML, its same-origin scripts, and the JSON a Gatsby
 * site ships beside it (page data, then its static queries until one carries a board or job
 * ids). Next's __NEXT_DATA__ is already in the HTML.
 */
async function material(page) {
  const parts = [page.html];
  const origin = new URL(page.url).origin;
  const found = (t) => {
    const ids = jobIds([t], page.url, "");
    return embedBoards(t).length > 0 || ids.ashby.size + ids.greenhouse.size + ids.dover.size > 0;
  };
  const scripts = [...page.html.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1].replace(/&amp;/g, "&"), page.url);
      } catch {
        return null;
      }
    })
    .filter((u) => u?.origin === origin)
    .slice(0, MAX_SCRIPTS);
  for (const u of scripts) {
    const js = await fetchBody(u.href, /javascript|ecmascript/i).catch(() => null);
    if (js) parts.push(js.html);
  }
  if (/\/page-data\/|___gatsby/.test(page.html)) {
    const at = new URL(page.url).pathname.replace(/\/$/, "") || "/index";
    const pd = await fetchBody(`${origin}/page-data${at}/page-data.json`, /json/i).catch(() => null);
    if (pd) {
      parts.push(pd.html);
      let hashes = [];
      try {
        hashes = JSON.parse(pd.html).staticQueryHashes ?? [];
      } catch {}
      for (const h of hashes.filter((x) => /^\d+$/.test(x)).slice(0, MAX_STATIC_QUERIES)) {
        const sq = await fetchBody(`${origin}/page-data/sq/d/${h}.json`, /json/i).catch(() => null);
        if (!sq) continue;
        parts.push(sq.html);
        if (found(sq.html)) break;
      }
    }
  }
  return parts;
}

/** Did a provider's answer include any of these job ids (by id or in the posting URL)? */
const holds = (jobs, ids) =>
  jobs.some(
    (j) =>
      ids.has(String(j.externalId ?? "").toLowerCase()) ||
      [...ids].some((id) =>
        String(j.url ?? "")
          .toLowerCase()
          .includes(id),
      ),
  );

const sameSite = (host, domain) => {
  const h = String(host ?? "")
    .toLowerCase()
    .replace(/^www\./, "");
  return h === domain || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`);
};

/** Links that some ATS provider claims, one per board (many job links → one Workday tenant). */
function boardsIn(links) {
  const boards = new Map();
  for (const url of links) {
    if (isEmbedPath(url) || ASSET.test(new URL(url).pathname)) continue;
    const r = resolveProvider({ name: "x", careers_url: url }, providers, { skipIds: ["local-parser"] });
    if (!r?.provider) continue;
    let key = url;
    try {
      key = `${r.provider.id}:${JSON.stringify(r.provider.detect?.({ name: "x", careers_url: url }) ?? url)}`;
    } catch {}
    // Keep the board, not one job on it (Workday links often point at a single posting).
    if (!boards.has(key)) boards.set(key, r.provider.id === "workday" ? url.replace(/\/job\/.*$/, "") : url);
  }
  return [...boards.values()];
}

// Providers read through queries rather than a list (Google Careers): ats/search.mjs QUERIED.
const QUERIED = new Set(QUERIED_IDS);

/** Does the provider know this board by its own address? */
function knows(provider, entry) {
  try {
    return !!provider.detect?.(entry);
  } catch {
    return false;
  }
}

async function jobsFor(entry, probe = false, full = false, queries = undefined) {
  const r = resolveProvider(entry, providers, { skipIds: ["local-parser"] });
  if (!r || r.error) return null;
  // A query provider reads the terms it's given. A board its provider doesn't know by host is a
  // branded site (apply.deloitte.com on Avature): the provider reads it from that URL, given
  // as its `api` the way a career-ops portal entry would wire it.
  if (QUERIED.has(r.provider.id))
    entry = { ...entry, [r.provider.id]: { queries: queries ?? ["software engineer"] } };
  else if (entry.provider && !knows(r.provider, entry)) entry = { ...entry, api: entry.careers_url };
  // A board read takes the list only: Greenhouse's without posting bodies (content=true) and
  // without the /offices lookup. `full`: discovery's one confirming read, which looks for the
  // company's domain in the postings' text.
  if (!full && r.provider.id === "greenhouse")
    return { provider: "greenhouse", jobs: await greenhouseList(r.provider, entry) };
  // Detection only needs to know a board is live: one page is enough. A read is the list only:
  // Workday's one detail GET per "3 Locations" posting (Trimble's read went 54s) isn't made.
  let c = r.provider.id === "avature" ? avatureCtx : ctx;
  // Google's cards carry no dates; the page they come on does (googleDates), read as it passes,
  // and so does each query's order (newest first): its card ids, in `lists`.
  const dates = new Map();
  const lists = [];
  if (r.provider.id === "google" || r.provider.id === "google-careers")
    c = {
      ...ctx,
      fetchText: async (url, opts) => {
        const html = await ctx.fetchText(url, opts);
        for (const [id, d] of googleDates(html)) dates.set(id, d);
        lists.push(parseResultsPage(html).map((card) => card.id));
        return html;
      },
    };
  // A probe reads one page: career-ops providers take their page cap from max_pages, or ctx.
  if (probe) entry = { ...entry, max_pages: 1 };
  const got = await r.provider.fetch(
    entry,
    probe ? { ...c, maxPages: 1 } : full ? c : { ...c, titleWanted: () => false },
  );
  const jobs = Array.isArray(got) ? got : [];
  for (const j of jobs) {
    const d = dates.get(String(j.externalId));
    if (d) Object.assign(j, { postedAt: j.postedAt ?? d.postedAt, updatedAt: j.updatedAt ?? d.updatedAt });
  }
  return { provider: r.provider.id, jobs, lists };
}

// Greenhouse's list without posting bodies: SpaceX's is 187 KB this way instead of 32 MB, and
// Anduril's /offices call, which timed out, isn't made. Its updated_at says when a role changed.
async function greenhouseList(provider, entry) {
  const api = provider.detect(entry)?.url;
  if (!api) throw new Error(`greenhouse: no API URL for ${entry.careers_url}`);
  const u = new URL(api);
  u.searchParams.delete("content");
  // Greenhouse builds a big board's list fresh when its cache has none: measured 2026-10-29,
  // Anduril's (2,542 roles) and SpaceX's (2,843) first bytes came after 25s and 20s on a
  // CloudFront miss, 0.15s on a hit. The 10s default aborted Anduril mid-wait (SpaceX had been
  // cached), so this one request waits up to 45s; the list itself is 190 KB.
  const json = await ctx.fetchJson(u.href, { redirect: "error", timeoutMs: 45_000 });
  if (!Array.isArray(json?.jobs)) throw new Error("greenhouse: the board answered without a job list");
  return json.jobs
    .filter((j) => j.absolute_url)
    .map((j) => ({
      externalId:
        typeof j.id === "number" || typeof j.id === "string" ? String(j.id).trim() || undefined : undefined,
      title: j.title || "",
      url: j.absolute_url,
      location: j.location?.name || "",
      postedAt: j.first_published ? Date.parse(j.first_published) : null,
      updatedAt: j.updated_at ? Date.parse(j.updated_at) : null,
    }));
}

async function detect(c) {
  // The company's site; `domain` is only the key the result comes back under.
  const site = c.site ?? c.domain;
  const tried = [];
  const reasons = []; // why a board a page named couldn't be read ("successfactors: robots.txt disallows …")
  let refused = null; // a job list or feed of many employers' roles: why it isn't the company's
  // `named`: the page itself names this board (an embed), so it counts even with no roles
  // today, or when the board's API answers "not found" in JSON (a closed board).
  const attempt = async (link, method, provider = undefined, named = false) => {
    const careers_url = await withTenantDomain(link);
    if (isDemoBoard(careers_url)) return null;
    tried.push(careers_url);
    const entry = { name: c.name ?? site, careers_url, ...(provider ? { provider } : {}) };
    try {
      const r = await jobsFor(entry, true, false, c.search?.slice(0, 1));
      if (r && (r.jobs.length > 0 || named))
        return { provider: r.provider, careers_url, method, count: r.jobs.length };
      if (r) reasons.push(`${r.provider}: no roles at ${careers_url}`);
    } catch (err) {
      if (named && err?.status === 404 && /^\s*[{[]/.test(err.body ?? "")) {
        const r = resolveProvider(entry, providers, { skipIds: ["local-parser"] });
        if (r?.provider) return { provider: r.provider.id, careers_url, method, count: 0 };
      }
      reasons.push(`${provider ?? "board"} at ${careers_url}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
    return null;
  };
  // A board named by a posting lookup counts only when it lists the job id the company's page shows.
  const verified = async (careers_url, provider, ids) => {
    tried.push(careers_url);
    try {
      const r = await jobsFor({ name: c.name ?? site, careers_url, provider }, true);
      if (r?.jobs.length && holds(r.jobs, ids))
        return { provider: r.provider, careers_url, method: "job id on the page", count: r.jobs.length };
    } catch {}
    return null;
  };
  // A page linking several employers' boards (a fund's portfolio jobs page: a16z, 8VC, USV) is
  // no company's careers page: there only a board bearing its name or site counts, and the page's
  // own address (careers.acme.com redirecting to its board).
  const bears = boardBearer(c.name, c.site);
  // `html`: the page's own markup, where a branded platform names itself (meta tags, markup).
  const fromLinks = async (links, method, pageUrl = `https://${site}/`, html = "") => {
    let boards = boardsIn(links);
    if (boards.length > 1) {
      const own = boardsIn([pageUrl])[0];
      boards = boards.filter((b) => b === own || bears(b));
    }
    for (const board of boards.slice(0, 6)) {
      const hit = await attempt(board, method);
      if (hit) return hit;
    }
    for (const b of brandedBoards(`${html}\n${links.join("\n")}`, pageUrl)) {
      // The company's own site runs it: the page names this board as surely as an embed does.
      const hit = await attempt(b.careers_url, "branded site", b.provider);
      if (hit) return hit;
    }
    return null;
  };
  // A SmartRecruiters posting id in a link (a posting on the company's own site): the board
  // whose posting it is, asked by id under the names the company may go by there.
  const fromPostingIds = async (links) => {
    const ids = smartRecruitersIds(links).slice(0, 2);
    if (!ids.length) return null;
    const names = [
      ...new Set([String(c.name ?? "").replace(/[^A-Za-z0-9]/g, ""), String(site).split(".").slice(-2)[0]]),
    ].filter(Boolean);
    for (const id of ids)
      for (const n of names) {
        let job = null;
        try {
          job = await ctx.fetchJson(
            `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(n)}/postings/${id}`,
          );
        } catch {}
        const company = job?.company?.identifier;
        if (!company) continue;
        const hit = await attempt(
          `https://jobs.smartrecruiters.com/${company}`,
          "job id on the page",
          "smartrecruiters",
          true,
        );
        if (hit) return hit;
      }
    return null;
  };
  // The page's own text: embed markers first, then a Dover posting id checked against Dover.
  const fromPage = async (page, fetched = undefined) => {
    const parts = fetched ?? (await material(page));
    const text = parts.join("\n");
    for (const board of embedBoards(text)) {
      const hit = await attempt(board, "embed", undefined, true);
      if (hit) return hit;
    }
    const ids = jobIds(parts, page.url, site);
    // Dover names a posting's company and domain: its client id is the board.
    const dover = [...ids.dover, ...[...ids.own].slice(0, 1).map((id) => [id, null])];
    for (const [id, company] of dover.slice(0, 2)) {
      let job = null;
      try {
        job = await ctx.fetchJson(doverLookup(id));
      } catch {}
      if (!job?.client_id || !sameSite(job.client_domain, site)) continue;
      const slug = company ?? site.split(".")[0];
      const hit = await verified(
        `https://app.dover.com/${slug}/careers/${job.client_id}`,
        "dover",
        new Set([id]),
      );
      if (hit) return hit;
    }
    // No provider claims the page's job list: the list itself is the board, unless its roles are
    // at many employers (a fund's job board). So is a jobs feed it names, read here for the same
    // check (a job site's feed); one that doesn't load is left to its first read (refresh.ts).
    const others = (list, url) => {
      const named = otherEmployers(list, url);
      if (named.length) {
        const why = notTheirs(c.name ?? site, named);
        refused ??= why;
        reasons.push(`${url}: ${why}`);
      }
      return named.length > 0;
    };
    const list = ownJobList([page.html], page.url);
    if (list.length >= 3 && !others(list, page.url)) return { provider: null, careers_read: page.url };
    const feed = jobsFeed(page.html, page.url);
    if (!feed) return null;
    const got = await fetchBody(feed, /xml|rss|atom/i).catch(() => null);
    if (got && isFeed(got.html) && others(feedJobs(got.html, got.url), feed)) return null;
    return { provider: null, careers_read: feed };
  };
  // Given pages (a careers site, a posting a web search found): each page, its links and
  // scripts, and every vendored provider's detection on them; no crawling past them.
  if (c.pages) {
    const pages = [...c.pages];
    const seenPages = new Set();
    for (let url = pages.shift(), n = 0; url && n < 5; url = pages.shift(), n++) {
      if (seenPages.has(url)) continue;
      seenPages.add(url);
      const hit = (await fromLinks([url], "careers site", url)) ?? (await fromPostingIds([url]));
      if (hit) return hit;
      const why = {};
      let page = null;
      try {
        page = await fetchPage(url, why);
      } catch (err) {
        why.reason = String(err?.code ?? err?.cause?.code ?? err?.message ?? err);
      }
      if (!page) {
        reasons.push(`${url}: ${why.reason ?? "no page"}`);
        continue;
      }
      tried.push(page.url);
      const parts = await material(page);
      // A board's own page links other companies' boards (a YC page's "other startups hiring"):
      // only the board itself counts.
      const links = boardsIn([page.url]).length ? [] : linksIn(parts.join("\n"), page.url);
      const found =
        (await fromLinks([page.url, ...links], "careers site", page.url, page.html)) ??
        (await fromPostingIds([page.url, ...links])) ??
        (await fromPage(page, parts));
      if (found?.provider) return found;
      if (found?.careers_read) return { provider: null, careers_read: found.careers_read, tried, reasons };
      // A careers page that hands off to the company's jobs site (geogroup.com/careers → jobs.geogroup.com).
      pages.push(...careersLinks(hrefsIn(page.html, page.url), site, page.url).slice(0, 2));
    }
    return { provider: null, tried, reasons };
  }
  // Links from a rendered page (the caller ran the browser), and the markers in its DOM: only
  // these, no crawling.
  if (c.links) {
    const page = c.page ?? `https://${site}/`;
    const html = c.html ?? "";
    const onBoard = !!c.html && boardsIn([page]).length > 0; // a rendered board's own page: as above
    const links = onBoard ? [page] : [...embedBoards(html), ...linksIn(c.links.join("\n"), page)];
    const hit = await fromLinks(links, c.method ?? "rendered page", page, html);
    return hit ?? { provider: null, tried };
  }
  if (c.hint) {
    const hit = (await attempt(c.hint, "lead")) ?? (await fromLinks([c.hint], "lead"));
    if (hit) return hit;
  }
  // The careers page: common paths and subdomains, then whatever the home page calls careers.
  const d = site;
  const pages = [`https://${d}/careers`, `https://careers.${d}/`, `https://${d}/jobs`, `https://jobs.${d}/`];
  const visited = new Set();
  const careersPages = [];
  // An address that takes applications, from a careers page first, else the home page.
  const emails = { careers: null, home: null };
  const errors = [];
  let careersRead = null;
  let careersTitle = null; // the first careers page's <title>: board search may match a hit's title to it
  let fetches = 0;
  const isCareers = (u) =>
    /career|jobs?\b|join|hiring|opportunit|open-?(?:roles|positions)/i.test(
      new URL(u).hostname + new URL(u).pathname,
    );
  const visit = async (url) => {
    if (visited.has(url) || fetches >= 10) return null;
    visited.add(url);
    fetches++;
    let page = null;
    try {
      page = await fetchPage(url);
      // Refused (a WAF's 403, robots.txt) or not a page: the domain answered, so it resolves.
      if (!page) errors.push("no page");
    } catch (err) {
      errors.push(err?.code ?? err?.cause?.code ?? String(err?.message ?? err));
    }
    if (!page || visited.has(`final:${page.url}`)) return null;
    visited.add(`final:${page.url}`);
    tried.push(page.url);
    const links = linksIn(page.html, page.url);
    const careers = isCareers(page.url);
    // Kept as its careers page only by the strict rule: a page read for roles may be broader.
    const own = careersPage(page.url) !== null;
    if (own) careersPages.push(page.url);
    if (own && !careersTitle)
      careersTitle = page.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    const slot = careers ? "careers" : "home";
    if (!emails[slot]) {
      const address = applyEmailIn(page.html, d, careers);
      if (address) emails[slot] = { address, page: page.url };
    }
    // The page's own address counts too: careers.acme.com often redirects straight to the ATS.
    let hit = await fromLinks([page.url, ...links], "careers page", page.url, page.html);
    if (!hit && careers) {
      hit = await fromPage(page);
      if (hit?.careers_read) {
        careersRead ??= hit.careers_read;
        hit = null;
      }
    }
    return { url: page.url, links, hrefs: hrefsIn(page.html, page.url), hit };
  };
  // Breadth-first: the usual paths, the home page, then careers links found on any of them
  // (a careers page often hands off to a separate jobs site).
  const queue = [...pages, `https://${d}/`];
  const later = [];
  for (let url = queue.shift(); url; url = queue.shift()) {
    const r = await visit(url);
    if (r?.hit) return r.hit;
    if (r) {
      // Careers links a person could click: data attributes hold values, not pages.
      const next = careersLinks(r.hrefs, d, r.url).filter((u) => !visited.has(u));
      queue.unshift(...next.slice(0, 3));
      later.push(...next.slice(3));
    }
  }
  // A board named in a lead's own text (an HN post): only when the site found nothing, so a stale
  // link with one leftover posting can't beat today's board.
  if (c.after && !careersRead) {
    const hit = (await attempt(c.after, "lead text")) ?? (await fromLinks([c.after], "lead text"));
    if (hit) return hit;
  }
  // Pages for the caller to render, in order: the careers pages seen, then their links not read.
  const toRender = [
    ...new Set([...careersPages, ...later.filter((u) => !visited.has(u) && careersPage(u) !== null)]),
  ].slice(0, 4);
  // Nothing fetched at all: say why (an expired certificate, a domain that no longer resolves).
  // Pages fetched but no board and no roles on them: say that, not only "no board".
  const problem = tried.length
    ? careersRead
      ? null
      : (refused ?? "pages fetched, no board found")
    : siteProblem(errors);
  const email = careersRead ? null : (emails.careers ?? emails.home);
  return {
    provider: null,
    tried,
    careers_page: careersPages[0] ?? null,
    careers_pages: toRender,
    ...(careersRead ? { careers_read: careersRead } : {}),
    ...(problem ? { problem } : {}),
    ...(email ? { apply_email: email } : {}),
    ...(careersTitle ? { careers_title: careersTitle } : {}),
  };
}

/**
 * An Eightfold board link without its ?domain= (a posting's link, a bare /careers): the tenant's
 * API answers only with it, and the tenant's own careers page states it ("domain": "acme.com").
 */
async function withTenantDomain(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/\.eightfold\.ai$/i.test(u.hostname) || u.searchParams.get("domain")) return url;
  const page = await fetchPage(`${u.origin}/careers`).catch(() => null);
  const html = (page?.html ?? "").replace(/&#34;|&quot;/g, '"');
  const domain =
    html.match(/"domain"\s*:\s*"([a-z0-9.-]+\.[a-z]{2,})"/i)?.[1] ??
    html.match(/[?&]domain=([a-z0-9.-]+\.[a-z]{2,})/i)?.[1];
  return domain ? `${u.origin}/careers?domain=${domain.toLowerCase()}` : url;
}

function siteProblem(errors) {
  if (errors.some((e) => /^CERT_HAS_EXPIRED$/.test(e))) return "certificate expired";
  if (errors.some((e) => /CERT|SSL|TLS|SELF_SIGNED/i.test(e))) return "certificate not valid";
  if (errors.length && errors.every((e) => /ENOTFOUND|EAI_AGAIN|DNS/i.test(e)))
    return "domain doesn't resolve";
  return null;
}

const iso = (ms) => (ms && Number.isFinite(Number(ms)) ? new Date(ms).toISOString() : null);

async function scan(c, store) {
  const entry = { name: c.name ?? c.domain, careers_url: c.ats.careers_url, provider: c.ats.provider };
  let jobs;
  let complete = true;
  let lists = []; // the results' order, by job id or url (search.mjs NEWEST_FIRST)
  // A first read of a board that may be too big to read whole (searchAbove: the most roles it
  // reads whole): the board's own count decides, so it isn't learned by timing out. A board
  // that gives no count is read whole.
  let search = c.search;
  if (search?.length && c.searchAbove !== undefined) {
    const size = await boardSize(c.ats.provider, entry, ctx).catch(() => undefined);
    store.size = size;
    if (size === undefined || size <= c.searchAbove) search = undefined;
  }
  const queried = QUERIED.has(c.ats.provider);
  try {
    if (queried) {
      const r = await jobsFor({ ...entry }, false, false, c.search);
      if (!r) throw new Error(`no provider for ${c.ats.careers_url}`);
      jobs = r.jobs;
      lists = r.lists;
      complete = false; // one results page a query: never the end of its results
      store.provider = r.provider;
    } else if (search?.length) {
      const r = await searchBoard(c.ats.provider, entry, search, ctx, c.searchPages ?? 10);
      jobs = r.jobs;
      complete = r.complete;
      lists = r.lists;
    } else {
      const r = await jobsFor(entry, false, !!c.full);
      if (!r) throw new Error(`no provider for ${c.ats.careers_url}`);
      jobs = r.jobs;
      store.provider = r.provider;
    }
  } catch (err) {
    // A closed board: the API answers "not found" in JSON. An HTML 404 (a challenge page) isn't an answer.
    if (err?.status === 404 && /^\s*[{[]/.test(err.body ?? "")) return { jobs: [], complete: true };
    throw err;
  }
  store.searched = queried || !!search?.length;
  // A search newest first: each term's results in order, as indices into `jobs` (refresh.ts,
  // arrives), when some role has no date to say when it was posted.
  let order;
  if (store.searched && NEWEST_FIRST.includes(c.ats.provider) && jobs.some((j) => !j.postedAt)) {
    const at = new Map();
    jobs.forEach((j, i) => {
      at.set(j.url, i);
      if (j.externalId) at.set(String(j.externalId), i);
    });
    order = lists.map((l) => l.map((k) => at.get(String(k))).filter((i) => i !== undefined));
  }
  return {
    complete,
    order,
    jobs: jobs.map((j) => ({
      id: j.externalId || j.url,
      title: j.title,
      url: j.url,
      location: j.location ?? "",
      postedAt: iso(j.postedAt),
      updatedAt: iso(j.updatedAt),
      // Lever's and Ashby's lists carry the text anyway; the caller keeps it for roles that fit.
      description: j.description ? String(j.description).slice(0, 20_000) : undefined,
    })),
  };
}

const say = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

/** The work's answer, or an error at the deadline. */
async function within(work, deadline) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, no) => {
      timer = setTimeout(() => no(new Error(`timed out after ${Math.round(deadline / 1000)}s`)), deadline);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Up to 8 boards at once; each host's own limit (acquire) keeps a shared API host to 2.
const queue = [...req.companies];
async function worker() {
  for (let c = queue.shift(); c; c = queue.shift()) {
    try {
      // A company's site that answers slowly (or not) can't hold the rest: detection, like a
      // read, gives up at its deadline.
      if (req.mode === "detect")
        say({ domain: c.domain, ok: true, detect: await within(detect(c), c.deadlineMs ?? 120_000) });
      else {
        const store = { validators: c.validators };
        const r = await within(
          reading.run(store, () => scan(c, store)),
          c.deadlineMs ?? 120_000,
        );
        const boardCount = store.searched ? undefined : (store.total ?? store.listed);
        say({
          domain: c.domain,
          ok: true,
          jobs: r.jobs,
          complete: r.complete,
          ...(r.order ? { order: r.order } : {}),
          searched: !!store.searched,
          ...(store.size !== undefined ? { boardSize: store.size } : {}),
          ...(store.provider ? { provider: store.provider } : {}),
          ...(boardCount !== undefined ? { boardCount } : {}),
          ...(store.saved ? { validators: store.saved } : {}),
        });
      }
    } catch (err) {
      if (err instanceof NotModified) {
        say({ domain: c.domain, ok: true, unchanged: true });
        continue;
      }
      say({ domain: c.domain, ok: false, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(req.workers ?? 8, queue.length) }, worker));
say({ done: true, robotsExceptions: [...exceptionsUsed], requests });

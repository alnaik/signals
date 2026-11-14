// A big board's own search, for the runner: instead of reading every page of a board too large to
// read whole, ask it for the saved-search terms and read those results. Built on the vendored
// providers' exported URL builders and parsers, so their host pins and SSRF guards still apply.
// A board read this way is partial: what isn't in the results may still be open.

import { countArticles, parseArticles } from "../vendor/career-ops/providers/avature.mjs";
import {
  buildPcsxUrl,
  buildApiUrl as eightfoldUrl,
  normalizePcsxPage,
  parseEightfoldResponse,
  resolveTenant,
} from "../vendor/career-ops/providers/eightfold.mjs";
import { parseJibeapplyResponse } from "../vendor/career-ops/providers/jibeapply.mjs";
import {
  buildApiUrl as oracleUrl,
  parseOracleResponse,
  resolveSite,
} from "../vendor/career-ops/providers/oraclecloud.mjs";
import workday, { parseWorkdayResponse } from "../vendor/career-ops/providers/workday.mjs";

/**
 * Providers read through queries, not a list (Google Careers' results page): their queries are
 * the saved-search titles, newest first, and a read of them is partial.
 */
export const QUERIED = ["google", "google-careers", "apple", "microsoft"];

/** Providers whose board can be searched. */
export const SEARCHABLE = ["amazon", "workday", "eightfold", "oraclecloud", "jibeapply", "avature"];

/**
 * Providers whose results come newest first (Google's sort_by=date, amazon.jobs' sort=recent,
 * Oracle's POSTING_DATES_DESC, Avature's sort=publicationDate): in each term's results, a role
 * ahead of one already known was posted after it, however far down the read went.
 */
export const NEWEST_FIRST = [
  "google",
  "google-careers",
  "apple",
  "microsoft",
  "amazon",
  "oraclecloud",
  "avature",
];

/**
 * When each role on a Google Careers results page was created and last published, by its id:
 * the page's ds:1 data has them (the cards show neither), as [id, title, …] rows with Unix
 * seconds at [12] (created) and [13] (published; sort_by=date orders by it). Empty when the
 * page doesn't carry them in that shape.
 */
export function googleDates(html) {
  const dates = new Map();
  const m = String(html).match(/AF_initDataCallback\(\{key: 'ds:1',[\s\S]*?data:([\s\S]*?), sideChannel/);
  if (!m) return dates;
  let rows;
  try {
    rows = JSON.parse(m[1])?.[0];
  } catch {
    return dates;
  }
  if (!Array.isArray(rows)) return dates;
  const ms = (x) => (Array.isArray(x) && Number.isFinite(x[0]) && x[0] > 0 ? x[0] * 1000 : undefined);
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    const postedAt = ms(row[12]);
    const updatedAt = ms(row[13]) ?? postedAt;
    if (postedAt) dates.set(row[0], { postedAt, updatedAt });
  }
  return dates;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const amazon = {
  pageSize: 100,
  async page(_entry, term, offset, ctx) {
    const u = new URL("https://www.amazon.jobs/en/search.json");
    u.searchParams.set("base_query", term);
    u.searchParams.set("loc_query", "");
    u.searchParams.set("sort", "recent");
    u.searchParams.set("result_limit", "100");
    u.searchParams.set("offset", String(offset));
    const json = await ctx.fetchJson(u.href, { redirect: "error" });
    const jobs = (Array.isArray(json?.jobs) ? json.jobs : [])
      .filter((j) => typeof j.job_path === "string" && j.title)
      .map((j) => ({
        externalId: String(j.id_icims ?? j.id ?? j.job_path),
        title: String(j.title).trim(),
        url: `https://www.amazon.jobs${j.job_path.startsWith("/") ? "" : "/"}${j.job_path}`,
        location: String(j.normalized_location || j.location || ""),
        postedAt: Date.parse(String(j.posted_date ?? "").replace(/\s+/g, " ")) || undefined,
        description: [j.description, j.basic_qualifications, j.preferred_qualifications]
          .filter(Boolean)
          .join("\n\n"),
      }));
    return { jobs, total: Number.isFinite(json?.hits) ? json.hits : undefined };
  },
};

const workdaySearch = {
  pageSize: 20,
  async page(entry, term, offset, ctx) {
    const api = workday.detect(entry)?.url;
    if (!api) throw new Error(`workday: no search endpoint for ${entry.careers_url}`);
    const origin = new URL(api).origin;
    const json = await ctx.fetchJson(api, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        origin,
      },
      body: JSON.stringify({ limit: 20, offset, searchText: term, appliedFacets: {} }),
    });
    return {
      jobs: parseWorkdayResponse(json, entry),
      total: Number.isFinite(json?.total) ? json.total : undefined,
    };
  },
};

// Tenants moved to Eightfold's newer API (PCSX) refuse the classic one with a 403; the same
// query goes to PCSX then (Lockheed Martin's and Morgan Stanley's, 2026-10-29).
const pcsxHosts = new Set();
const eightfold = {
  pageSize: 10,
  async page(entry, term, offset, ctx) {
    const tenant = resolveTenant(entry);
    if (!tenant) throw new Error(`eightfold: no tenant for ${entry.careers_url}`);
    const get = (url) => ctx.fetchJson(url, { redirect: "error", headers: { accept: "application/json" } });
    let json = null;
    if (!pcsxHosts.has(tenant.host))
      try {
        json = await get(`${eightfoldUrl(tenant, offset, 10)}&query=${encodeURIComponent(term)}`);
      } catch (err) {
        if (err?.status !== 403) throw err;
        pcsxHosts.add(tenant.host);
      }
    if (!json) {
      json = normalizePcsxPage(
        await get(`${buildPcsxUrl(tenant, offset)}&query=${encodeURIComponent(term)}`),
      );
      if (!json) throw new Error(`eightfold: ${tenant.host} answered no job list`);
    }
    return {
      jobs: parseEightfoldResponse(json, tenant, entry.name),
      total: Number.isFinite(json?.count) ? json.count : undefined,
    };
  },
};

const oraclecloud = {
  pageSize: 200,
  async page(entry, term, offset, ctx) {
    const site = resolveSite(entry);
    if (!site) throw new Error(`oraclecloud: no site for ${entry.careers_url}`);
    // The finder takes the keyword beside its other parameters; no term, no keyword (the whole board).
    const url = term
      ? oracleUrl(site, offset, 200).replace(
          "findReqs;",
          `findReqs;keyword=${encodeURIComponent(`"${term.replace(/"/g, "")}"`)},`,
        )
      : oracleUrl(site, offset, 200);
    const json = await ctx.fetchJson(url, { redirect: "error", headers: { accept: "application/json" } });
    const total = json?.items?.[0]?.TotalJobsCount;
    return {
      jobs: parseOracleResponse(json, site, entry.name),
      total: Number.isFinite(total) ? total : undefined,
    };
  },
};

// A Jibe site (iCIMS; jobs.geogroup.com, 755 roles under a 5s crawl-delay): its /api/jobs
// takes keywords, ten a page.
const jibeapply = {
  pageSize: 10,
  async page(entry, term, offset, ctx) {
    const u = new URL(entry.api || entry.careers_url);
    if (!u.pathname.startsWith("/api/")) u.pathname = `/api${u.pathname}`;
    if (term) u.searchParams.set("keywords", term);
    u.searchParams.set("page", String(offset / 10 + 1));
    const json = await ctx.fetchJson(u.href, { redirect: "error" });
    return {
      jobs: parseJibeapplyResponse(json, entry),
      total: Number.isFinite(json?.totalCount) ? json.totalCount : undefined,
    };
  },
};

// An Avature site (apply.deloitte.com): SearchJobs takes ?search=, six or ten cards a page as
// the tenant serves them, and states no total. A search is by relevance unless asked
// sort=publicationDate (the results page's own sort link): newest first, as a list with no term is. Its whole list is capped at 50 pages by the
// provider with nothing saying so, so a board is only ever read through its search, like
// amazon.jobs. Cards whose first class is missing (Deloitte's) are matched too.
const avature = {
  pageSize: 6,
  async page(entry, term, offset, ctx) {
    const u = new URL(entry.api || entry.careers_url);
    if (!/\/SearchJobs\/?$/i.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/$/, "")}/SearchJobs`;
    if (term) u.searchParams.set("search", term);
    u.searchParams.set("jobOffset", String(offset));
    u.searchParams.set("sort", "publicationDate");
    const html = String(await ctx.fetchText(u.href, { redirect: "error" })).replace(
      /<article class="article--(result|jobs)\b/g,
      '<article class="article article--$1',
    );
    return { jobs: parseArticles(html, u.origin), size: countArticles(html) };
  },
};

const BY = { amazon, workday: workdaySearch, eightfold, oraclecloud, jibeapply, avature };

/**
 * How many roles the board says it has, from its search's first page with no term (Workday's
 * "total", Eightfold's "count", Oracle's TotalJobsCount); undefined when it doesn't say.
 */
export async function boardSize(provider, entry, ctx) {
  const s = BY[provider];
  if (!s) return undefined;
  const { total } = await s.page(entry, "", 0, ctx);
  return total;
}

/**
 * The board's results for each term, up to `maxPages` pages a term, one board's requests in
 * turn, and no page started after `budgetMs`: JPMorganChase's Oracle answers a page in 2.2s, and
 * its 30 pages would hold Refresh all past a minute. `complete` says every term's results were
 * read to the end; `lists`, each term's results in the order the board gave them (their urls).
 * A searched read is partial either way: it closes nothing.
 */
export async function searchBoard(provider, entry, terms, ctx, maxPages = 10, budgetMs = 30_000) {
  const s = BY[provider];
  if (!s) throw new Error(`${provider} boards can't be searched`);
  const seen = new Map();
  const until = Date.now() + budgetMs;
  let complete = true;
  // Page by page across the terms (each term's first page, then each one's second, …), so a
  // budget that runs out leaves every term its newest results.
  let open = [...terms];
  // Each term's next offset: a page moves it on by the cards it held (an Avature tenant's page
  // is six or ten), or by the provider's page size.
  const offset = new Map(terms.map((t) => [t, 0]));
  const lists = new Map(terms.map((t) => [t, []]));
  for (let p = 0; p < maxPages && open.length; p++) {
    const still = [];
    for (const term of open) {
      if (Date.now() >= until)
        return { jobs: [...seen.values()], complete: false, lists: [...lists.values()] };
      if (p > 0 || term !== open[0]) await pause(250);
      const { jobs, total, size } = await s.page(entry, term, offset.get(term), ctx);
      let fresh = 0;
      for (const j of jobs) {
        lists.get(term).push(j.url);
        if (seen.has(j.url)) continue;
        seen.set(j.url, j);
        fresh++;
      }
      const step = size ?? s.pageSize;
      const end = offset.get(term) + step;
      offset.set(term, end);
      if (
        step === 0 ||
        jobs.length < Math.min(step, s.pageSize) ||
        fresh === 0 ||
        (total !== undefined && end >= total)
      )
        continue;
      if (p === maxPages - 1) complete = false;
      else still.push(term);
    }
    open = still;
  }
  return { jobs: [...seen.values()], complete, lists: [...lists.values()] };
}

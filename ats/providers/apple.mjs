// Apple's own jobs site (jobs.apple.com), read the way its search page is: one GET per query,
// newest first, the results in the page's own hydration data (window.__staticRouterHydrationData).
// jobs.apple.com has no robots.txt (it redirects to a 404), so every path is allowed. Its JSON API
// (/api/v1/search) wants a session cookie and a CSRF token; the page needs neither.
//   GET https://jobs.apple.com/en-us/search?search=<q>&sort=newest&page=<n>   20 a page
// A query provider (ats/search.mjs QUERIED): read by the saved-search titles, never whole.

const ORIGIN = "https://jobs.apple.com";
const PAGES = 3; // pages a query reads: its 60 newest

/** The search results in a results page's hydration data, and the total it says it has. */
export function appleResults(html) {
  const m = String(html).match(/__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:[^"\\]|\\.)*)"\)/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(JSON.parse(`"${m[1]}"`));
  } catch {
    return null;
  }
  const s = data?.loaderData?.search;
  if (!s || !Array.isArray(s.searchResults)) return null;
  return { results: s.searchResults, total: Number(s.totalRecords) || 0 };
}

const place = (l) => [...new Set([l?.name, l?.countryName].filter(Boolean))].join(", ");

/** One result as a job. */
export function appleJob(r) {
  const id = String(r.positionId ?? r.id ?? "");
  const slug = r.transformedPostingTitle || "role";
  const team = r.team?.teamCode ? `?team=${encodeURIComponent(r.team.teamCode)}` : "";
  const posted = Date.parse(r.postDateInGMT ?? "");
  return {
    title: String(r.postingTitle ?? "").trim(),
    url: `${ORIGIN}/en-us/details/${encodeURIComponent(r.id ?? id)}/${encodeURIComponent(slug)}${team}`,
    location: (r.locations ?? []).map(place).filter(Boolean).join("; "),
    ...(id ? { externalId: id } : {}),
    postedAt: Number.isNaN(posted) ? null : posted,
  };
}

export default {
  id: "apple",

  detect(entry) {
    try {
      return new URL(entry.careers_url).hostname === "jobs.apple.com"
        ? { url: `${ORIGIN}/en-us/search` }
        : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const queries = entry.apple?.queries?.length ? entry.apple.queries : ["software engineer"];
    const probing = Number(ctx?.maxPages) > 0;
    const byId = new Map();
    for (const q of probing ? queries.slice(0, 1) : queries) {
      for (let page = 1; page <= (probing ? 1 : PAGES); page++) {
        const url = `${ORIGIN}/en-us/search?${new URLSearchParams({ search: String(q), sort: "newest", page: String(page) })}`;
        const got = appleResults(await ctx.fetchText(url, { redirect: "error" }));
        if (!got) throw new Error(`apple: no results data at ${url}`);
        for (const r of got.results) {
          const j = appleJob(r);
          if (j.title && !byId.has(j.externalId ?? j.url)) byId.set(j.externalId ?? j.url, j);
        }
        if (got.results.length < 20 || page * 20 >= got.total) break;
      }
    }
    return [...byId.values()];
  },
};

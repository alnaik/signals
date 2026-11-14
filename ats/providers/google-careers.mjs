// One company's roles on Google Careers (Google DeepMind's: deepmind.google/careers links
// …/jobs/results?company=DeepMind). The vendored `google` provider reads Google's own roles in
// one country; this one keeps the link's company filter and no place, newest first. Google's
// robots.txt allows the results page with company=, q= and sort_by=, and disallows page=: one
// results page (20) a query.
// A query provider (ats/search.mjs QUERIED): read by the saved-search titles, never whole.
import { parseResultsPage } from "../../vendor/career-ops/providers/google.mjs";

const BASE = "https://www.google.com/about/careers/applications/jobs/results/";

/** The company filter a results link carries ("DeepMind"), or null. */
export function companyOf(url) {
  try {
    const u = new URL(url);
    if (
      !/^(?:www\.)?google\.com$/i.test(u.hostname) ||
      !u.pathname.startsWith("/about/careers/applications/jobs/results")
    )
      return null;
    return u.searchParams.get("company") || null;
  } catch {
    return null;
  }
}

export default {
  id: "google-careers",

  detect(entry) {
    const company = companyOf(entry.careers_url);
    return company ? { url: `${BASE}?${new URLSearchParams({ company })}` } : null;
  },

  async fetch(entry, ctx) {
    const company = companyOf(entry.careers_url);
    if (!company) throw new Error(`google-careers: no company in ${entry.careers_url}`);
    const queries = entry["google-careers"]?.queries?.length
      ? entry["google-careers"].queries
      : ["software engineer"];
    const probing = Number(ctx?.maxPages) > 0;
    const byId = new Map();
    for (const q of probing ? queries.slice(0, 1) : queries) {
      const url = `${BASE}?${new URLSearchParams({ company, q: String(q), sort_by: "date" })}`;
      for (const { id, slug, title, locations } of parseResultsPage(
        await ctx.fetchText(url, { redirect: "error" }),
      )) {
        if (byId.has(id)) continue;
        byId.set(id, { title, url: `${BASE}${id}-${slug}`, location: locations.join("; "), externalId: id });
      }
    }
    return [...byId.values()];
  },
};

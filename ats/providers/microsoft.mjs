// Microsoft's own jobs site (apply.careers.microsoft.com), read through the search its careers
// page calls: GET /api/pcsx/search, newest first, 10 a page. robots.txt there allows /careers and
// /api/pcsx under `User-agent: *` (and disallows the rest). The search answers 429 to a request
// without the anonymous session the careers page sets, so that page is read first for its cookies,
// as a browser would; no login, no token.
// A query provider (ats/search.mjs QUERIED): read by the saved-search titles, never whole.

const ORIGIN = "https://apply.careers.microsoft.com";
const PAGES = 3; // pages a query reads: its 30 newest
const HOSTS = /^(?:apply\.careers|jobs\.careers|careers)\.microsoft\.com$/i;

/** The cookies a response sets, as one Cookie header. */
export function cookieHeader(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return all.map((c) => c.split(";")[0]).join("; ");
}

/** One search position as a job. */
export function microsoftJob(p) {
  const id = String(p.id ?? "");
  return {
    title: String(p.name ?? "").trim(),
    url: `${ORIGIN}${p.positionUrl ?? `/careers/job/${id}`}`,
    location: (p.standardizedLocations?.length ? p.standardizedLocations : (p.locations ?? [])).join("; "),
    ...(id ? { externalId: id } : {}),
    postedAt: Number(p.postedTs) > 0 ? Number(p.postedTs) * 1000 : null,
  };
}

export default {
  id: "microsoft",

  detect(entry) {
    try {
      return HOSTS.test(new URL(entry.careers_url).hostname) ? { url: `${ORIGIN}/careers` } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const queries = entry.microsoft?.queries?.length ? entry.microsoft.queries : ["software engineer"];
    const probing = Number(ctx?.maxPages) > 0;
    const session = await ctx.fetchResponse(`${ORIGIN}/careers`, { redirect: "error" });
    const cookie = cookieHeader(session);
    const byId = new Map();
    for (const q of probing ? queries.slice(0, 1) : queries) {
      for (let page = 0; page < (probing ? 1 : PAGES); page++) {
        const url = `${ORIGIN}/api/pcsx/search?${new URLSearchParams({ domain: "microsoft.com", query: String(q), location: "", start: String(page * 10), sort_by: "timestamp" })}`;
        const json = await ctx.fetchJson(url, { redirect: "error", headers: cookie ? { cookie } : {} });
        const positions = json?.data?.positions;
        if (!Array.isArray(positions)) throw new Error("microsoft: the search answered without positions");
        for (const p of positions) {
          const j = microsoftJob(p);
          if (j.title && !byId.has(j.externalId ?? j.url)) byId.set(j.externalId ?? j.url, j);
        }
        if (positions.length < 10 || (page + 1) * 10 >= Number(json.data.count ?? 0)) break;
      }
    }
    return [...byId.values()];
  },
};

// Polymer job boards (jobs.polymer.co/<slug>, or the company's own jobs.<domain> in Polymer's
// markup: links.mjs EMBEDS), read through the public API the board's own page uses,
// api.polymer.co/v1/hire/organizations/<slug>/jobs, a page at a time. robots.txt there is empty.

const API = "https://api.polymer.co/v1/hire/organizations";
const PAGES = 20;

const slugOf = (url) => {
  try {
    const u = new URL(url);
    if (!/^jobs\.polymer\.co$/i.test(u.hostname)) return null;
    return u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
};

/** One API item as a job. */
export function polymerJob(j) {
  const remote =
    /remote/i.test(j.remoteness_pretty ?? "") && !/^no remote/i.test(j.remoteness_pretty) ? ["Remote"] : [];
  const place = j.display_location || [j.city, j.state_region, j.country].filter(Boolean).join(", ");
  const posted = Date.parse(j.published_at ?? "");
  return {
    title: String(j.title ?? "").trim(),
    url: String(j.job_post_url ?? ""),
    location: [place, ...remote].filter(Boolean).join(" · "),
    externalId: String(j.id ?? j.job_post_url),
    postedAt: Number.isNaN(posted) ? null : posted,
  };
}

export default {
  id: "polymer",

  detect(entry) {
    const slug = slugOf(entry.careers_url);
    return slug ? { url: `${API}/${slug}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const slug = slugOf(entry.careers_url);
    if (!slug) throw new Error(`polymer: no board in ${entry.careers_url}`);
    const out = [];
    const pages = Number(ctx?.maxPages) > 0 ? 1 : PAGES;
    for (let page = 1; page <= pages; page++) {
      const json = await ctx.fetchJson(`${API}/${slug}/jobs?page=${page}`);
      if (!Array.isArray(json?.items)) throw new Error("polymer: the board answered without a job list");
      out.push(...json.items.map(polymerJob).filter((j) => j.title && j.url));
      // meta.total is the number of pages.
      if (!json.items.length || page >= Number(json.meta?.total ?? 1)) break;
    }
    return out;
  },
};

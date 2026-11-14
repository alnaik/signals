// Homerun career sites (<company>.homerun.co): the job list is in the page itself, as the
// <job-list v-bind="…"> component's data (vacancies, locations). robots.txt there allows all.

const HOST = /^([a-z0-9-]+)\.homerun\.co$/i;
const NOT_A_SITE = new Set(["www", "static", "api", "app", "help"]);

const tenant = (url) => {
  try {
    const m = new URL(url).hostname.match(HOST);
    return m && !NOT_A_SITE.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The vacancies in a Homerun career site's page, or null when it has no job list. */
export function homerunJobs(html) {
  const m = String(html).match(/<job-list\b[^>]*\sv-bind="([^"]*)"/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(
      m[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&"),
    );
  } catch {
    return null;
  }
  const content = data?.content;
  if (!Array.isArray(content?.vacancies)) return null;
  const places = new Map(
    (content.locations ?? []).map((l) => [
      l.id,
      [l.locality ?? l.name, l.country].filter(Boolean).join(", "),
    ]),
  );
  return content.vacancies
    .filter((v) => v?.title && v.url)
    .map((v) => ({
      title: String(v.title).trim(),
      url: String(v.url),
      location: places.get(v.location_id) ?? "",
      externalId: String(v.id ?? v.url),
      postedAt: null,
    }));
}

export default {
  id: "homerun",

  detect(entry) {
    const t = tenant(entry.careers_url);
    return t ? { url: `https://${t}.homerun.co/` } : null;
  },

  async fetch(entry, ctx) {
    const t = tenant(entry.careers_url);
    if (!t) throw new Error(`homerun: no career site in ${entry.careers_url}`);
    const jobs = homerunJobs(await ctx.fetchText(`https://${t}.homerun.co/`));
    if (!jobs) throw new Error(`homerun: ${t}.homerun.co has no job list`);
    return jobs;
  },
};

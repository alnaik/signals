// Y Combinator's company jobs pages (ycombinator.com/companies/<slug>/jobs): the jobs are in the
// page's own Inertia data (<div data-page="…">, component WaasShowJobsPage). robots.txt there
// allows them (it disallows /companies?*, the directory's search). A Work at a Startup link
// (workatastartup.com/companies/<slug>, its /embed/<slug>/jobs widget) names the same company.

const ORIGIN = "https://www.ycombinator.com";
const YC = /^(?:www\.)?ycombinator\.com$/i;
const WAAS = /^(?:www\.)?workatastartup\.com$/i;

/** The company's slug in a YC or Work at a Startup link, or null. */
export function ycSlug(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (YC.test(u.hostname) && parts[0] === "companies" && parts[1] && parts[2] === "jobs")
    return parts[1].toLowerCase();
  if (WAAS.test(u.hostname) && ["companies", "embed"].includes(parts[0]) && parts[1])
    return parts[1].toLowerCase();
  return null;
}

const entities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The jobs in a YC company jobs page's data, or null when the page isn't one. */
export function ycJobs(html) {
  const m = String(html).match(/\sdata-page="([^"]*)"/);
  if (!m) return null;
  let page;
  try {
    page = JSON.parse(entities(m[1]));
  } catch {
    return null;
  }
  if (page?.component !== "WaasShowJobsPage" || !Array.isArray(page.props?.jobPostings)) return null;
  return page.props.jobPostings
    .filter((j) => j?.title && j.url)
    .map((j) => ({
      title: String(j.title).trim(),
      url: new URL(j.url, ORIGIN).href,
      location: String(j.location ?? ""),
      externalId: String(j.id ?? j.url),
      postedAt: null, // the page says "5 months", not a date
    }));
}

export default {
  id: "yc",

  detect(entry) {
    const slug = ycSlug(entry.careers_url);
    return slug ? { url: `${ORIGIN}/companies/${slug}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const slug = ycSlug(entry.careers_url);
    if (!slug) throw new Error(`yc: no company in ${entry.careers_url}`);
    const jobs = ycJobs(await ctx.fetchText(`${ORIGIN}/companies/${slug}/jobs`));
    if (!jobs) throw new Error(`yc: ${slug} has no company jobs page`);
    return jobs;
  },
};

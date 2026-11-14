// A careers site's own list of its role pages: the sitemap its robots.txt names. Meta's careers
// page lists 20 featured roles; robots.txt names /jobsearch/sitemap.xml, every role's
// /profile/job_details/<id>/ page (1,312 on 2026-11-01), and each page carries its JobPosting
// (title, places, date, text). Read only where the pages do: three are tried first.
import { jsonLdJobs, ldBlocks, ldPostings } from "./careers.ts";
import type { Job } from "./reader.ts";

export const SITEMAP_URLS = 5000; // a sitemap's role pages, at most

/**
 * The sitemap robots.txt names for this careers page: one under the page's own first path segment
 * (/jobsearch/ → /jobsearch/sitemap.xml), else one whose file says jobs or careers.
 */
export function pickSitemap(careersUrl: string, sitemaps: string[]): string | null {
  const page = new URL(careersUrl);
  const seg = page.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  const same = sitemaps.filter((s) => {
    try {
      return new URL(s).host === page.host;
    } catch {
      return false;
    }
  });
  const under =
    seg && same.find((s) => new URL(s).pathname.toLowerCase().split("/").filter(Boolean)[0] === seg);
  return under || same.find((s) => /job|career/i.test(new URL(s).pathname.split("/").pop() ?? "")) || null;
}

/** A sitemap's page addresses; none from a sitemap index (it lists sitemaps, not pages). */
export function sitemapLocs(xml: string): string[] {
  if (/<sitemapindex[\s>]/i.test(xml)) return [];
  return [...xml.matchAll(/<url>\s*<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => m[1]!.replace(/&amp;/g, "&"))
    .slice(0, SITEMAP_URLS);
}

/** A role page's role, from its JobPosting: the page's own address, its text the posting's sections. */
export function rolePage(html: string, url: string): Job | null {
  const job = jsonLdJobs(ldBlocks(html), url)[0];
  if (!job) return null;
  const p = ldPostings(html)[0] ?? {};
  const text = [p.description, p.responsibilities, p.qualifications].filter(
    (x): x is string => typeof x === "string" && x.trim() !== "",
  );
  return { ...job, url, ...(text.length ? { description: text.join("\n\n") } : {}) };
}

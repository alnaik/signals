// Companies with no ATS: their own careers page is the board, read from its plain HTML without a
// model: schema.org JobPosting data, a job list in the page's own data that no ATS claims
// (detection checks that first), or the jobs feed it names. A page none of these reads is read by
// the small model (pages.ts). Snapshots and diffs then work as for any ATS.
import { isPublicUrl, unescapeHtml } from "../core/http.ts";
// @ts-expect-error plain JS module
import { feedJobs, isFeed, otherEmployers, ownJobList } from "./links.mjs";
import type { Job } from "./reader.ts";

type Ld = Record<string, unknown>;
function flat(v: unknown): Ld[] {
  if (Array.isArray(v)) return v.flatMap(flat);
  if (v && typeof v === "object") {
    const o = v as Ld;
    return [o, ...flat(o["@graph"]), ...flat(o.itemListElement), ...flat(o.item)];
  }
  return [];
}

/** A page's schema.org blocks, parsed; a broken one is skipped. */
export function ldBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => {
    try {
      return [JSON.parse(m[1]!)];
    } catch {
      return [];
    }
  });
}

/** The page's JobPosting objects, as they are (board search reads hiringOrganization). */
export const ldPostings = (html: string): Ld[] => flat(ldBlocks(html)).filter(isPosting);

const isPosting = (o: Ld) => [o["@type"]].flat().includes("JobPosting");

/** "Boulder, CO · Denver, CO", plus "Remote" for TELECOMMUTE postings. */
function ldLocation(o: Ld): string {
  const places = flat(o.jobLocation)
    .map((l) => (l.address as Ld | undefined) ?? l)
    .map((a) => [a.addressLocality, a.addressRegion].filter((x) => typeof x === "string" && x).join(", "))
    .filter(Boolean);
  const remote = [o.jobLocationType].flat().includes("TELECOMMUTE") ? ["Remote"] : [];
  return [...new Set([...places, ...remote])].join(" · ");
}

export function jsonLdJobs(jsonld: unknown[], pageUrl: string): Job[] {
  return (
    flat(jsonld)
      .filter((o) => isPosting(o) && typeof o.title === "string")
      // A posting's link must be a public web page: no javascript:, file: or loopback.
      .filter((o) => isPublicUrl(String(o.url ?? pageUrl)))
      .map((o) => {
        const url = String(o.url ?? pageUrl);
        const posted = typeof o.datePosted === "string" ? Date.parse(o.datePosted) : Number.NaN;
        return {
          id: String((o.identifier as Ld | undefined)?.value ?? url),
          title: unescapeHtml(String(o.title)).trim(),
          url,
          location: unescapeHtml(ldLocation(o)),
          postedAt: Number.isNaN(posted) ? null : new Date(posted).toISOString(),
        };
      })
  );
}

/**
 * A careers page's postings from its plain HTML: JobPosting data, else its own job list in its
 * data. A jobs feed the page named is read as the feed it is. A list whose roles are at many
 * employers (a fund's job board, a job site's feed) is no company's: no jobs, and `others` names
 * those employers.
 */
export function careersRead(html: string, pageUrl: string): { jobs: Job[]; others: string[] } {
  type Listed = {
    id: string;
    title: string;
    url: string;
    location?: string;
    postedAt?: string | null;
    employer?: string | null;
  };
  const jobs = (list: Listed[]): Job[] =>
    list.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      location: r.location ?? "",
      postedAt: r.postedAt ?? null,
    }));
  const one = (list: Job[], entries: Pick<Listed, "url" | "title" | "employer">[] = list) => {
    const others: string[] = otherEmployers(entries, pageUrl);
    return others.length ? { jobs: [], others } : { jobs: list, others };
  };
  if (isFeed(html)) {
    const feed: Listed[] = feedJobs(html, pageUrl);
    return one(jobs(feed), feed);
  }
  const ld = jsonLdJobs(ldBlocks(html), pageUrl);
  if (ld.length) {
    const org = (o: Ld) => (o.hiringOrganization as Ld | undefined)?.name;
    const named = ldPostings(html).map((o) => ({
      url: String(o.url ?? pageUrl),
      title: String(o.title ?? ""),
      employer: typeof org(o) === "string" ? (org(o) as string) : null,
    }));
    return one(ld, named);
  }
  const list: Listed[] = ownJobList([html], pageUrl);
  return list.length >= 3 ? one(jobs(list), list) : { jobs: [], others: [] };
}

/** careersRead's jobs. */
export const careersJobs = (html: string, pageUrl: string): Job[] => careersRead(html, pageUrl).jobs;

// Fund portals: a venture fund's job site lists the companies it backs, with their websites and
// how many roles each has open. A ticked fund's hiring companies come in weekly, each once; their
// boards are found from their websites like any company's, and your titles and places pick their
// roles for the Inbox. A fund is a row: its key, name, reader and page. Off until a fund is ticked.
//
// Checked 2026-11-12, robots.txt and terms, before a reader was written:
// - a16z (jobs.a16z.com): robots.txt allows all; no terms on the job site and a16z.com's terms
//   don't speak to automated reading. Its own site (Next.js), not Consider or Getro: one page,
//   /companies, states every portfolio company with its website and open-role count.
// - Index Ventures (indexventures.com): robots.txt refuses only PDFs and two landing pages; no
//   terms of use, its disclaimer asks only that content "should not be reproduced", nothing on
//   reading. Its own site (Wagtail), not Consider or Getro. Its jobs page is built by script from a
//   search service, so it isn't read; instead two plain pages: /companies/ states every company's
//   name, and the jobs sitemap lists every open role under its company's name. A hiring company's
//   website is on its page there, read once when it first hires.
// - Y Combinator (ycombinator.com/jobs, workatastartup.com): left out. robots.txt allows /jobs, but
//   its terms (which cover Work at a Startup too) forbid "data mining, robots, scraping".
// - Consider (Sequoia, USV, Bessemer, Lightspeed): left out. Its terms forbid "any robot, spider,
//   scraper, or other automated means" without written permission, and its search needs a
//   session's token.
// - Getro (Accel, General Catalyst, Khosla): left out. Its terms forbid crawling or scraping any
//   page of its services, and its API's robots.txt (api.getro.com) disallows everything.
import { ldBlocks } from "../../ats/careers.ts";
import { loadConfig } from "../../core/config.ts";
import { politeGet, unescapeHtml } from "../../core/http.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { readSourceState, writeSourceState } from "../../signals/state.ts";

/** `siteOnPage`: the fund states a company's website only on the company's own page there. */
export type Fund = {
  key: string;
  name: string;
  reader: keyof typeof readers;
  url: string;
  siteOnPage?: true;
};
/** A company the fund backs; `page` is its page on the fund's site. */
export type Portfolio = {
  name: string;
  domain: string;
  slug: string;
  jobs: number;
  location: string;
  page: string;
};

export const FUNDS: Fund[] = [
  { key: "a16z", name: "Andreessen Horowitz (a16z)", reader: "a16z", url: "https://jobs.a16z.com/companies" },
  {
    key: "index",
    name: "Index Ventures",
    reader: "index",
    url: "https://www.indexventures.com/companies/",
    siteOnPage: true,
  },
];

/** The ticked funds, from `[source.funds] picks`. */
export const picks = (): string[] => {
  const p = loadConfig().source.funds?.picks;
  return Array.isArray(p) ? p.filter((k): k is string => FUNDS.some((f) => f.key === k)) : [];
};

/**
 * A Next.js page's server data: the `self.__next_f.push([1, "…"])` strings, joined. The array named
 * `key` in it, read whole, or null when the page doesn't carry it.
 */
export function nextArray(html: string, key: string): unknown[] | null {
  const text = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]!) as string;
      } catch {
        return "";
      }
    })
    .join("");
  const at = text.indexOf(`"${key}":[`);
  if (at < 0) return null;
  const start = at + key.length + 3;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export const readers = {
  /** jobs.a16z.com/companies: every company, its website and how many roles it has open. */
  a16z: async (f: Fund): Promise<Portfolio[]> => {
    const page = await politeGet(f.url, { accept: "text/html", maxBytes: 5_000_000, timeoutMs: 30_000 });
    const list = nextArray(page.text, "companies");
    if (!list) throw new Error("the companies list wasn't on the page: its layout changed");
    return (list as Record<string, unknown>[]).map((c) => ({
      name: String(c.name ?? ""),
      domain: String(c.domain ?? ""),
      slug: String(c.slug ?? ""),
      jobs: Number(c.jobCount) || 0,
      location: String(c.location ?? ""),
      page: new URL(`/company/${encodeURIComponent(String(c.slug ?? ""))}`, f.url).href,
    }));
  },
  /**
   * indexventures.com: /companies/ names every company in its JSON-LD list; the jobs sitemap files
   * each open role under the company's name as a slug (/startup-jobs/incident-io/…). Roles filed
   * only under "remote" don't say whose they are and aren't counted.
   */
  index: async (f: Fund): Promise<Portfolio[]> => {
    const page = await politeGet(f.url, { accept: "text/html", maxBytes: 3_000_000, timeoutMs: 30_000 });
    const list = ldItems(page.text);
    if (!list.length) throw new Error("the companies list wasn't on the page: its layout changed");
    const sitemap = await politeGet(new URL("/sitemap-jobs.xml", f.url).href, {
      accept: "application/xml",
      maxBytes: 20_000_000,
      timeoutMs: 60_000,
    });
    const jobs = new Map<string, number>();
    for (const m of sitemap.text.matchAll(
      /<loc>https:\/\/www\.indexventures\.com\/startup-jobs\/([^/<]+)\/[^/<]+\/<\/loc>/g,
    ))
      jobs.set(m[1]!, (jobs.get(m[1]!) ?? 0) + 1);
    return list.map((c) => ({
      name: c.name,
      domain: "",
      slug: c.url.match(/\/companies\/([^/]+)/)?.[1] ?? slugOf(c.name),
      jobs: jobs.get(slugOf(c.name)) ?? 0,
      location: "",
      page: c.url,
    }));
  },
};

/** "incident.io" → "incident-io", "Café X" → "cafe-x": a name as Index's job addresses write it. */
export const slugOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A page's JSON-LD nodes, `@graph`s opened up. */
const ldNodes = (html: string): Record<string, unknown>[] =>
  (ldBlocks(html) as Record<string, unknown>[]).flatMap((j) =>
    Array.isArray(j?.["@graph"]) ? (j["@graph"] as Record<string, unknown>[]) : [j],
  );

/** The names and pages in a page's JSON-LD ItemList (Index's /companies/). */
export function ldItems(html: string): { name: string; url: string }[] {
  for (const n of ldNodes(html)) {
    const list = (n.mainEntity as { itemListElement?: unknown } | undefined)?.itemListElement;
    if (n["@type"] === "CollectionPage" && Array.isArray(list))
      return (list as Record<string, unknown>[])
        .map((i) => ({ name: unescapeHtml(String(i.name ?? "")).trim(), url: String(i.url ?? "") }))
        .filter((i) => i.name && i.url);
  }
  return [];
}

/** The website a company's page on a fund's site states (its JSON-LD Organization's url), or "". */
export async function websiteOn(page: string): Promise<string> {
  const html = (await politeGet(page, { accept: "text/html", timeoutMs: 30_000 })).text;
  const org = ldNodes(html).find((n) => n["@type"] === "Organization" && typeof n.url === "string");
  try {
    return org ? new URL(String(org.url)).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

const funds: Source = {
  key: "funds",
  name: "Fund portals",
  schedule: "nightly", // weekly: [source.funds] day = "tuesday" (the default)
  off: true,
  connected: () => picks().length > 0,
  status: () => (picks().length ? undefined : "no fund ticked"),
  fetch: async (_since, now = new Date()) => {
    const state = readSourceState<{ seen: Record<string, string[]> }>("funds", { seen: {} });
    const leads: Lead[] = [];
    let read = 0;
    for (const f of FUNDS.filter((x) => picks().includes(x.key))) {
      const seen = new Set(state.seen[f.key] ?? []);
      const companies = await readers[f.reader](f);
      read += companies.length;
      for (const c of companies) {
        // Hiring now, with a website: each comes in once; one with no roles open waits until it has.
        if (!c.jobs || !c.name || seen.has(c.slug)) continue;
        // A fund that states the website only on the company's own page there: read it once, now.
        const domain = c.domain || (f.siteOnPage ? await websiteOn(c.page).catch(() => "") : "");
        if (!domain) continue;
        seen.add(c.slug);
        leads.push({
          url: c.page,
          company_hint: c.name,
          // The fund's page says so; the company's own homepage still has to name it.
          domain,
          domain_from: "looked up",
          kind: "company",
          source: "funds",
          source_tag: f.key,
          text: [c.name, `${c.jobs} open roles`, c.location, `backed by ${f.name}`]
            .filter(Boolean)
            .join(" · "),
          seen_at: now.toISOString(),
        });
      }
      state.seen[f.key] = [...seen];
    }
    writeSourceState("funds", state);
    funds.read = read;
    return leads;
  },
};

export default funds;

// Intake: each lead is a signal. It names its company by plain rules and is kept as received
// (intake/companies.ts). One whose company can't be told by rule waits, with no company, for the
// small-model classifier.
import { ATS_URL, registrable } from "../ats/reader.ts";
import { threadId } from "../core/log.ts";
import { recordSignal, type SignalResult } from "./companies.ts";
import type { Lead } from "./types.ts";

// Hosts where people post (a post, a profile, a newsletter, a repo, a form): a link there is
// someone's, not the company's site. The host itself is the domain of the company that runs it
// (Substack, GitHub), given proof (intake/domain.ts); a subdomain or a page on it never is.
const POST_HOSTS = [
  "x.com",
  "twitter.com",
  "linkedin.com",
  "lnkd.in",
  "t.co",
  "instagram.com",
  "news.ycombinator.com",
  "github.com",
  "medium.com",
  "substack.com",
  "youtube.com",
  "reddit.com",
  "google.com",
  "sec.gov",
];

// Pages that list other companies' jobs: the ATS hosts (Workable, Dover, Rippling…), job
// aggregators, Greenhouse's short links, JOIN's boards, and YC's page of a company's jobs. A link
// there names a board, not a company.
const JOB_BOARDS = ["hiring.cafe", "wellfound.com", "workatastartup.com", "grnh.se", "join.com"];
const YC_COMPANY = /^https?:\/\/(?:www\.)?ycombinator\.com\/companies\//i;

// Hosts a post links through (videos, events, forms, docs, shorteners, site builders): a page
// there is someone's. Like a post host, the host itself is only its own company's domain.
const LINK_HOSTS = [
  "youtu.be",
  "vimeo.com",
  "loom.com",
  "tiktok.com",
  "facebook.com",
  "threads.net",
  "bsky.app",
  "t.me",
  "discord.gg",
  "discord.com",
  "lu.ma",
  "luma.com",
  "eventbrite.com",
  "meetup.com",
  "notion.site",
  "notion.so",
  "beehiiv.com",
  "ghost.io",
  "github.io",
  "gitlab.com",
  "huggingface.co",
  "arxiv.org",
  "producthunt.com",
  "typeform.com",
  "tally.so",
  "forms.gle",
  "airtable.com",
  "calendly.com",
  "linktr.ee",
  "bit.ly",
  "buff.ly",
  "ow.ly",
  "tinyurl.com",
  "vercel.app",
  "netlify.app",
  "framer.website",
  "webflow.io",
  "carrd.co",
  "apps.apple.com",
  "play.google.com",
];

const under = (host: string, list: string[]) => list.some((p) => host === p || host.endsWith(`.${p}`));
const parse = (s: string) => {
  try {
    return new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    return null;
  }
};
const hostOf = (u: URL | null) => u?.hostname.toLowerCase().replace(/^www\./, "") ?? "";

export const isPostHost = (host: string): boolean => under(host, POST_HOSTS);
export const isLinkHost = (host: string): boolean => under(host, LINK_HOSTS);

/** A job board's page or host. */
export function isJobBoard(url: string): boolean {
  const host = hostOf(parse(url));
  return under(host, JOB_BOARDS) || ATS_URL.test(host) || YC_COMPANY.test(url);
}

/** A link that names no company by its host: a post or a profile, a page on a link host, a job board's page. */
export const namesNoCompany = (url: string): boolean => {
  const host = hostOf(parse(url));
  return !host || isPostHost(host) || isLinkHost(host) || isJobBoard(url);
};

/**
 * The registrable domain a link or a domain can be a company's own, or null: never a job
 * board's, a page on a post or link host (foo.substack.com, medium.com/@x, x.github.io), or
 * LinkedIn's (it is never read). A post or link host itself (substack.com) only for the company
 * that runs it, which the caller proves.
 */
export function siteDomain(s: string): string | null {
  const u = parse(s.trim());
  const host = hostOf(u);
  if (!u || !host.includes(".") || isJobBoard(u.href) || under(host, ["linkedin.com", "lnkd.in"]))
    return null;
  if (isPostHost(host) || isLinkHost(host))
    return [...POST_HOSTS, ...LINK_HOSTS].includes(host) && u.pathname.length <= 1 ? registrable(host) : null;
  return registrable(host);
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|ref$|s$|t$|fbclid|gclid)/.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname
      .replace(/^www\./, "")
      .replace(/^mobile\./, "")
      .replace(/^twitter\.com$/, "x.com");
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

export function companyDomain(lead: Lead): string | null {
  for (const c of [lead.domain, lead.company_hint]) {
    if (!c) continue;
    try {
      return threadId(c);
    } catch {}
  }
  try {
    if (!namesNoCompany(lead.url)) return threadId(new URL(lead.url).hostname.replace(/^www\./, ""));
  } catch {}
  return null;
}

export type IntakeResult = SignalResult;

/** A lead that passed its source's filters becomes a signal. Sources never open threads. */
export function intakeLead(lead: Lead, now = new Date()): { result: IntakeResult; signalId?: number } {
  return recordSignal(lead, now);
}

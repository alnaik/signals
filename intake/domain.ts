// A company's domain, only with proof, recorded on the company (companies.domain_from): its own
// posts link or email it (post), its job board states it (board: an Ashby board names its
// website; Greenhouse, Lever and Workable name only the company), or its homepage names the
// company in its title or site name, its legal and descriptive trailing words aside (homepage).
// A web search only finds candidates: the model picks one (intake/search.ts), and the pick must
// pass the same check. A domain here is never a job board's, nor a page on a host where people
// post or link through (leads.ts siteDomain).
// Whose board or site is this: every such rule lives here (ownSite, offSite, prove, boardIsOthers,
// namesOther, slugNames); the name matching they share is classify.ts's sameName and nameShown.
import {
  bare,
  boardSlug,
  getPage,
  label,
  nameWords,
  registrable,
  sharesWord,
  squash,
} from "../ats/reader.ts";
import { unescapeHtml } from "../core/http.ts";
import { nameShown, sameName } from "./classify.ts";
import type { Company, DomainFrom, Signal } from "./companies.ts";
import { isDomainName, isPlaceholder, proven, signalsOf } from "./companies.ts";
import { siteDomain } from "./leads.ts";

export type Proof = { domain: string; from: DomainFrom };

const LINK = /https?:\/\/[^\s<>"'()[\]]+/gi;
// An address in a post, written plainly or spelled out ("anne [at] parablevc [.] com").
const DOT = /\s*(?:\[\.\]|\[dot\]|\(dot\))\s*/gi;
const EMAIL =
  /[\w.+-]+(?:@|\s*\[at\]\s*|\s*\(at\)\s*)([a-z0-9-]+(?:(?:\.|\s*(?:\[\.\]|\[dot\]|\(dot\))\s*)[a-z0-9-]+)+)/gi;
const links = (s: Pick<Signal, "url" | "text">) => [
  s.url,
  ...[...(s.text ?? "").matchAll(LINK)].map((m) => m[0].replace(/[.,;:!?]+$/, "")),
];

/** The domains a company's own posts link or email, in the order they appear. */
export function postDomains(signals: Pick<Signal, "url" | "text">[]): string[] {
  const out = new Set<string>();
  for (const s of signals) {
    const emails = [...(s.text ?? "").matchAll(EMAIL)].map((m) => m[1]!.replace(DOT, "."));
    for (const f of [...links(s), ...emails]) {
      const d = siteDomain(f);
      if (d) out.add(d);
    }
  }
  return [...out];
}

const ent = (s: string) => unescapeHtml(s).replace(/\s+/g, " ").trim();
const meta = (html: string, key: string) =>
  html.match(new RegExp(`<meta[^>]+property=["']${key}["'][^>]*content=["']([^"']*)`, "i"))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${key}["']`, "i"))?.[1] ??
  "";

/**
 * Does this page's own title or og:site_name name the company? The name is in it, or one of its
 * parts ("Home | That's No Moon", "Ambiq: Ultra-Low Power SoCs", "Tyk.io") is the company's name
 * once a company's trailing words are set aside on both sides (sameName: "That's No Moon
 * Entertainment", "Ambiq Micro, Inc.", "Tyk Technologies"), never a name inside another.
 */
const pageNames = (html: string, name: string) => {
  const title = ent(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const site = ent(meta(html, "og:site_name"));
  return (
    nameShown(name, `${title} ${site}`) ||
    [title, site].some((t) => t.split(/\s*[|·•»]\s*|\s+[-–—]\s+|:\s+/).some((part) => sameName(part, name)))
  );
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};
const onDomain = (url: string, domain: string) => {
  const h = hostOf(url);
  return h === domain || h.endsWith(`.${domain}`);
};

/**
 * Is this careers page the company's own? "own": on its proven domain (or a subdomain of it).
 * "second": on another of its sites (lifeatcanva.com for canva.com), which the page itself shows
 * by linking back to the proven domain and naming the company in its title or site name; many
 * companies share a short name, so the name alone isn't enough. null: neither, or no proven domain.
 */
export function ownSite(
  c: Pick<Company, "name" | "domain" | "domain_from">,
  page: { url: string; html: string; links: string[] },
): "own" | "second" | null {
  if (!proven(c)) return null;
  const d = c.domain!.toLowerCase();
  if (onDomain(page.url, d)) return "own";
  return page.links.some((l) => onDomain(l, d)) && pageNames(page.html, c.name) ? "second" : null;
}

/**
 * Is this page on a site that isn't the company's proven one (gliderfi.com for glider.fi)? A job
 * board, a page host (Notion, YC) and a subdomain's own site (epfl.ch for dlab.epfl.ch) aren't.
 */
export function offSite(c: Pick<Company, "domain" | "domain_from">, url: string): boolean {
  const site = siteDomain(url);
  return proven(c) && !!site && site !== c.domain && site !== registrable(c.domain!);
}

/**
 * Does this domain's homepage name the company (its title or og:site_name)? The domain it
 * proves is where the homepage ends up (polyphronbio.com → polyphron.com); null: it doesn't,
 * or it can't be read (robots.txt, a block, no page).
 */
export async function homepageNames(domain: string, name: string): Promise<string | null> {
  try {
    const page = await getPage(`https://${domain}/`, { accept: "text/html", maxBytes: 600_000 });
    if (!pageNames(page.text, name)) return null;
    // The plain read says where it was redirected to; a test's stand-in may not.
    return siteDomain((page as { url?: string }).url ?? domain);
  } catch {
    return null;
  }
}

// page: the company's own careers page when it has turned Ashby's hosted pages off (Cursor's
// jobs.ashbyhq.com/cursor answers 404, its roles show on cursor.com/careers), else null.
type Stated = { name: string; site: string | null; page: string | null };

// Each Ashby board is read once per process: discovery asks the same board from the site walk,
// the search and boardIsOthers. A read that failed is read again next time; a board that states
// nothing stays as read. Cleared when full.
const stated = new Map<string, Promise<Stated | null>>();
const STATED_MAX = 500;

// The embed view, not the hosted board: a company can turn the hosted pages off, and the embed
// view still answers and states the same organization. A board that's gone states none.
async function readBoard(slug: string): Promise<Stated | null> {
  const html = (await getPage(`https://jobs.ashbyhq.com/${slug}?embed=js`, { accept: "text/html" })).text;
  const at = html.indexOf('"organization":{');
  if (at < 0) return null;
  // The organization's own fields come before its theme, the first object inside it.
  const org = html.slice(at, at + 2000).split('"theme":')[0]!;
  const str = (key: string): string | null => {
    const m = org.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`));
    return m ? (JSON.parse(m[1]!) as string) : null;
  };
  const name = str("name");
  if (!name) return null;
  const site = str("publicWebsite");
  return { name, site: site ? siteDomain(site) : null, page: str("customJobsPageUrl") };
}

/**
 * What an Ashby board says of its company: its name, website and own careers page. Other boards
 * state nothing. `fresh`: read it again, not from this process's reads (the weekly check).
 */
export async function boardStates(url: string, o: { fresh?: boolean } = {}): Promise<Stated | null> {
  if (!/^https?:\/\/jobs\.ashbyhq\.com\//i.test(url)) return null;
  const slug = boardSlug(url);
  if (!slug) return null;
  let read = o.fresh ? undefined : stated.get(slug);
  if (!read) {
    if (stated.size >= STATED_MAX) stated.clear();
    const p = readBoard(slug);
    p.catch(() => {
      if (stated.get(slug) === p) stated.delete(slug);
    });
    stated.set(slug, p);
    read = p;
  }
  try {
    return await read;
  } catch {
    return null;
  }
}

/**
 * Has the company left its Lever board? Zuma's and VeeFriends' jobs.lever.co pages answer 404
 * while Lever's posting API still lists their old roles. True when the board's page answers 404,
 * false when it answers, null when the check failed. Other boards: null.
 */
export async function leverPageGone(url: string): Promise<boolean | null> {
  if (!/^https?:\/\/jobs\.lever\.co\//i.test(url)) return null;
  // The account as the link writes it: Lever's pages are case-sensitive (jobs.lever.co/Grid
  // answers, /grid is 404), and some accounts end in an encoded space (Xpansiv%20).
  const account = boardSlug(url) ? new URL(url).pathname.split("/")[1] : null;
  if (!account) return null;
  try {
    await getPage(`https://jobs.lever.co/${account}`, { accept: "text/html", maxBytes: 50_000 });
    return false;
  } catch (err) {
    return (err as { status?: number }).status === 404 ? true : null;
  }
}

/**
 * Is this domain the company's? Its posts link or email it, or its homepage names it. `posts`:
 * the domains its posts gave, when the caller has them.
 */
export async function prove(c: Company, domain: string, posts?: string[]): Promise<Proof | null> {
  const d = siteDomain(domain);
  if (!d) return null;
  if ((posts ?? postDomains(signalsOf(c.id, 20))).includes(d)) return { domain: d, from: "post" };
  const named = await homepageNames(d, c.name);
  return named ? { domain: named, from: "homepage" } : null;
}

/**
 * The free proofs, for a company with no domain: a domain its posts give whose homepage names
 * it, else an Ashby board its posts link that names it and states its website.
 */
export async function domainFromPosts(c: Company): Promise<Proof | null> {
  const signals = signalsOf(c.id, 20);
  for (const d of postDomains(signals).slice(0, 3)) {
    const named = await homepageNames(d, c.name);
    if (named) return { domain: named, from: "homepage" };
  }
  const boards = new Set(signals.flatMap(links).filter((u) => /^https?:\/\/jobs\.ashbyhq\.com\//i.test(u)));
  for (const b of [...boards].slice(0, 2)) {
    const said = await boardStates(b);
    if (said?.site && nameShown(c.name, said.name)) return { domain: said.site, from: "board" };
  }
  return null;
}

type Get = (url: string, o: { accept: string }) => Promise<{ text: string }>;

/**
 * The company's name as its board's own API or page gives it: Greenhouse's board API, Lever's
 * board page title, Ashby's board, Workable's account. SmartRecruiters names it on the posting
 * (its API is closed to robots). Workday names only a payroll entity, and its site no company.
 */
export async function boardName(url: string, get: Get = getPage): Promise<string | null> {
  const host = new URL(url).hostname;
  const slug = boardSlug(url);
  if (!slug) return null;
  const json = async (u: string) => JSON.parse((await get(u, { accept: "application/json" })).text);
  let name: unknown = null;
  try {
    if (/greenhouse\.io$/i.test(host))
      name = (await json(`https://boards-api.greenhouse.io/v1/boards/${slug}`)).name;
    else if (host === "jobs.lever.co")
      name = (await get(`https://jobs.lever.co/${slug}`, { accept: "text/html" })).text.match(
        /<title>([^<]*)<\/title>/i,
      )?.[1];
    else if (host === "jobs.ashbyhq.com") name = (await boardStates(url))?.name;
    else if (host === "apply.workable.com")
      name = (await json(`https://apply.workable.com/api/v1/widget/accounts/${slug}`)).name;
  } catch {
    return null;
  }
  const n = typeof name === "string" ? unescapeHtml(name).trim() : "";
  return n && !isPlaceholder(n) ? n : null;
}

/** A board slug that is the company's name: "lockheedmartin" for Lockheed Martin, "stratom" for "Stratom, Inc.". */
export function slugNames(name: string, slug: string | null): boolean {
  const want = bare(name);
  if (!slug || want.length < 3) return false;
  const s = squash(slug)
    .replace(/\d+$/, "")
    .replace(/(?:careers?|jobs|inc|hq)$/, "");
  return s === want;
}

/**
 * Is the name a board states clearly another company's? Only when nothing ties the two: not the
 * same name, neither inside the other, no word shared, no word of the company's domain, not its
 * initials (AISI is the AI Security Institute, Ai2 the Allen Institute, x.ai's board "SpaceXSI").
 * A company named by its domain is never refused. Measured on 205 named boards: it refuses the
 * 6 a fund's portfolio page or a lookup gave the wrong company (a16z's was Box's), and no other.
 */
export function namesOther(stated: string, name: string, domain: string | null): boolean {
  if (isDomainName(name) || !nameWords(stated).length) return false;
  if (sameName(stated, name)) return false;
  const [x, y] = [bare(stated), bare(name)];
  if (x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x))) return false;
  if (nameWords(name).length && sharesWord(name, stated)) return false;
  if (domain && sharesWord(stated, label(domain))) return false;
  const initials = stated
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(the|of|for|and)$/i.test(w))
    .map((w) => (w.length <= 2 ? w : w[0]))
    .join("")
    .toLowerCase();
  return !(y.length >= 2 && initials.startsWith(y));
}

/** Does this domain's homepage end up on that one's site? One plain read; false when it can't be read. */
async function redirectsTo(from: string, to: string): Promise<boolean> {
  try {
    const page = await getPage(`https://${from}/`, { accept: "text/html", maxBytes: 50_000 });
    return siteDomain((page as { url?: string }).url ?? from) === registrable(to);
  } catch {
    return false;
  }
}

/**
 * Whose a board is, when it isn't this company's: the other website it states (Parable's pick,
 * askparable.com's board) or the other company it names (a16z's site linked Box's), else null.
 * A board that states our website is ours whatever it calls itself (Westmag's is "Western
 * Magnetics Company"), and so is one whose website redirects to ours or ours to it
 * (cruxclimate.com → crux.com); ours is checked only when it isn't looked up, which may be a
 * namesake's. A name alone never outweighs the site (Parable).
 * `stated`: the board's name when the caller already has it (the boards table).
 */
export async function boardIsOthers(
  url: string,
  c: Pick<Company, "name" | "domain"> & Partial<Pick<Company, "domain_from">>,
  stated?: string | null,
): Promise<string | null> {
  const said = await boardStates(url);
  if (said?.site && c.domain) {
    if (registrable(said.site) === registrable(c.domain)) return null;
    if (await redirectsTo(said.site, c.domain)) return null;
    if (c.domain_from !== "looked up" && (await redirectsTo(c.domain, said.site))) return null;
    return said.site;
  }
  const name = stated ?? said?.name ?? (await boardName(url));
  return name && namesOther(name, c.name, c.domain) ? name : null;
}

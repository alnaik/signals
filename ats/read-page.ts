// The small model reads a careers page no reader here reads (intake/pages.ts). Haiku, on either
// model connection, gets the page's visible text and its links and names the roles on it,
// the employer they are at, or the job board the page sends people to. Only what the page shows is
// kept: a role's title word for word in the page's text (case aside: CSS capitalizes), its link one of the page's links, a
// mailto, or the page itself. A page that lists several employers' roles, or another company's
// (a job marketplace: Gamms), gives none; on the company's own site its one employer is the company. Measured 2026-10-30 on 17 careers pages no reader read:
// right on the 10 that list roles, and wrong only on Gamms, which the employer check now drops.
// Its spend has its own monthly cap ([caps] pages_month_usd) and counts toward month_usd too.
import { createHash } from "node:crypto";
import { loadConfig } from "../core/config.ts";
import { htmlToText } from "../core/http.ts";
import { entries, monthStart } from "../core/ledger.ts";
import { canUseSmallModel, smallJson } from "../core/model.ts";
import { type Job, label, nameWords, registrable, sharesWord, squash } from "./reader.ts";
import type { Link } from "./render.ts";

export const STATION = "read-page";
const TEXT_CHARS = 40_000;
const LINKS = 400;

export type PageText = { url: string; text: string; links: Link[] };
/** listing: the page on its own site that lists all the roles this one only points to. */
export type PageRead = { jobs: Job[]; board: string | null; listing: string | null; note: string };
type Answer = {
  roles: { title: string; url: string }[];
  employers: string[];
  board: string;
  listing?: string;
  note: string;
};

/** Is the page more than the model reads whole (its text, or its links)? */
export const tooBig = (page: PageText) => page.text.length > TEXT_CHARS || page.links.length > LINKS;

const SYSTEM = `You read one company's careers page and list the open roles on it.

You get the company's name and site, the page's address, the page's visible text, and its links as "text -> url".

A role is a job this company is hiring for now that a person could apply to. Not a role:
- navigation, departments, teams, locations, benefits, values, blog posts or people's profiles;
- a general or open application ("Don't see your role?");
- jobs at other companies (a job board or marketplace listing many employers' jobs);
- a heading like "Open roles" or "We're hiring" with no role named under it.

For each role give its title as the page shows it, and its url: the role's own link when the page has one, else a mailto link for it, else the page's address. Give each role once, even when it is listed for several locations.

employers: the companies the listed roles are at, as the page names them. A job board or marketplace listing many employers' jobs names them all; a company's own careers page names that company once. [] when there are no roles.

board: when the page sends people elsewhere for the roles (a link to a job board such as Y Combinator, an ATS like Greenhouse, Ashby, Lever, Workable, Homerun, PeopleForce, Dayforce, Polymer), that link; else "".
listing: when the page lists no roles, or only a few featured ones, and links to the page on this same site that lists all the open roles ("See open jobs", "View open roles", "Full-time positions", "Search all jobs"), that link; else "".
If the page lists no roles, roles is [] and say why in note (e.g. "page not found", "roles are on the linked board", "no openings listed").`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["roles", "employers", "board", "listing", "note"],
  properties: {
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: { title: { type: "string" }, url: { type: "string" } },
      },
    },
    employers: { type: "array", items: { type: "string" } },
    board: { type: "string" },
    listing: { type: "string" },
    note: { type: "string" },
  },
};

const NAMED: Record<string, string> = {
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};
// The characters htmlToText leaves as entities: numbered ones, and dashes and quotes by name.
const entities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const toText = (html: string) => entities(htmlToText(html));

/** A page's visible text and links from its plain HTML, as a render gives them. */
export function plainText(html: string, url: string): PageText {
  const body = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ");
  const links: Link[] = [];
  for (const m of body.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const href = new URL(m[1]!.replace(/&amp;/g, "&"), url).href;
      links.push({ href, text: toText(m[2]!).replace(/\s+/g, " ").slice(0, 160) });
    } catch {}
  }
  return { url, text: toText(body), links };
}

/** What the text of a page says, however it is spaced: the same hash means the model needn't read it again. */
export const textHash = (text: string) =>
  createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

/** This month's spend on page reads. */
export function pagesSpent(now = new Date()): number {
  const since = monthStart(now).toISOString();
  return entries()
    .filter((e) => e.station === STATION && e.ts >= since)
    .reduce((sum, e) => sum + e.usd, 0);
}

/** May the model read a page now: a model connected, and room in this month's page cap. */
export function canReadPages(now = new Date()): boolean {
  return canUseSmallModel() && pagesSpent(now) + 0.01 <= Number(loadConfig().caps.pages_month_usd) + 1e-9;
}

// Word for word, but not by its case, dashes, quotes or spacing.
const norm = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const same = (s: string) => norm(s).toLowerCase();
const bareUrl = (u: string) => u.replace(/\/(?=$|[?#])/, "").replace(/\/$/, "");

/** Does the page show this role: its title in the text, its url one of its links, a mailto, or the page? */
function shown(page: PageText): (title: string, url: string) => boolean {
  const text = same(page.text);
  const hrefs = new Set(page.links.map((l) => bareUrl(l.href)));
  const mail = (u: string) =>
    u
      .replace(/^mailto:/i, "")
      .split("?")[0]!
      .toLowerCase();
  const mails = new Set(page.links.filter((l) => /^mailto:/i.test(l.href)).map((l) => mail(l.href)));
  return (title, url) => {
    if (!same(title) || !text.includes(same(title))) return false;
    if (/^mailto:/i.test(url)) return mails.has(mail(url)) || text.toLowerCase().includes(mail(url));
    return hrefs.has(bareUrl(url)) || bareUrl(url) === bareUrl(page.url);
  };
}

/** Does this page show every one of these roles (the plain page, against what the render gave)? */
export const showsAll = (jobs: Pick<Job, "title" | "url">[], page: PageText) => {
  const ok = shown(page);
  return jobs.every((j) => ok(j.title, j.url));
};

/**
 * Is this employer the company: a word of its name or its domain? The page's own site doesn't
 * count (T:0 took Airwallex's careers page by it): on the company's own sites `own` decides.
 */
function ours(company: { name: string; domain: string | null }, employer: string): boolean {
  const mine = [company.name, company.domain ? label(company.domain) : ""].filter(Boolean);
  return mine.some(
    (m) =>
      squash(m) === squash(employer) ||
      (nameWords(m).length > 0 && sharesWord(m, employer)) ||
      (nameWords(employer).length > 0 && sharesWord(employer, m)),
  );
}

/**
 * The model's answer, kept where the page shows it. `own`: the page is on the company's proven
 * domain or its second site (intake/domain.ts ownSite), so the one employer it names is the
 * company, whatever the model calls it (Cal.com's "Foundation", a team); a page naming several
 * employers is still a list of others' jobs (Deep-ML's Apple and Google DeepMind roles).
 */
export function keep(
  a: Answer,
  company: { name: string; domain: string | null },
  page: PageText,
  own = false,
): PageRead {
  const linked = (u: string | undefined) => !!u && page.links.some((l) => bareUrl(l.href) === bareUrl(u));
  const boardShown = linked(a.board) ? a.board : null;
  // One of its links, on its own site, and not the page itself.
  const host = (u: string) => registrable(new URL(u).hostname);
  const listing =
    linked(a.listing) && host(a.listing!) === host(page.url) && bareUrl(a.listing!) !== bareUrl(page.url)
      ? a.listing!
      : null;
  const employers = [...new Set((a.employers ?? []).map((e) => e.trim()).filter(Boolean))];
  const mine = own ? employers.length <= 1 : employers.length === 1 && ours(company, employers[0]!);
  if (a.roles.length && !mine)
    return {
      jobs: [],
      board: boardShown,
      listing: null,
      note: `its roles aren't ${company.name}'s: ${employers.join(", ").slice(0, 80) || "no employer named"}`,
    };
  const ok = shown(page);
  const roles = a.roles.filter((r) => ok(r.title, r.url));
  const seen = new Set<string>();
  const unique = roles.filter((r) => {
    const k = `${same(r.title)} ${bareUrl(r.url)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // A role's link is its id; one link shared by several roles (the page itself, a mailto) isn't.
  const count = new Map<string, number>();
  for (const r of unique) count.set(r.url, (count.get(r.url) ?? 0) + 1);
  const jobs = unique.map((r) => ({
    id:
      count.get(r.url) === 1 && bareUrl(r.url) !== bareUrl(page.url) ? r.url : `${r.url}#${squash(r.title)}`,
    title: norm(r.title),
    url: r.url,
    location: "",
    postedAt: null,
  }));
  const dropped = a.roles.length - roles.length;
  return {
    jobs,
    board: boardShown,
    listing,
    note: [a.note, dropped ? `${dropped} not shown on the page` : ""]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200),
  };
}

/**
 * The model's read of one page (`own`: as keep; `board`: the board it is read for, on its ledger
 * line). Throws when it can't run (no key, a cap, an API error).
 */
export async function readPage(
  company: { name: string; domain: string | null },
  page: PageText,
  own = false,
  board?: number,
): Promise<PageRead> {
  const seen = new Set<string>();
  const links = page.links
    .filter(
      (l) => !/^javascript:/i.test(l.href) && !/\.(css|png|jpe?g|svg|webp|woff2?|ico)(\?|$)/i.test(l.href),
    )
    .filter((l) => {
      const k = `${l.text}|${l.href}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, LINKS)
    .map((l) => `${l.text || "(no text)"} -> ${l.href}`)
    .join("\n");
  const user = `Company: ${company.name}${company.domain ? ` (${company.domain})` : ""}\nPage: ${page.url}\n\n<text>\n${page.text.slice(0, TEXT_CHARS)}\n</text>\n\n<links>\n${links}\n</links>`;
  const a = await smallJson<Answer>({
    station: STATION,
    system: SYSTEM,
    user,
    schema: SCHEMA,
    maxTokens: 8000,
    board,
  });
  return keep(a, company, page, own);
}

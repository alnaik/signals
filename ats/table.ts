// `jobsignal boards export [file]`: the boards table (ats/boards.csv, shipped with the app) written
// from an install's own boards: every board that reads, with its company's name and website
// (a job board's only when its domain was proven). Nothing else: no dates, no counts, nothing about how the install
// came by the company or what its person did with it. The database is opened read-only.
// Matching a company against the table is reader.ts (fromTable, tableCareersPage).
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { dbFile } from "../core/db.ts";
import { isPlaceholder } from "../intake/companies.ts";
// @ts-expect-error plain JS module
import { careersPage } from "./links.mjs";
import { boardKey, registrable, TABLE_FILE, type TableRow } from "./reader.ts";

// A link's parameters that only say where a click came from: dropped.
const TRACKING = /^(utm_\w+|gh_src|source|ref|rdrfrom|nc2|gclid|fbclid)$/i;
// Parameters that may carry a key or a person: a link with one is left out.
const PRIVATE =
  /^(token|access_token|api_?key|key|auth|sig|signature|session|sid|code|password|email|user)$/i;
// A jobs feed's address (…/jobs.rss, …/feed.xml, …?rss=true).
const FEED = /\.(rss|xml|atom)$|\/(feed|rss)\/?$|[?&]rss=/i;
// A link to one posting (…/job/2577499, …/jobs/5508/a-title/job), not to a board.
const POSTING = /\/jobs?\/\d+(\/|$)/i;
// A careers page's own parts: a page under one of these, or on a careers. or jobs. host, whose
// last part is a posting id or a title (/careers/head-of-sales) is one posting.
const CAREERS_PART = /^(careers?|jobs?|join-us|openings|positions|vacancies)$/i;
const POSTING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,}(-.*)?)$/i;
// Words a listing's address uses (/careers/open-roles, /jobs/search, OpenRoles, index.html);
// a last part with none of them is a title.
const LISTING_WORD =
  /^(all|careers?|current|en|explore|externaljobs|feed|find|html?|index|jobs?|join|listings?|open|openings?|opportunit(y|ies)|positions?|roles?|rss|search|teams?|us|vacanc(y|ies)|xml)$/;
const LOCALE = /^[a-z]{2}([-_][a-z]{2})?$/i;
// Encoded spaces or control characters at either end of a link's part (jobs.lever.co/Xpansiv%20),
// or anywhere in a name, or a link written into a name ("Baserow ( https://baserow.io )").
const BAD_NAME = /\p{Cc}|%[0-9a-f]{2}|:\/\/|\bwww\./iu;
const BAD_PART = /^\s|\s$|\p{Cc}/u;
// Hosts on the open internet only: no address, no local or private name.
const PUBLIC_HOST =
  /^(?!localhost$)(?!.*\.(local|internal|lan|test|localhost|home|corp)$)([a-z0-9-]+\.)+[a-z]{2,}$/;

export type Exported = { rows: number; byProvider: Record<string, number>; left: Record<string, number> };

/** A careers page's link that is one posting under it (elevenlabs.io/careers/<id>/<title>). */
function onePosting(u: URL): boolean {
  const parts = u.pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  if (!last || LOCALE.test(last)) return false;
  const under = parts.slice(0, -1).some((p) => CAREERS_PART.test(p)) || /^(careers|jobs)\./i.test(u.hostname);
  if (!under) return false;
  if (POSTING_ID.test(last)) return true;
  const words = last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return !words.some((w) => LISTING_WORD.test(w));
}

/**
 * The listing a one-posting link sits under: its path up to the last careers part
 * (gauntletai.com/careers/storyteller → gauntletai.com/careers), else the host's front page
 * (careers.quartr.com/jobs/… keeps /jobs; jobs.clanx.ai/o/… is jobs.clanx.ai).
 */
export function listingOf(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const at = parts.findLastIndex((p) => CAREERS_PART.test(p));
  return `${u.origin}/${parts.slice(0, at + 1).join("/")}`;
}

/** A link part with spaces at its ends or a control character in it, once decoded. */
function badParts(u: URL): boolean {
  return u.pathname.split("/").some((p) => {
    try {
      return BAD_PART.test(decodeURIComponent(p));
    } catch {
      return true;
    }
  });
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A board link as the table keeps it, or why it's left out. */
function cleanLink(raw: string): { url: string } | { why: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { why: "not a link" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { why: "not a web link" };
  if (u.username || u.password) return { why: "a link with a login in it" };
  if (!PUBLIC_HOST.test(u.hostname.toLowerCase())) return { why: "not a public host" };
  for (const k of [...u.searchParams.keys()]) {
    if (PRIVATE.test(k)) return { why: "a link with a key or token in it" };
    if (TRACKING.test(k)) u.searchParams.delete(k);
  }
  u.protocol = "https:";
  u.hash = "";
  return { url: u.href };
}

export type BoardRow = {
  name: string;
  domain: string | null;
  domain_from: string | null;
  provider: string;
  url: string;
  key: string;
};

/** One board as the table keeps it, or why it's left out (the repair of boards reads this too). */
export function tableRow(b: BoardRow): { row: TableRow } | { why: string } {
  const name = b.name.replace(/\s+/g, " ").trim();
  if (!name || isPlaceholder(name)) return { why: "no company name" };
  if (BAD_NAME.test(name)) return { why: "a name with a link or a stray character in it" };
  if (b.provider === "yc") return { why: "Y Combinator's page for the company, not its own board" };
  const link = cleanLink(b.url);
  if ("why" in link) return { why: link.why };
  // Stripping a click's parameters never changes which board it is.
  if (b.provider !== "careers-page" && boardKey(b.provider, link.url) !== b.key)
    return { why: "its link names another board once cleaned" };
  const domain = b.domain?.toLowerCase() ?? "";
  // A careers page is the website's own page: offered only to a company with that website, it
  // says nothing about whose the website is, so any website the install had will do. A job
  // board's website is proof of whose it is (fromTable): only one the install proved, since a
  // looked-up one can be a namesake's.
  const page = b.provider === "careers-page";
  const website = page || b.domain_from !== "looked up" ? domain : "";
  if (page && (!website || registrable(new URL(link.url).hostname) !== registrable(website)))
    return { why: "careers page off its company's website" };
  // One posting's link says a company's site linked a job, not whose board it is: an investor's
  // site linking a portfolio company's posting, a job ad read as a company ("Cologne, Germany").
  if (badParts(new URL(link.url))) return { why: "a link with a stray space or character in it" };
  if (POSTING.test(new URL(link.url).pathname) || (page && onePosting(new URL(link.url))))
    return { why: "a link to one posting, not a board" };
  // A board that states its company's website (Eightfold's ?domain=) and states another one is
  // someone else's board (Amdocs held one for volkscience.com).
  const stated = new URL(link.url).searchParams.get("domain");
  if (website && stated && registrable(stated) !== registrable(website))
    return { why: "its board states another website" };
  // A jobs feed is found from the careers page that names it, as discovery found it: the page.
  const url = page && FEED.test(link.url) ? careersPage(new URL("./", link.url).href) : link.url;
  if (!url) return { why: "a jobs feed with no careers page above it" };
  return { row: { name, website, provider: b.provider, url } };
}

/**
 * Write the table from the database at `from` (an install's jobsignal.db) to `to`: every board
 * that reads (status ok) whose company has a name. Left out, and counted: Y Combinator's pages
 * (YC's page for the company, not the company's own board), links with a key or token, hosts
 * that aren't public, a name with a link or a stray character in it, a link with a stray space in
 * it, a link to one posting (or a careers page's link to one), a board that states another website than its
 * company's, a careers page off its company's website. Sorted by name,
 * then provider and link, so a rebuild's diff shows only what changed.
 */
export function exportBoards(from = dbFile(), to = TABLE_FILE): Exported {
  const db = new Database(from, { readonly: true });
  let found: BoardRow[];
  try {
    found = db
      .query(
        `SELECT c.name, c.domain, c.domain_from, b.provider, b.url, b.key FROM boards b
         JOIN companies c ON c.id = b.company_id WHERE b.status = 'ok'`,
      )
      .all() as typeof found;
  } finally {
    db.close();
  }
  const left: Record<string, number> = {};
  const leave = (why: string) => {
    left[why] = (left[why] ?? 0) + 1;
  };
  const out: TableRow[] = [];
  const seen = new Set<string>();
  for (const b of found) {
    const r = tableRow(b);
    if ("why" in r) {
      leave(r.why);
      continue;
    }
    const { url } = r.row;
    if (seen.has(url)) {
      leave("the same link twice");
      continue;
    }
    seen.add(url);
    out.push(r.row);
  }
  const order = (r: TableRow) => [r.name.toLowerCase(), r.provider, r.url];
  out.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    return 0;
  });
  const lines = [
    "name,website,provider,url",
    ...out.map((r) => [r.name, r.website, r.provider, r.url].map(csvCell).join(",")),
  ];
  writeFileSync(to, `${lines.join("\n")}\n`);
  const byProvider: Record<string, number> = {};
  for (const r of out) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
  return { rows: out.length, byProvider, left };
}

// Reading a careers page that discovery found but no reader here reads from its plain HTML (its
// company is "unreadable"). Cheapest first, stopping at the first that works: the page rendered
// (ats/render.ts) and a job board in its links, frames, requests or markup read by its provider;
// else the small model reads the rendered page (ats/read-page.ts). robots.txt refusing the page,
// or the board it names, leaves the company "blocked"; a page that is gone (404, 410) sends it back
// to discovery for a fresh find (its site, then a fresh careers search); a page with no roles is
// "none", checked. A page on a site other than the company's proven domain is read only when it
// links back to that domain and names the company (its second site: domain.ts ownSite); else
// it is another company's, and "none". A page whose roles the
// model read becomes the company's board, read from its plain HTML from then on when that shows
// the same roles, else rendered (refresh.ts). While the model can't run (no model connected, past its
// cap) the step waits and nothing is read: a page is never retried in a loop.

import {
  canReadPages,
  type PageText,
  plainText,
  readPage,
  showsAll,
  textHash,
  tooBig,
} from "../ats/read-page.ts";
import {
  boardSlug,
  getPage,
  type Job,
  label,
  leftAtDeadline,
  pastDeadline,
  runBoards,
  sharesWord,
} from "../ats/reader.ts";
import { type Renderer, renderer } from "../ats/render.ts";
import { loadConfig } from "../core/config.ts";
import { open } from "../core/db.ts";
import { robotsAllowed } from "../core/http.ts";
import { NoModelKey, OverCap } from "../core/model.ts";
import { failure } from "../core/trace.ts";
import { type Company, signalsOf } from "./companies.ts";
import { addBoard, type Found } from "./discover.ts";
import { boardIsOthers, offSite, ownSite, slugNames } from "./domain.ts";
import { applyRead, type Board, OLD_EVERY_HOURS } from "./refresh.ts";
import { listsTitle, roleTitles, searchConfig } from "./search.ts";

export const PAGES_BATCH = 2; // companies a pass of the step takes

type Outcome =
  | { kind: "board"; provider: string; url: string; how: string }
  | { kind: "roles"; url: string; jobs: Job[]; render: boolean; hash: string; how: string }
  | { kind: "blocked" | "gone" | "none"; how: string };

/** Companies whose careers page waits to be read: newest signal first, dismissed ones never. */
export function pagesDue(limit = PAGES_BATCH): Company[] {
  return open()
    .query(
      `SELECT * FROM companies
       WHERE discovery = 'unreadable' AND careers_url IS NOT NULL
         AND (watched_at IS NOT NULL OR dismissed_at IS NULL)
       ORDER BY last_signal_at DESC LIMIT ?`,
    )
    .all(limit) as Company[];
}

const status = (err: unknown) => (err as { status?: number })?.status;
const gone = (s: number | null | undefined) => s === 404 || s === 410;

/**
 * A board the page names (a link, a frame, a request, its markup), read by its provider. A board
 * the page only links to must list a role the company's signals named, when they named one.
 */
async function boardOn(c: Company, page: { url: string; links: string[]; html?: string }) {
  const site = c.domain ?? new URL(page.url).hostname.replace(/^www\./, "");
  const ms = searchConfig().companyMs;
  const [r] = await runBoards("detect", [
    {
      domain: String(c.id),
      name: c.name,
      site,
      links: page.links,
      page: page.url,
      html: page.html,
      deadlineMs: ms,
    },
  ]);
  const d = r?.detect as { provider?: string; careers_url?: string; method?: string } | undefined;
  if (!d?.provider || !d.careers_url) return null;
  // A board that names another company (USV's portfolio page loads its companies' boards).
  if (await boardIsOthers(d.careers_url, c).catch(() => null)) return null;
  const titles = roleTitles(signalsOf(c.id, 50));
  if (titles.length) {
    const key = String(c.id);
    const got = (
      await listsTitle([{ key, provider: d.provider, url: d.careers_url, name: c.name, titles }], ms)
    ).get(key);
    if (got !== "title" && !(got === "near" && slugNames(c.name, boardSlug(d.careers_url)))) return null;
  }
  return { provider: d.provider, url: d.careers_url };
}

/**
 * One company's careers page, read; null when the model is needed and can't run, or discovery's
 * deadline passed before the read was whole (no model call is started past it). A front page
 * that shows no roles, or a featured few, and links to its full listing on the same site
 * (Databricks' "See open jobs", Meta's one featured role) has that one page read too, by the same
 * steps, and the listing's board or roles are kept when they are more: its address is saved, so
 * a refresh reads the listing itself.
 */
export async function readCareers(
  c: Company,
  r: Renderer,
  now = new Date(),
  url = c.careers_url!,
): Promise<Outcome | null> {
  const listing = url !== c.careers_url;
  let plain: PageText | null = null;
  try {
    const p = await getPage(url, { accept: "text/html" });
    plain = plainText(p.text, url);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/robots\.txt disallows/.test(msg)) return { kind: "blocked", how: `its careers page: ${msg}` };
    if (gone(status(err))) return { kind: "gone", how: `its careers page is gone (HTTP ${status(err)})` };
    // Refused or slow plain (a WAF's 403, a timeout): the browser may still get it.
  }
  const page = await r.render(url).catch((err: Error) => err);
  if (page instanceof Error)
    return { kind: "none", how: `its careers page didn't load: ${page.message.slice(0, 120)}` };
  if (page.blocked) return { kind: "blocked", how: `robots.txt disallows ${page.blocked}` };
  if (gone(page.status)) return { kind: "gone", how: `its careers page is gone (HTTP ${page.status})` };
  // A page on another site counts only when it shows it is the company's second site.
  const site = ownSite(c, { url: page.url, html: page.html, links: page.links.map((l) => l.href) });
  if (!site && offSite(c, page.url))
    return {
      kind: "none",
      how: `its careers page ${page.url} is another site's: it doesn't link ${c.domain} and name ${c.name}`,
    };
  // a. A job board the rendered page names: itself, a frame, a request, its markup; a link only
  // when it bears the company's name (a marketplace links other employers' boards).
  const named = (u: string) => [c.name, c.domain ? label(c.domain) : ""].some((n) => n && sharesWord(n, u));
  const links = [page.url, ...page.frames, ...page.requests, ...page.links.map((l) => l.href).filter(named)];
  const board = await boardOn(c, { url: page.url, links, html: page.html });
  if (board) return { kind: "board", ...board, how: `its careers page, rendered, runs ${board.provider}` };
  // c. The model reads the rendered page; a listing only when it reads it whole (Databricks' 908
  // roles are past what it reads and writes back). Past discovery's deadline it isn't asked: the
  // board check above may have been cut short, and the answer would come after the step.
  if (!canReadPages(now) || pastDeadline()) return null;
  if (listing && tooBig(page))
    return { kind: "none", how: `its listing ${page.url} is longer than the model reads whole` };
  // On its own site (or its second site), the employer the page names is the company.
  const read = await readPage({ name: c.name, domain: c.domain }, page, site !== null);
  if (read.listing && !read.board && !listing) {
    const more = await readCareers(c, r, now, read.listing).catch((err) => {
      if (err instanceof NoModelKey || err instanceof OverCap) throw err;
      failure("discover", `careers listing ${read.listing}`, err);
      return null;
    });
    // The listing's read cut by the deadline: the front page's alone isn't what a whole read gives.
    if (!more && pastDeadline()) return null;
    if (more?.kind === "board" || (more?.kind === "roles" && more.jobs.length > read.jobs.length))
      return more;
  }
  if (read.jobs.length) {
    // Read plain from now on when the plain page shows every role the render did.
    const same = !!plain && showsAll(read.jobs, plain);
    return {
      kind: "roles",
      url,
      jobs: read.jobs,
      render: !same,
      hash: textHash(same ? plain!.text : page.text),
      how: `its careers page lists its roles (read by the model${same ? "" : ", rendered"})`,
    };
  }
  if (read.board) {
    const sent = await boardOn(c, { url: page.url, links: [read.board] });
    // Its board check cut by the deadline: not known to be unread.
    if (!sent && pastDeadline()) return null;
    if (sent) return { kind: "board", ...sent, how: `its careers page sends people to ${sent.provider}` };
    if (!(await robotsAllowed(read.board).catch(() => true)))
      return { kind: "blocked", how: `its roles are on ${read.board}, whose robots.txt refuses readers` };
    return { kind: "none", how: `its roles are on ${read.board}, which no reader here reads` };
  }
  return { kind: "none", how: `its careers page, checked: ${read.note || "no roles listed"}`.slice(0, 200) };
}

/** What a read found, written to the company. */
function write(c: Company, o: Outcome, now: Date): Found {
  const d = open();
  const iso = now.toISOString();
  if (o.kind === "board") {
    const added = addBoard(c.id, o.provider, o.url, "rendered page", now);
    // Another company's board: nothing more is written, and addBoard's note says whose.
    if (!added.board) return { companyId: c.id, how: added.refused };
    d.query("UPDATE companies SET discovery_note = ? WHERE id = ?").run(o.how, added.companyId);
    return { companyId: added.companyId, board: added.board.url, provider: o.provider, how: o.how };
  }
  if (o.kind === "roles") {
    const added = addBoard(c.id, "careers-page", o.url, "careers page, read by the model", now);
    // A careers page is one board a host: one another company has there (two companies on one
    // page host) isn't this one's, and these roles are never written onto it.
    if (!added.board) return { companyId: c.id, how: added.refused };
    d.query("UPDATE boards SET render = ?, text_hash = ?, model_at = ? WHERE id = ?").run(
      o.render ? 1 : 0,
      o.hash,
      iso,
      added.board.id,
    );
    // A careers page is one board a host: its own board read from the page read now (the
    // listing, not the front page Meta's board had), so a refresh reads what the model read.
    d.query("UPDATE boards SET url = ? WHERE id = ?").run(o.url, added.board.id);
    // Its full listing, when the careers page was a front page: read from now on.
    d.query("UPDATE companies SET discovery_note = ?, careers_url = ? WHERE id = ?").run(
      o.how,
      o.url,
      added.companyId,
    );
    const board = d.query("SELECT * FROM boards WHERE id = ?").get(added.board.id) as Board;
    // Its first read; the model reads it again once a day at most, so it is read daily.
    applyRead(board, { ok: true, jobs: o.jobs }, now, { hours: OLD_EVERY_HOURS });
    return { companyId: added.companyId, board: board.url, provider: "careers-page", how: o.how };
  }
  if (o.kind === "gone") {
    // Its site, then a fresh careers search: the kept results named the page that is gone, and a
    // pick that is gone again is none (search.ts), so this never loops.
    d.query(
      "UPDATE companies SET discovery = 'queued', discovery_at = ?, discovery_note = ?, careers_url = NULL, search_at = NULL WHERE id = ?",
    ).run(iso, `${o.how}: looking again`, c.id);
    if (c.domain) d.query("DELETE FROM web_searches WHERE query = ?").run(`${c.domain} careers`);
  }
  // Its careers page was read and gives nothing: the careers search, which would find that page
  // again, isn't made (a page found by the search was searched already).
  else
    d.query(
      "UPDATE companies SET discovery = ?, discovery_at = ?, discovery_note = ?, search_at = coalesce(search_at, ?) WHERE id = ?",
    ).run(o.kind, iso, o.how.slice(0, 200), iso, c.id);
  return { companyId: c.id, how: o.how };
}

/**
 * Read these companies' careers pages, one at a time in one browser. Stops while the model can't
 * run, and at discovery's deadline: none is started past it, and one going then is written when it
 * finishes whole (what the model read is kept), else stays "unreadable" for the next tick.
 */
export async function readPages(companies: Company[], now = new Date()): Promise<Found[]> {
  const out: Found[] = [];
  if (!companies.length || !canReadPages(now)) return out;
  const r = await renderer(loadConfig().polling.user_agent);
  try {
    for (const c of companies) {
      if (pastDeadline()) break;
      let o: Outcome | null;
      try {
        o = await readCareers(c, r, now);
      } catch (err) {
        if (err instanceof NoModelKey || err instanceof OverCap) break;
        failure("discover", `careers page ${c.careers_url}`, err);
        o = {
          kind: "none",
          how: `reading its careers page failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
        };
      }
      if (!o) {
        if (pastDeadline()) leftAtDeadline("careers page", [c]);
        break;
      }
      out.push(write(c, o, now));
    }
  } finally {
    await r.close();
  }
  return out;
}

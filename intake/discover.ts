// Discovery: finding a company's board, once. Rare and uncertain, so it is its own step with its
// own queue (companies.discovery), never part of a refresh, and the tick runs it beside the board
// reads within its own time budget. In order: a board the company's own signal links to or
// names; the boards table (with its one confirming read); detection on the company's site, and
// the table's careers page for that site when the site gave no board; then a web search
// (intake/search.ts). A company with no domain gets one only with proof (intake/domain.ts): from
// its posts here, else from the web search, which then sends it back here for its site. A board taken from the company's site must list a role its signals named,
// when they named one: a country office's board linked from a global careers page isn't the
// company's. Nothing found: the company is marked "no board found", with any careers page or
// apply address seen, and looked at again in 30 days. A careers page found that no reader reads
// ("unreadable") is rendered and read by the small model after (intake/pages.ts). Two companies
// become one only on a proven domain: one domain, or one board whose companies' domains are one
// site. A company that came with a board and no domain gets its website looked up the same way,
// after the web search for boards (intake/search.ts siteFor).

// @ts-expect-error plain JS module
import { careersPage } from "../ats/links.mjs";
import {
  ATS_URL,
  boardKey,
  boardRoot,
  boardSlug,
  boardUrl,
  deadline,
  fromTable,
  label,
  leftAtDeadline,
  nameWords,
  pastDeadline,
  type RunnerCompany,
  type RunnerResult,
  registrable,
  runBoards,
  sharesWord,
  type Board as TableBoard,
  tableCareersPage,
  textBoards,
} from "../ats/reader.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, markChanged, open, tx } from "../core/db.ts";
import { exists } from "../core/log.ts";
import { online } from "../core/online.ts";
import { failure } from "../core/trace.ts";
import {
  type Company,
  companyByDomain,
  type DomainFrom,
  getCompany,
  mergeCompanies,
  proven,
  signalsOf,
} from "./companies.ts";
import { boardIsOthers, domainFromPosts, namesOther, type Proof, prove, slugNames } from "./domain.ts";
import { pagesDue, readPages } from "./pages.ts";
import { ACTIVE_DAYS, applyRead, type Board } from "./refresh.ts";
import {
  isCareersRoot,
  listsTitle,
  readersOn,
  roleTitles,
  SEARCH_RETRY_DAYS,
  type Searched,
  searchBoards,
  searchConfig,
  searchDue,
  searchSites,
  siteDue,
  unreadBecause,
} from "./search.ts";

export const RETRY_DAYS = 30;
const BATCH = 8; // companies a pass of the queue takes
const SEARCH_BATCH = 4; // companies a pass of web search takes
const WORKERS = 4; // companies or boards read at once (the board reads beside it take 8)
// How the site step found a board. The page itself names it (an embed, a job id it shows) or the
// company's own signal does: those count as they are. A link on a careers page must also list a
// role the company's signals named.
// A branded site (the company's careers site runs on the platform itself) counts as its own.
const NAMED_BY = new Set(["embed", "job id on the page", "lead", "lead text", "branded site"]);

/** Of two rows that are one company, the one to keep: watched, then with a thread, then with a domain, then older. */
function keeper(a: Company, b: Company): [keep: Company, drop: Company] {
  const rank = (c: Company) =>
    (c.watched_at ? 8 : 0) + (c.domain && exists(c.domain) ? 4 : 0) + (c.domain ? 2 : 0);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra > rb ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

/** Merge two companies that turned out to be one; returns the id kept. */
export function sameCompany(x: number, y: number, why: string): number {
  if (x === y) return x;
  const a = getCompany(x);
  const b = getCompany(y);
  if (!a || !b) return a?.id ?? b?.id ?? x;
  const [keep, drop] = keeper(a, b);
  mergeCompanies(keep.id, drop.id, why);
  return keep.id;
}

/** Is this page on the company's own site (the domain's registrable site)? */
const onSite = (url: string, domain: string) => {
  try {
    return registrable(new URL(url).hostname) === registrable(domain);
  } catch {
    return false;
  }
};

/** Two companies whose proven domains are one site (aws.amazon.com, amazon.com) are one company. */
const oneSite = (a: Company | null, b: Company | null) =>
  !!a && !!b && proven(a) && proven(b) && registrable(a.domain!) === registrable(b.domain!);

/** What addBoard did: the board and the company kept, or a refusal (the board is another company's). */
export type Added =
  | { board: Board; companyId: number; refused: null }
  | { board: null; companyId: number; refused: string };

/**
 * A company's board, as discovery (or a person) found it. A board another company already has
 * makes the two one company only when their proven domains are one site; else the board stays
 * the other's, this company is noted as having found it (unless it has a board already), and the
 * answer is a refusal: a caller writes nothing more on that board, and the note stays.
 */
export function addBoard(
  companyId: number,
  provider: string,
  url: string,
  foundBy: string,
  now = new Date(),
): Added {
  const root = boardUrl(provider, url);
  const key = boardKey(provider, root);
  return tx(() => {
    const d = open();
    let owner = companyId;
    const had = d.query("SELECT * FROM boards WHERE key = ?").get(key) as Board | null;
    if (had && had.company_id !== companyId) {
      const other = getCompany(had.company_id);
      if (!oneSite(other, getCompany(companyId))) {
        const refused = `${foundBy}: ${root} is ${other?.name ?? "another company"}'s board`;
        d.query(
          "UPDATE companies SET discovery = 'none', discovery_at = ?, discovery_note = ? WHERE id = ? AND discovery IS NOT 'found'",
        ).run(now.toISOString(), refused, companyId);
        return { board: null, companyId, refused };
      }
    }
    if (had) {
      if (had.company_id !== companyId)
        owner = sameCompany(had.company_id, companyId, `one board, ${root}, on one site`);
      // Found again after it broke: read it soon.
      d.query(
        "UPDATE boards SET status = 'ok', fails = 0, last_error = NULL, next_read_at = ? WHERE id = ? AND status <> 'ok'",
      ).run(now.toISOString(), had.id);
    } else {
      d.query(
        `INSERT INTO boards (company_id, provider, url, key, found_by, next_read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(owner, provider, root, key, foundBy, now.toISOString(), now.toISOString());
    }
    d.query(
      "UPDATE companies SET discovery = 'found', discovery_at = ?, discovery_note = ? WHERE id = ? AND discovery IS NOT 'found'",
    ).run(now.toISOString(), foundBy, owner);
    markChanged(now);
    const board = d.query("SELECT * FROM boards WHERE key = ?").get(key) as Board;
    return { board, companyId: owner, refused: null };
  });
}

/**
 * Set a company's domain. Another company with it proven is the same company when this one's is
 * proven too: they merge. A domain only looked up (the company index agrees) never makes two
 * companies one, and one another company has only looked up stays its: this one goes without.
 */
export function giveDomain(companyId: number, domain: string, from: DomainFrom): number {
  const other = companyByDomain(domain);
  if (other && other.id !== companyId)
    return from !== "looked up" && proven(other)
      ? sameCompany(other.id, companyId, `one domain, ${domain} (${from})`)
      : companyId;
  open()
    .query("UPDATE companies SET domain = ?, domain_from = ? WHERE id = ? AND domain IS NULL")
    .run(domain, from, companyId);
  return companyId;
}

function nothingFound(
  c: Company,
  now: Date,
  o: { note: string; careers?: string | null; email?: unknown; state?: "none" | "unreadable" },
): void {
  // Only a page the rule calls a careers page is kept as one (ats/links.mjs careersPage).
  const careers = o.careers && careersPage(o.careers) ? o.careers : null;
  // A company with a board that works (one it joined meanwhile) stays found, with that board's note.
  const ok = !!open().query("SELECT 1 FROM boards WHERE company_id = ? AND status = 'ok' LIMIT 1").get(c.id);
  open()
    .query(
      `UPDATE companies SET discovery = ?, discovery_at = ?, discovery_note = coalesce(?, discovery_note),
         careers_url = coalesce(?, careers_url), apply_email = coalesce(?, apply_email) WHERE id = ?`,
    )
    .run(
      ok ? "found" : careers ? (o.state ?? "none") : "none",
      now.toISOString(),
      ok ? null : o.note.slice(0, 200),
      careers,
      o.email ? JSON.stringify(o.email) : null,
      c.id,
    );
}

type Hints = { hint?: string; after?: string };

/**
 * What the company's own signals point at: a link on a job board (a posting the board search
 * found, a pasted board) first; else a board named in a signal's text (an HN post) whose name
 * is the company's, tried after its site.
 */
export function hintsFor(c: Company): Hints {
  const out: Hints = {};
  const ours = (slug: string) =>
    [c.name, c.domain ? label(c.domain) : ""].some((n) => n && nameWords(n).length && sharesWord(n, slug));
  for (const s of signalsOf(c.id, 50)) {
    if (!out.hint && ATS_URL.test(s.url) && boardRoot(s.url)) out.hint = s.url;
    if (!out.after && s.text) {
      const board = textBoards(s.text).find((b) => ours(boardSlug(b) ?? ""));
      if (board) out.after = board;
    }
  }
  return out;
}

/** The roles a company was seen with: its signals' titles, for the table's confirming read. */
const seenWith = (c: Company) =>
  signalsOf(c.id, 50)
    .filter((s) => s.title)
    .map((s) => ({ title: s.title!, ...(s.location ? { location: s.location } : {}) }));

/**
 * Companies waiting to have their board looked for: queued (never looked for, however long ago
 * their last signal), or not found a month ago and still active. Dismissed ones never.
 */
export function discoveryDue(now = new Date(), limit = BATCH): Company[] {
  return open()
    .query(
      `SELECT * FROM companies
       WHERE (watched_at IS NOT NULL OR dismissed_at IS NULL)
         AND (discovery = 'queued' OR (discovery IN ('none', 'unreadable', 'blocked') AND discovery_at < $retry
           AND (watched_at IS NOT NULL OR last_signal_at >= $active)))
       ORDER BY last_signal_at DESC LIMIT $limit`,
    )
    .all({
      retry: new Date(now.getTime() - RETRY_DAYS * DAY).toISOString(),
      active: new Date(now.getTime() - ACTIVE_DAYS * DAY).toISOString(),
      limit,
    }) as Company[];
}

export type Found = { companyId: number; board?: string; provider?: string; how: string };

/**
 * Companies discovery still has to look at now: the queue, looks due again, careers pages to read
 * (unless `pages` is false: the model can't read them now), and web searches due (searches only
 * while web search is on, and `search` isn't false). Dismissed ones never.
 */
export function waiting(now = new Date(), o: { search?: boolean; pages?: boolean } = {}): number {
  return (
    open()
      .query(
        `SELECT count(*) AS n FROM companies
         WHERE (watched_at IS NOT NULL OR dismissed_at IS NULL)
           AND (discovery = 'queued'
             OR ($pages AND discovery = 'unreadable' AND careers_url IS NOT NULL)
             OR (discovery IN ('none', 'unreadable', 'blocked') AND discovery_at < $retry
               AND (watched_at IS NOT NULL OR last_signal_at >= $active))
             OR ($search AND discovery = 'none' AND (search_at IS NULL OR (search_at < $searchRetry
               AND (watched_at IS NOT NULL OR last_signal_at >= $active)))))`,
      )
      .get({
        retry: new Date(now.getTime() - RETRY_DAYS * DAY).toISOString(),
        searchRetry: new Date(now.getTime() - SEARCH_RETRY_DAYS * DAY).toISOString(),
        active: new Date(now.getTime() - ACTIVE_DAYS * DAY).toISOString(),
        search: searchConfig().on && o.search !== false ? 1 : 0,
        pages: o.pages === false ? 0 : 1,
      }) as { n: number }
  ).n;
}

/** Discovery's time in a tick: [discovery] tick_seconds. A batch run (intake/batch.ts) has no limit. */
export function budgetMs(): number {
  return 1000 * Number(loadConfig().discovery.tick_seconds);
}

/**
 * Look for these companies' boards. `hint`: a board, posting or careers page a person pasted for
 * one company (Add), tried first. Each board found gets its first read here when the table's
 * confirming read already holds it.
 */
export async function discover(companies: Company[], now = new Date(), hint?: string): Promise<Found[]> {
  const out: Found[] = [];
  // Past the deadline: the companies not written yet stay as they were, traced.
  const stop = (step: string) => {
    const done = new Set(out.map((f) => f.companyId));
    leftAtDeadline(
      `discover: ${step}`,
      companies.filter((c) => !done.has(c.id)),
    );
    return out;
  };
  const asked = companies.map((c) => ({ c, ...hintsFor(c), ...(hint ? { hint } : {}) }));
  // 2. The boards table, for companies whose signals name no board.
  const table = await fromTable(
    asked
      .filter((a) => !a.hint && !a.after)
      .map((a) => ({ key: String(a.c.id), name: a.c.name, domain: a.c.domain, seen: seenWith(a.c) })),
  ).catch((err) => {
    failure("discover", "boards table", err);
    return new Map<string, { board: TableBoard; jobs: RunnerResult["jobs"]; boardCount?: number }>();
  });
  // Past the step's deadline, nothing found is written: those companies stay queued.
  if (pastDeadline()) return stop("boards table");
  // A table board named for another company isn't this one's, whatever website the table gives
  // it (Utah Jazz on nba.com got Intuit Dome's): the company is looked for on its site instead.
  for (const [key, t] of table) {
    const c = getCompany(Number(key));
    const stated = t.board.name !== boardSlug(t.board.root) ? t.board.name : null;
    if (c && stated && namesOther(stated, c.name, c.domain)) table.delete(key);
  }
  for (const [key, t] of table) {
    let id = Number(key);
    // The website the table gives for the board counts only with proof, like any other.
    const c = getCompany(id);
    const proof = t.board.website && c && !c.domain ? await prove(c, t.board.website) : null;
    if (proof) id = giveDomain(id, proof.domain, proof.from);
    const added = addBoard(id, t.board.provider, t.board.root, "boards table", now);
    // Another company's: not read for this one, nor reported found.
    if (!added.board) {
      out.push({ companyId: added.companyId, how: added.refused });
      continue;
    }
    // The confirming read is the board's first read.
    applyRead(added.board, { ok: true, jobs: t.jobs }, now);
    out.push({
      companyId: added.companyId,
      board: t.board.root,
      provider: t.board.provider,
      how: "boards table",
    });
  }
  // 1 and 3. The signal's own board, then the company's site; with no domain, one its posts prove.
  const rest = asked.filter((a) => !table.has(String(a.c.id)));
  const toDetect: { a: (typeof rest)[number]; domain: string | null; proof: Proof | null }[] =
    await Promise.all(
      rest.map(async (a) => {
        const proof = a.c.domain ? null : await domainFromPosts(a.c).catch(() => null);
        return { a, domain: a.c.domain ?? proof?.domain ?? null, proof };
      }),
    );
  if (pastDeadline()) return stop("posts' domains");
  const results = new Map<string, RunnerResult>();
  const detect = toDetect.flatMap(({ a, domain }): RunnerCompany[] => {
    if (domain)
      return [{ domain: String(a.c.id), name: a.c.name, site: domain, hint: a.hint, after: a.after }];
    // No site to look at: only the links its signals gave.
    const links = [a.hint, a.after].filter((x): x is string => !!x);
    return links.length
      ? [{ domain: String(a.c.id), name: a.c.name, links, page: links[0], method: "lead" }]
      : [];
  });
  const ms = searchConfig().companyMs;
  if (detect.length)
    await runBoards(
      "detect",
      detect.map((d) => ({ ...d, deadlineMs: ms })),
      (r) => {
        results.set(r.domain, r);
      },
      { workers: WORKERS },
    ).catch((err) => failure("discover", "detection", err));
  if (pastDeadline()) return stop("detection");
  // The site gave careers pages but no board (or its walk ran out of time): every reader is
  // tried on those pages themselves, or the careers page seen before, before it's left at that.
  const again = toDetect.flatMap(({ a, domain }) => {
    const r = results.get(String(a.c.id));
    const d = r?.detect as { provider?: string; careers_read?: string; careers_pages?: string[] } | undefined;
    if (d?.provider || d?.careers_read) return [];
    const pages = d?.careers_pages?.length
      ? d.careers_pages.slice(0, 2)
      : a.c.careers_url
        ? [a.c.careers_url]
        : [];
    if (!pages.length) return [];
    const site = domain ?? new URL(pages[0]!).hostname.replace(/^www\./, "");
    return [{ key: String(a.c.id), name: a.c.name, site, pages }];
  });
  // The boards table's careers page for its website, when its own site gave no board: read by the
  // same readers, under a key of its own. Only at a company's first look, so a page that has gone
  // costs one try and the company goes on to the usual search.
  const tablePages = toDetect.flatMap(({ a, domain }) => {
    const r = results.get(String(a.c.id));
    const d = r?.detect as { provider?: string; careers_read?: string } | undefined;
    // Its site's walk may have failed or run out of time: the table's page is tried all the same.
    const page = !a.c.discovery_at && domain && !d?.provider && !d?.careers_read && tableCareersPage(domain);
    return page ? [{ key: String(a.c.id), name: a.c.name, site: domain, pages: [page] }] : [];
  });
  const onPages = await readersOn([...again, ...tablePages.map((t) => ({ ...t, key: `${t.key} table` }))]);
  if (pastDeadline()) return stop("readers on its careers pages");
  for (const [key, p] of onPages) {
    if (key.endsWith(" table")) continue;
    const r = results.get(key);
    const d = (r?.ok ? r.detect : {}) as Record<string, unknown>;
    if (p.provider || p.careers_read) results.set(key, { domain: key, ok: true, detect: { ...d, ...p } });
    else if (unreadBecause(p))
      results.set(key, {
        domain: key,
        ok: true,
        detect: {
          ...d,
          careers_pages: (d.careers_pages as string[] | undefined) ?? again.find((x) => x.key === key)?.pages,
          problem: `its careers site's board can't be read: ${unreadBecause(p)}`,
        },
      });
  }
  for (const { key, pages } of tablePages) {
    const r = results.get(key);
    const d = (r?.ok ? r.detect : {}) as {
      provider?: string;
      careers_read?: string;
      careers_pages?: string[];
    };
    const p = onPages.get(`${key} table`);
    if (d.provider || d.careers_read) continue; // its own pages gave one
    if (p?.provider || p?.careers_read)
      results.set(key, { domain: key, ok: true, detect: { ...d, ...p, method: "boards table" } });
    // It answered with no board on it: its careers page, as one the site gave (the page reader's next).
    else if (p?.tried?.length)
      results.set(key, {
        domain: key,
        ok: true,
        detect: { ...d, careers_pages: [pages[0]!, ...(d.careers_pages ?? [])] },
      });
  }
  // A board linked from a careers page, for a company whose signals named roles: it must list one.
  const linked = toDetect.flatMap(({ a }) => {
    const d = results.get(String(a.c.id))?.detect as {
      provider?: string;
      careers_url?: string;
      method?: string;
    };
    const titles = roleTitles(signalsOf(a.c.id, 50));
    if (!d?.provider || !d.careers_url || NAMED_BY.has(d.method ?? "") || !titles.length) return [];
    return [{ key: String(a.c.id), provider: d.provider, url: d.careers_url, name: a.c.name, titles }];
  });
  const listed = await listsTitle(linked, ms);
  if (pastDeadline()) return stop("listed-role check");
  const unlisted = new Map<string, string>();
  for (const l of linked) {
    const got = listed.get(l.key);
    if (got === "title" || (got === "near" && slugNames(l.name, boardSlug(l.url)))) continue;
    unlisted.set(
      l.key,
      got === null
        ? `its site links ${l.url}, which didn't answer when checked for "${l.titles[0]}"`
        : `its site links ${l.url}, which doesn't list "${l.titles[0]}"`,
    );
  }
  // A board its site or signal gave that names another company isn't this one's (a16z's site
  // linked Box's). What you Add is taken as given.
  if (!hint)
    await Promise.all(
      toDetect.map(async ({ a, domain, proof }) => {
        const key = String(a.c.id);
        const d = results.get(key)?.detect as { provider?: string; careers_url?: string } | undefined;
        if (!d?.provider || !d.careers_url || unlisted.has(key)) return;
        // Where the domain came from: the company's own, or the proof its posts gave.
        const domain_from = a.c.domain ? a.c.domain_from : (proof?.from ?? null);
        const others = await boardIsOthers(d.careers_url, { name: a.c.name, domain, domain_from }).catch(
          () => null,
        );
        if (others) unlisted.set(key, `its site links ${d.careers_url}, which is ${others}'s board`);
      }),
    );
  if (pastDeadline()) return stop("whose-board check");
  // With no internet every site looks gone: nothing found isn't written, those companies stay
  // queued (a site that truly doesn't resolve while the internet is up is still nothing found).
  const up = await online();
  for (const { a, domain, proof } of toDetect) {
    const c = getCompany(a.c.id);
    if (!c) continue; // merged away meanwhile
    const r = results.get(String(c.id));
    const d = (r?.detect ?? {}) as {
      provider?: string;
      careers_url?: string;
      method?: string;
      careers_pages?: string[];
      careers_read?: string;
      problem?: string;
      apply_email?: { address: string; page: string };
    };
    const id = proof ? giveDomain(c.id, proof.domain, proof.from) : c.id;
    const refused = unlisted.get(String(c.id));
    const gaveUp = !(r?.ok && d.provider && d.careers_url) && !(r?.ok && d.careers_read);
    if ((refused || gaveUp) && !up) continue;
    if (refused) {
      nothingFound(getCompany(id)!, now, {
        note: refused,
        careers: d.careers_pages?.find((u) => careersPage(u)) ?? null,
        email: d.apply_email,
      });
      out.push({ companyId: id, how: refused });
    } else if (r?.ok && d.provider && d.careers_url) {
      const added = addBoard(id, d.provider, d.careers_url, d.method ?? "careers page", now);
      out.push(
        !added.board
          ? { companyId: added.companyId, how: added.refused }
          : {
              companyId: added.companyId,
              board: added.board.url,
              provider: d.provider,
              how: d.method ?? "site",
            },
      );
    } else if (r?.ok && d.careers_read) {
      const how = d.method === "boards table" ? "boards table" : "careers page";
      const added = addBoard(id, "careers-page", d.careers_read, how, now);
      out.push(
        !added.board
          ? { companyId: added.companyId, how: added.refused }
          : {
              companyId: added.companyId,
              board: d.careers_read,
              provider: "careers-page",
              how,
            },
      );
    } else {
      const note = !r
        ? domain || a.hint
          ? "detection didn't answer"
          : "no site known and no board named"
        : !r.ok
          ? `detection failed: ${r.error ?? "unknown"}`
          : (d.problem ?? "no board found");
      // A careers page on its own site that no reader here reads goes straight to the page
      // reader (intake/pages.ts): a web search would only find that page again. The careers page
      // itself first (cal.com/jobs), before a page under it (cal.com/careers/apply, a booking form).
      const mine =
        r?.ok && domain ? (d.careers_pages ?? []).filter((u) => careersPage(u) && onSite(u, domain)) : [];
      const own = mine.find(isCareersRoot) ?? mine[0] ?? null;
      nothingFound(getCompany(id)!, now, {
        note: own ? `${note} · its careers page is read next` : note,
        careers: own ?? d.careers_pages?.find((u) => careersPage(u)) ?? null,
        email: d.apply_email,
        state: own ? "unreadable" : "none",
      });
      out.push({ companyId: id, how: note });
    }
  }
  markChanged(now);
  return out;
}

/** What a web search decided, written to the company. */
export function applySearch(done: Searched[], now = new Date()): Found[] {
  const out: Found[] = [];
  for (const { company, verdict: v } of done) {
    if (!getCompany(company.id)) continue; // merged away meanwhile
    const id = v.kind === "site" ? giveDomain(company.id, v.domain, v.from) : company.id;
    if (v.kind === "site" && getCompany(id)?.domain) {
      // Its own site is looked at next; the careers search waits for that. One it joined that
      // has a board or a careers page keeps it (two Y Combinator rows: the careers page stays).
      open()
        .query(
          "UPDATE companies SET discovery = 'queued', discovery_note = ? WHERE id = ? AND discovery = 'none'",
        )
        .run(v.how.slice(0, 200), id);
      out.push({ companyId: id, how: v.how });
    } else if (v.kind === "site") {
      // Another company has it, and one of the two only looked up: this one goes without,
      // searched again in 30 days.
      const how = `${v.how} · ${companyByDomain(v.domain)?.name ?? "another company"} has it`;
      open()
        .query("UPDATE companies SET discovery_at = ?, discovery_note = ?, search_at = ? WHERE id = ?")
        .run(now.toISOString(), how.slice(0, 200), now.toISOString(), id);
      out.push({ companyId: id, how });
    } else if (v.kind === "board") {
      const added = addBoard(id, v.provider, v.url, "web search", now);
      // Another company's board: addBoard said whose, and that stays the note.
      if (!added.board) {
        out.push({ companyId: added.companyId, how: added.refused });
        continue;
      }
      open()
        .query("UPDATE companies SET discovery_note = ? WHERE id = ?")
        .run(v.how.slice(0, 200), added.companyId);
      out.push({ companyId: added.companyId, board: added.board.url, provider: v.provider, how: v.how });
    } else if (v.kind === "careers") {
      open()
        .query(
          "UPDATE companies SET discovery = 'unreadable', discovery_at = ?, discovery_note = ?, careers_url = ? WHERE id = ?",
        )
        .run(now.toISOString(), v.how.slice(0, 200), v.url, id);
      out.push({ companyId: id, how: v.how });
    } else {
      const was = getCompany(id)?.discovery_note;
      const note = was && !was.startsWith("web search") ? `${was} · ${v.how}` : v.how;
      open()
        .query("UPDATE companies SET discovery_at = ?, discovery_note = ? WHERE id = ?")
        .run(now.toISOString(), note.slice(0, 200), id);
      out.push({ companyId: id, how: v.how });
    }
  }
  markChanged(now);
  return out;
}

/**
 * What a website lookup decided for a company that has a board: its domain, through giveDomain
 * (one another company has proven makes the two one; its stand-in thread then moves to the real
 * one), and when it was looked up, either way. Its board, and how that was found, stay.
 */
export function applySites(done: Searched[], now = new Date()): Found[] {
  const out: Found[] = [];
  for (const { company, verdict: v } of done) {
    if (!getCompany(company.id)) continue; // merged away meanwhile
    const id = v.kind === "site" ? giveDomain(company.id, v.domain, v.from) : company.id;
    const how =
      v.kind === "site" && !getCompany(id)?.domain
        ? `${v.how} · ${companyByDomain(v.domain)?.name ?? "another company"} has it`
        : v.how;
    open().query("UPDATE companies SET search_at = ? WHERE id = ?").run(now.toISOString(), id);
    out.push({ companyId: id, how });
  }
  markChanged(now);
  return out;
}

// Steps a deadline left going, which still write what they find: the tick waits for them before it
// lets go of its lock, so a tick or source started by hand right after never pays for them twice.
const going = new Set<Promise<void>>();

/** Wait, up to `ms`, for discovery's steps still going past a deadline; how many still are. */
export async function stillGoing(ms: number): Promise<number> {
  if (!going.size) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...going]),
    new Promise<void>((r) => {
      timer = setTimeout(r, ms);
    }),
  ]).finally(() => clearTimeout(timer));
  return going.size;
}

/** A batch run's view of discovery as it goes: the step it is on and its companies, then what came of them. */
export type Watch = {
  on: (step: string, companies: Company[]) => void;
  found: (found: Found[]) => void;
};

/**
 * Discovery, within `budgetMs` (the tick's), or with none (a batch run): the queue a batch at a
 * time, then a web search for companies the free steps left without a board, then a website for
 * companies that came with a board and none. What the budget doesn't reach waits for the next
 * tick; a batch already started finishes (each company within its own deadline). Past the
 * deadline no model call is started, and what the model already answered is kept when the rest of
 * its step finished (search.ts, pages.ts). `stop`: asked before each batch, true ends it there,
 * cleanly. `clock`: the time each batch is dated by (a batch run's own, as it goes; the tick's
 * start otherwise).
 */
export async function discoverDue(
  now = new Date(),
  o: { budgetMs?: number; stop?: () => boolean; clock?: () => Date; watch?: Watch } = {},
): Promise<Found[]> {
  // A hard bound: at the deadline the runners going are stopped, the tick goes on, and the
  // companies in flight stay queued for the next tick unless their step finishes whole.
  const ms = o.budgetMs ?? budgetMs();
  const at = o.clock ?? (() => now);
  const ctl = new AbortController();
  const timer = Number.isFinite(ms) ? setTimeout(() => ctl.abort(), Math.max(0, ms)) : undefined;
  const ended = () => ctl.signal.aborted || !!o.stop?.();
  const stopped = new Promise<undefined>((r) =>
    ctl.signal.addEventListener("abort", () => r(undefined), { once: true }),
  );
  // A step's answer, or undefined at the deadline. A step going then finishes on its own: a
  // failure after is traced, never thrown.
  const until = <T>(step: Promise<T>): Promise<T | undefined> => {
    const done = step.then(
      () => {},
      (err) => {
        if (ctl.signal.aborted) failure("discover", "a step past the deadline", err);
      },
    );
    going.add(done);
    void done.then(() => going.delete(done));
    return Promise.race([step, stopped]);
  };
  const tell = (found: Found[]) => {
    o.watch?.found(found);
    return found;
  };
  const out: Found[] = [];
  try {
    await deadline.run(ctl.signal, async () => {
      const seen = new Set<number>();
      while (!ended()) {
        const due = discoveryDue(at()).filter((c) => !seen.has(c.id));
        if (!due.length) break;
        for (const c of due) seen.add(c.id);
        o.watch?.on("looking on their websites", due);
        const found = await until(discover(due, at()));
        if (!found) return;
        out.push(...tell(found));
      }
      const searched = new Set<number>();
      while (searchConfig().on && !ended()) {
        const due = searchDue(at(), SEARCH_BATCH, ACTIVE_DAYS).filter((c) => !searched.has(c.id));
        if (!due.length) break;
        for (const c of due) searched.add(c.id);
        o.watch?.on("searching the web for their job boards", due);
        // What was decided is written with it, so a pick that finishes past the deadline is kept.
        const t = at();
        const found = await until(
          searchBoards(due, t).then((done) => (done.length ? applySearch(done, t) : null)),
        );
        if (found === undefined) return;
        if (!found) break; // the day's cap, or no search answered
        out.push(...tell(found));
      }
      // A website for companies that came with a board and none, in the same daily cap.
      const looked = new Set<number>();
      while (searchConfig().on && !ended()) {
        // One at a time: each is written as soon as it's decided (its site's walk can take 45s).
        const due = siteDue(at(), 1, ACTIVE_DAYS).filter((c) => !looked.has(c.id));
        if (!due.length) break;
        for (const c of due) looked.add(c.id);
        o.watch?.on("looking up its website", due);
        const t = at();
        const found = await until(
          searchSites(due, t).then((done) => (done.length ? applySites(done, t) : null)),
        );
        if (found === undefined) return;
        if (!found) break; // the day's cap, or no search answered
        out.push(...tell(found));
      }
      // Careers pages found but not read: rendered, then read by the model (intake/pages.ts).
      const read = new Set<number>();
      while (!ended()) {
        const due = pagesDue().filter((c) => !read.has(c.id));
        if (!due.length) break;
        for (const c of due) read.add(c.id);
        o.watch?.on("reading their careers pages", due);
        const done = await until(readPages(due, at()));
        if (!done) return;
        if (!done.length) break; // the model can't run now: they wait
        out.push(...tell(done));
      }
    });
  } finally {
    clearTimeout(timer);
  }
  return out;
}

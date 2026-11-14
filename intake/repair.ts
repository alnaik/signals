// One-time repairs of what discovery stored before its acceptance rule (2026-10-29). Run once
// per data folder, by the first tick or `jobsignal migrate` after the update; a meta key says it
// ran. Each line it returns says what it changed.
//  1. A company named "Unknown" (or another placeholder) is no company: it goes, with its boards
//     and roles; its signals wait unplaced, not asked about again.
//  2. Where each company's domain came from (companies.domain_from). The old import took domains
//     from a name lookup (company-domains.json) and copied them onto the signals too, so a domain
//     counts as stated only when you watch the company, a signal's link or text shows it, or a
//     signal carries it that the lookup didn't give. Then each signal stating a domain is placed
//     again through upsertCompany: a same-name company whose domain was only looked up joins the
//     one with the stated domain (Google → google.dev, beside google.com from its HN post). Last,
//     a looked-up domain on a company only HN posts named (they link the company's site when
//     there is one), with nothing on that site found for it, is dropped (River → riverisland.com).
//  3. A board linked from a careers page, for a company whose signals named roles, that never
//     listed one of them (Deloitte Ireland's board, for Deloitte's US alerts): it goes, and the
//     company's board is looked for again.
import { bare, boardSlug, registrable, squash } from "../ats/reader.ts";
import { getMeta, markChanged, open, setMeta, tx } from "../core/db.ts";
import {
  type Company,
  companyByDomain,
  type DomainFrom,
  getCompany,
  isDomainName,
  isPlaceholder,
  type Signal,
  signalsOf,
  upsertCompany,
} from "./companies.ts";
import { slugNames } from "./domain.ts";
import type { Board } from "./refresh.ts";
import { nearRole, roleTitles, sameRole } from "./search.ts";

const KEY = "repair:discovery-search";
const ANSWERED = 9; // classify.ts: the signal names no company; it isn't asked about again
const LINKED = ["careers page", "rendered page"]; // found_by of a board a careers page linked to

/** Its boards, their roles and its names go; its signals stay, unplaced. */
function removeCompany(id: number): void {
  const d = open();
  d.query("DELETE FROM role_text WHERE role_id IN (SELECT id FROM roles WHERE company_id = ?)").run(id);
  d.query("DELETE FROM roles WHERE company_id = ?").run(id);
  d.query("DELETE FROM boards WHERE company_id = ?").run(id);
  d.query("DELETE FROM company_names WHERE company_id = ?").run(id);
  d.query("UPDATE signals SET company_id = NULL, classify_tries = ? WHERE company_id = ?").run(ANSWERED, id);
  d.query("DELETE FROM companies WHERE id = ?").run(id);
}

function removeBoard(b: Board): void {
  const d = open();
  d.query("DELETE FROM role_text WHERE role_id IN (SELECT id FROM roles WHERE board_id = ?)").run(b.id);
  d.query("DELETE FROM roles WHERE board_id = ?").run(b.id);
  d.query("DELETE FROM boards WHERE id = ?").run(b.id);
}

const hasBoard = (id: number) =>
  !!open().query("SELECT 1 FROM boards WHERE company_id = ? AND status = 'ok' LIMIT 1").get(id);

/** Did a source other than HN name this company? HN posts link the company's site when there is one. */
const mayLookUp = (companyId: number) => {
  const sources = open().query("SELECT DISTINCT source FROM signals WHERE company_id = ?").all(companyId) as {
    source: string;
  }[];
  return !sources.length || sources.some((x) => x.source !== "hn");
};

/** Looked for again: queued, with no note from the last look. */
const requeue = (id: number, note: string | null = null) =>
  open()
    .query("UPDATE companies SET discovery = 'queued', discovery_note = ?, search_at = NULL WHERE id = ?")
    .run(note, id);

/** The domain the name lookup gave for this name, if it gave one. */
function lookedUpFor(name: string | null): string | null {
  const raw = name ? getMeta(`domain:${bare(name)}`) : null;
  try {
    return raw ? ((JSON.parse(raw) as { domain?: string | null }).domain ?? null) : null;
  } catch {
    return null;
  }
}

/** The domain this signal states, if any: shown in its link or text, or carried but not looked up. */
function statedBy(s: Signal, domain: string | null = s.domain): string | null {
  if (!domain) return null;
  if (`${s.url} ${s.text ?? ""}`.toLowerCase().includes(domain)) return domain;
  return s.domain === domain && lookedUpFor(s.name) !== domain ? domain : null;
}

function domainFrom(c: Company): DomainFrom | null {
  if (!c.domain) return null;
  if (c.watched_at) return "stated";
  const signals = signalsOf(c.id, 500);
  if (signals.some((s) => statedBy(s, c.domain))) return "stated";
  const names = [c.name, ...signals.map((s) => s.name)];
  return names.some((n) => lookedUpFor(n) === c.domain) ? "looked up" : "stated";
}

/**
 * Something says the site is the company's: the domain is its name exactly (neuralframe.com for
 * NeuralFrame), or a board is on the site, linked from a careers page there, or named like it. A
 * careers page alone doesn't: any site has one (footprintnetwork.org, for the Footprint whose
 * post builds bank software; riverisland.com, for River).
 */
function backedBySite(c: Company): boolean {
  const domain = c.domain!;
  const label = squash(domain.split(".")[0] ?? "");
  if (label === bare(c.name)) return true;
  const onSite = (url: string | null) => {
    try {
      return !!url && registrable(new URL(url).hostname) === registrable(domain);
    } catch {
      return false;
    }
  };
  const boards = open().query("SELECT url, found_by FROM boards WHERE company_id = ?").all(c.id) as {
    url: string;
    found_by: string | null;
  }[];
  return boards.some(
    (b) => onSite(b.url) || LINKED.includes(b.found_by ?? "") || squash(boardSlug(b.url) ?? "") === label,
  );
}

export function repairOnce(now = new Date()): string[] {
  if (getMeta(KEY)) return [];
  const out: string[] = [];
  tx(() => {
    const d = open();
    // 1. Placeholder names.
    for (const c of d.query("SELECT * FROM companies").all() as Company[]) {
      if (!isPlaceholder(c.name)) continue;
      removeCompany(c.id);
      out.push(
        `removed "${c.name}"${c.domain ? ` (${c.domain})` : ""} and its boards: the name names no company`,
      );
    }
    for (const { key } of d.query("SELECT key FROM meta WHERE key LIKE 'domain:%'").all() as {
      key: string;
    }[])
      if (isPlaceholder(key.slice("domain:".length))) d.query("DELETE FROM meta WHERE key = ?").run(key);

    // 2. Where each domain came from; stated domains place their signals; unbacked guesses go.
    for (const c of d.query("SELECT * FROM companies WHERE domain IS NOT NULL").all() as Company[])
      d.query("UPDATE companies SET domain_from = ? WHERE id = ?").run(domainFrom(c), c.id);
    const placed = d
      .query("SELECT * FROM signals WHERE company_id IS NOT NULL AND domain IS NOT NULL ORDER BY id")
      .all() as Signal[];
    for (const s of placed) {
      const domain = statedBy(s);
      const was = getCompany(s.company_id!);
      // Only where a company has the domain: the repair joins companies, it makes none.
      if (!domain || !was || !companyByDomain(domain)) continue;
      const name = s.name && !isPlaceholder(s.name) && !isDomainName(s.name) ? s.name : was.name;
      const before = new Map(
        (d.query("SELECT id, name, domain FROM companies").all() as Company[]).map((x) => [x.id, x]),
      );
      const id = upsertCompany({ name, domain });
      if (id !== s.company_id) d.query("UPDATE signals SET company_id = ? WHERE id = ?").run(id, s.id);
      for (const [gone, x] of before)
        if (!getCompany(gone)) {
          const kept = getCompany(id)!;
          out.push(
            `${x.name}${x.domain ? ` (${x.domain})` : ""} joined ${kept.name} (${kept.domain}): signal ${s.id} states ${domain}`,
          );
        }
    }
    for (const c of d
      .query("SELECT * FROM companies WHERE domain_from = 'looked up' AND watched_at IS NULL")
      .all() as Company[]) {
      if (mayLookUp(c.id) || backedBySite(c)) continue;
      // Its careers page and apply address there were the other company's.
      d.query(
        `UPDATE companies SET domain = NULL, domain_from = NULL,
           careers_url = CASE WHEN careers_url LIKE $like THEN NULL ELSE careers_url END,
           apply_email = CASE WHEN apply_email LIKE $like THEN NULL ELSE apply_email END WHERE id = $id`,
      ).run({ id: c.id, like: `%${c.domain}%` });
      for (const n of [c.name, ...signalsOf(c.id, 50).map((s) => s.name)])
        if (n && lookedUpFor(n) === c.domain)
          d.query("DELETE FROM meta WHERE key = ?").run(`domain:${bare(n)}`);
      if (!hasBoard(c.id)) requeue(c.id);
      out.push(`${c.name}: dropped ${c.domain}, a name lookup for a company whose HN posts give no site`);
    }

    // 3. Boards a careers page linked to that never listed a role the company was seen with.
    const linked = d
      .query(`SELECT * FROM boards WHERE found_by IN (${LINKED.map(() => "?").join(",")})`)
      .all(...LINKED) as Board[];
    for (const b of linked) {
      const titles = roleTitles(signalsOf(b.company_id, 50));
      if (!titles.length) continue;
      const roles = d.query("SELECT title, location FROM roles WHERE board_id = ?").all(b.id) as {
        title: string;
        location: string;
      }[];
      const named = slugNames(
        (d.query("SELECT name FROM companies WHERE id = ?").get(b.company_id) as { name: string }).name,
        boardSlug(b.url),
      );
      const listed = roles.some(
        (r) => sameRole(r.title, titles, r.location) || (named && nearRole(r.title, titles, r.location)),
      );
      if (listed) continue;
      removeBoard(b);
      if (!hasBoard(b.company_id))
        requeue(b.company_id, `its site linked ${b.url}, which never listed "${titles[0]}"`);
      out.push(`removed ${b.url}: it never listed "${titles[0]}"`);
    }
    setMeta(KEY, now.toISOString());
    if (out.length) markChanged(now);
  });
  return out;
}

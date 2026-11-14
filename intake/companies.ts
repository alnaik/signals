// Companies and the signals that name them. A signal only names a company: it is kept as
// received, the company is found or made (by its domain when the signal has one, else by its
// name), and the company's boards are read soon, or it waits for discovery.
// @ts-expect-error plain JS module
import { applyEmailIn } from "../ats/links.mjs";
import { ATS_URL, bare, boardRoot } from "../ats/reader.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, markChanged, open, tx } from "../core/db.ts";
import { read, threadId } from "../core/log.ts";
import { event } from "../core/trace.ts";
import { isStandIn } from "../core/vocab.ts";

export { isStandIn };

import { companyDomain, normalizeUrl } from "./leads.ts";
import type { Lead } from "./types.ts";

export type Company = {
  id: number;
  name: string;
  domain: string | null;
  domain_from: DomainFrom | null; // where its domain came from (null: no domain, or not yet known)
  created_at: string;
  last_signal_at: string | null;
  watched_at: string | null;
  watch_sources: string | null;
  dismissed_at: string | null;
  apply_email: string | null;
  funding: string | null;
  careers_url: string | null;
  discovery: string | null; // queued | found | none | unreadable (its careers page waits to be read, or can't be) | blocked (robots.txt)
  discovery_at: string | null;
  discovery_note: string | null;
  search_at: string | null; // its last web search for a board (with a board: for its website)
  hidden_at?: string | null; // Hide on the Signals screen: out of that list only
};

/**
 * Where a company's domain came from, its proof. Stated: a signal's own link or post, a Form D
 * filing, Add. Discovery's proofs (intake/domain.ts): post (the company's posts link or email it),
 * board (its board states it), homepage (the homepage names the company). Looked up: an old
 * name-to-domain lookup, never proof, which can name another company of that name (Google →
 * google.dev). A stated domain replaces a looked-up one, and a signal stating a domain joins a
 * same-name company whose domain was only looked up.
 */
export type DomainFrom = "stated" | "post" | "board" | "homepage" | "looked up" | "hand";
const lookedUp = (c: Pick<Company, "domain" | "domain_from">) => !!c.domain && c.domain_from === "looked up";
/** Does this company's domain have proof? Only a proven domain makes two companies one. */
export const proven = (c: Pick<Company, "domain" | "domain_from">) => !!c.domain && !lookedUp(c);
/** "google.com" as a name: a company known only by its domain so far. */
export const isDomainName = (name: string) => /^[\w-]+(\.[\w-]+)+$/.test(name.trim());

export type Funding = { form: "D"; date: string; url: string; cik: string };
export type ApplyEmail = { address: string; page: string };

// Words that stand where a company's name was left out ("Unknown", "Confidential", "Stealth
// Startup"). They name no company: a signal that carries only one waits for the classifier, and
// the classifier's own "Unknown" places nothing.
const PLACEHOLDERS = new Set(
  [
    "unknown",
    "unknown company",
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "tbd",
    "confidential",
    "confidential company",
    "undisclosed",
    "anonymous",
    "private",
    "private company",
    "stealth",
    "stealth startup",
    "stealth mode",
    "stealth company",
    "stealth mode startup",
    "company",
    "hiring",
    "various",
    "multiple",
    "not specified",
    "self employed",
  ].map((n) => bare(n)),
);
export const isPlaceholder = (name: string) => PLACEHOLDERS.has(bare(name));

/** "Brindle Learning, Inc." → "brindlelearning": the key every name of a company is stored under. */
export function nameKey(name: string): string {
  return bare(name.trim());
}

const parse = <T>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};
export const fundingOf = (c: Pick<Company, "funding">) => parse<Funding>(c.funding);
export const applyEmailOf = (c: Pick<Company, "apply_email">) => parse<ApplyEmail>(c.apply_email);
export const watchSources = (c: Pick<Company, "watch_sources">) => parse<string[]>(c.watch_sources) ?? [];

export function getCompany(id: number): Company | null {
  return open().query("SELECT * FROM companies WHERE id = ?").get(id) as Company | null;
}

/** By its domain, or a domain it had before two rows of it became one (kept as "@domain" among its names). */
export function companyByDomain(domain: string): Company | null {
  return (
    (open().query("SELECT * FROM companies WHERE domain = ?").get(domain) as Company | null) ??
    (open()
      .query("SELECT c.* FROM company_names n JOIN companies c ON c.id = n.company_id WHERE n.name_key = ?")
      .get(`@${domain}`) as Company | null)
  );
}

export function companyByName(name: string): Company | null {
  const key = nameKey(name);
  if (!key) return null;
  return open()
    .query("SELECT c.* FROM company_names n JOIN companies c ON c.id = n.company_id WHERE n.name_key = ?")
    .get(key) as Company | null;
}

export function watchedCompanies(): Company[] {
  return open()
    .query("SELECT * FROM companies WHERE watched_at IS NOT NULL ORDER BY name COLLATE NOCASE")
    .all() as Company[];
}

/**
 * The thread a company's Apply opens. Threads are named by domain; a company known only by name
 * gets a stand-in (`acme.no-domain`) that Work recognizes and won't research.
 */
export function threadIdOf(c: Pick<Company, "id" | "name" | "domain">): string {
  if (c.domain) return c.domain;
  const slug = c.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || `company-${c.id}`}.no-domain`;
}

/** The company a thread is about: by its domain, or the one whose stand-in it is (by the name its
 * log gives, once that company has a domain). */
export function companyOfThread(thread: string): Company | null {
  if (!isStandIn(thread)) return companyByDomain(thread);
  const all = open().query("SELECT * FROM companies WHERE domain IS NULL").all() as Company[];
  const named = () => {
    const company = read(thread).find((e) => e.data?.company)?.data.company;
    return typeof company === "string" ? companyByName(company) : null;
  };
  return all.find((c) => threadIdOf(c) === thread) ?? named();
}

function nameTo(id: number, name: string): void {
  const key = nameKey(name);
  if (key)
    open().query("INSERT OR IGNORE INTO company_names (name_key, company_id) VALUES (?, ?)").run(key, id);
}

/**
 * Fold `drop` into `keep`: its names, boards, roles and signals move; what keep doesn't know it
 * takes (a domain, a funding line, an apply address); then drop goes. Used only when two names
 * turn out to be one company on a proven domain (one domain; a shared board whose companies'
 * domains are one site; a name seen first without its domain, or with one only looked up). A
 * proven domain wins over a looked-up one, a real name over one that's just the domain
 * ("Google", not "google.com"), and a Dismiss on either row over neither, unless one is watched.
 */
export function mergeCompanies(keep: number, drop: number, why: string): void {
  if (keep === drop) return;
  tx(() => {
    const d = open();
    const a = getCompany(keep);
    const b = getCompany(drop);
    if (!a || !b) return;
    // Each merge is traced: which row went into which, why, and whether you had dismissed the one that went.
    event("merge", a.name, `${b.name} (${drop}) merged into ${a.name} (${keep}): ${why}`, {
      keep,
      drop,
      dropDismissed: !!b.dismissed_at,
    });
    for (const t of ["company_names", "boards", "roles", "signals"])
      d.query(`UPDATE ${t} SET company_id = ? WHERE company_id = ?`).run(keep, drop);
    d.query("UPDATE companies SET domain = NULL WHERE id = ?").run(drop);
    const site = !a.domain || (lookedUp(a) && b.domain && !lookedUp(b)) ? b : a;
    const other = site === a ? b : a;
    // The stated domain that goes still finds the company (AWS's aws.amazon.com, on Amazon's
    // board); a looked-up one was never the company's.
    if (other.domain && other.domain !== site.domain && !lookedUp(other))
      d.query("INSERT OR REPLACE INTO company_names (name_key, company_id) VALUES (?, ?)").run(
        `@${other.domain}`,
        keep,
      );
    const sources = [...new Set([...watchSources(a), ...watchSources(b)])];
    const min = (x: string | null, y: string | null) => (x && y ? (x < y ? x : y) : (x ?? y));
    const max = (x: string | null, y: string | null) => (x && y ? (x > y ? x : y) : (x ?? y));
    d.query(
      `UPDATE companies SET name = $name, domain = $domain, domain_from = $from, created_at = $created, last_signal_at = $last,
         watched_at = $watched, watch_sources = $sources, dismissed_at = $dismissed, apply_email = $email,
         funding = $funding, careers_url = $careers, discovery = $discovery, hidden_at = $hidden WHERE id = $id`,
    ).run({
      id: keep,
      name: isDomainName(a.name) && !isDomainName(b.name) ? b.name : a.name,
      domain: site.domain,
      from: site.domain ? (site.domain_from ?? null) : null,
      created: min(a.created_at, b.created_at),
      last: max(a.last_signal_at, b.last_signal_at),
      watched: min(a.watched_at, b.watched_at),
      sources: sources.length ? JSON.stringify(sources) : null,
      // Your Dismiss on the row that goes stays, unless the company is watched.
      dismissed: a.dismissed_at ?? (a.watched_at || b.watched_at ? null : b.dismissed_at),
      email: a.apply_email ?? b.apply_email,
      funding: a.funding ?? b.funding,
      careers: a.careers_url ?? b.careers_url,
      discovery: hasBoard(keep) ? "found" : (a.discovery ?? b.discovery),
      // Hidden on Signals when either was.
      hidden: a.hidden_at ?? b.hidden_at ?? null,
    });
    d.query("DELETE FROM companies WHERE id = ?").run(drop);
  });
}

const hasBoard = (id: number) =>
  !!open().query("SELECT 1 FROM boards WHERE company_id = ? AND status = 'ok' LIMIT 1").get(id);

/**
 * The company a signal names: by its domain when it has one, else by its name. A name seen
 * before without a domain, or with one only looked up, now with a proven one, is the same
 * company: the two rows become one, with the proven domain. A domain only looked up never makes
 * two rows one.
 */
export function upsertCompany(
  o: { name?: string | null; domain?: string | null; from?: DomainFrom },
  now = new Date(),
): number {
  const from = o.from ?? "stated";
  let domain: string | null = null;
  if (o.domain)
    try {
      domain = threadId(o.domain);
    } catch {}
  const given = o.name?.trim();
  const name = (given && !isPlaceholder(given) ? given : null) || domain;
  if (!name) throw new Error("A company needs a name or a domain");
  return tx(() => {
    const d = open();
    const byDomain = domain ? companyByDomain(domain) : null;
    const byName = companyByName(name);
    const replaces = (c: Company) => !c.domain || (from !== "looked up" && lookedUp(c));
    if (byDomain) {
      if (from !== "looked up" && byDomain.domain === domain && lookedUp(byDomain)) {
        d.query("UPDATE companies SET domain_from = ? WHERE id = ?").run(from, byDomain.id);
        byDomain.domain_from = from;
      }
      // The name's row joins the domain's only when the domain is proven, and this lead's own
      // domain isn't one only looked up (a fund's or a GitHub organisation's website), as giveDomain.
      if (
        byName &&
        byName.id !== byDomain.id &&
        from !== "looked up" &&
        replaces(byName) &&
        proven(byDomain)
      ) {
        mergeCompanies(byDomain.id, byName.id, `the name's row joins ${domain}'s`);
      } else if (!byName) nameTo(byDomain.id, name);
      return byDomain.id;
    }
    if (byName) {
      if (!domain) return byName.id;
      if (replaces(byName)) {
        d.query("UPDATE companies SET domain = ?, domain_from = ? WHERE id = ?").run(domain, from, byName.id);
        return byName.id;
      }
      // Two companies by one name ("Unknown"): the name stays with the first.
    }
    const r = d
      .query("INSERT INTO companies (name, domain, domain_from, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .get(name, domain, domain ? from : null, now.toISOString()) as { id: number };
    if (!byName) nameTo(r.id, name);
    return r.id;
  });
}

/**
 * A company's boards are read soon; with none, it joins the discovery queue. One already looked
 * at and left without one rejoins it when this signal links a job board none of its other
 * signals named: once per board, so a board robots.txt refuses doesn't requeue it every week.
 */
export function wake(companyId: number, now = new Date(), signalId?: number): void {
  const d = open();
  const due = d
    .query(
      "UPDATE boards SET next_read_at = $now WHERE company_id = $id AND status = 'ok' AND (next_read_at IS NULL OR next_read_at > $now)",
    )
    .run({ id: companyId, now: now.toISOString() });
  if (due.changes || hasBoard(companyId)) return;
  d.query(
    "UPDATE companies SET discovery = 'queued' WHERE id = ? AND (discovery IS NULL OR discovery = 'found')",
  ).run(companyId);
  if (signalId !== undefined && newBoardLink(companyId, signalId))
    d.query(
      "UPDATE companies SET discovery = 'queued' WHERE id = ? AND discovery IN ('none', 'unreadable', 'blocked')",
    ).run(companyId);
}

/** Does this signal link a job board (as discovery's hint takes one) that none of the company's other signals named? */
function newBoardLink(companyId: number, signalId: number): boolean {
  const d = open();
  const root = (url: string) => (ATS_URL.test(url) ? boardRoot(url)?.toLowerCase() : null) ?? null;
  const s = d.query("SELECT url FROM signals WHERE id = ?").get(signalId) as { url: string } | null;
  const board = s ? root(s.url) : null;
  if (!board) return false;
  const others = d
    .query("SELECT url FROM signals WHERE company_id = ? AND id <> ?")
    .all(companyId, signalId) as { url: string }[];
  return !others.some((o) => root(o.url) === board);
}

export type SignalResult = "added" | "duplicate" | "dismissed" | "stale" | "pending";

/**
 * Keep a signal as received and wake its company. A signal whose company can't be told by rule
 * is kept with no company; the classifier names it later.
 */
export function recordSignal(
  lead: Lead & { ref?: string },
  now = new Date(),
): { result: SignalResult; companyId?: number; signalId?: number } {
  const url = normalizeUrl(lead.url);
  const ref = lead.ref ?? url;
  const d = open();
  if (d.query("SELECT 1 FROM signals WHERE ref = ?").get(ref)) return { result: "duplicate" };
  if (lead.kind === "posting" && lead.posted_at && lead.max_age_days !== null) {
    const ageDays = (now.getTime() - Date.parse(lead.posted_at)) / DAY;
    if (ageDays > (lead.max_age_days ?? loadConfig().postings.max_age_days)) return { result: "stale" };
  }
  const domain = companyDomain(lead);
  const hint = lead.company_hint?.trim();
  // A hint that's no name ("?", punctuation, "Unknown") names nothing: the classifier decides.
  const name = hint && nameKey(hint) && !isPlaceholder(hint) && !isDomainName(hint) ? hint : domain;
  return tx(() => {
    const companyId =
      name || domain
        ? upsertCompany({ name, domain, ...(lead.domain_from ? { from: lead.domain_from } : {}) }, now)
        : null;
    const s = d
      .query(
        `INSERT INTO signals (source, source_tag, ref, company_id, name, domain, title, location, url, text,
           author, kind, note, posted_at, received_at, arrived_at)
         VALUES ($source, $tag, $ref, $company, $name, $domain, $title, $location, $url, $text,
           $author, $kind, $note, $posted, $received, $received) RETURNING id`,
      )
      .get({
        source: lead.source,
        tag: lead.source_tag,
        ref,
        company: companyId,
        name: hint ?? null,
        domain,
        title: lead.title ?? null,
        location: lead.location ?? null,
        url,
        // An HN post runs to 1,500 characters and its board link is often last.
        text: lead.text?.slice(0, lead.source === "hn" ? 1500 : 1000) ?? null,
        author: lead.author ?? null,
        kind: lead.kind ?? "post",
        note: lead.note?.slice(0, 300) ?? null,
        posted: lead.posted_at ?? lead.seen_at ?? null,
        received: now.toISOString(),
      }) as { id: number };
    if (companyId === null) return { result: "pending" as const, signalId: s.id };
    d.query("UPDATE companies SET last_signal_at = max(coalesce(last_signal_at, ''), ?) WHERE id = ?").run(
      now.toISOString(),
      companyId,
    );
    markChanged(now);
    // An HN post of the company's own naming an address on its domain: it takes applications there.
    const email =
      lead.source === "hn" && lead.text && domain ? applyEmailIn(lead.text, domain, "post") : null;
    if (email)
      d.query("UPDATE companies SET apply_email = ? WHERE id = ? AND apply_email IS NULL").run(
        JSON.stringify({ address: email, page: url }),
        companyId,
      );
    if (lead.funding) setFunding(companyId, lead.funding);
    const c = getCompany(companyId)!;
    if (c.dismissed_at) return { result: "dismissed" as const, companyId, signalId: s.id };
    wake(companyId, now, s.id);
    return { result: "added" as const, companyId, signalId: s.id };
  });
}

/** Attach a signal that waited with no company (the classifier named it). */
export function placeSignal(
  signalId: number,
  o: { name?: string; domain?: string | null },
  now = new Date(),
): number {
  const companyId = upsertCompany(o, now);
  tx(() => {
    open()
      .query("UPDATE signals SET company_id = ? WHERE id = ? AND company_id IS NULL")
      .run(companyId, signalId);
    open()
      .query("UPDATE companies SET last_signal_at = max(coalesce(last_signal_at, ''), ?) WHERE id = ?")
      .run(now.toISOString(), companyId);
    markChanged(now);
  });
  wake(companyId, now, signalId);
  return companyId;
}

/** Watch: one UPDATE. It also undoes a Dismiss, and the company's boards count as active. */
export function watchCompany(id: number, source: string, now = new Date()): boolean {
  const r = open()
    .query(
      `UPDATE companies SET watched_at = coalesce(watched_at, $now), dismissed_at = NULL,
         watch_sources = CASE
           WHEN watch_sources IS NULL THEN json_array($source)
           WHEN EXISTS (SELECT 1 FROM json_each(watch_sources) WHERE value = $source) THEN watch_sources
           ELSE json_insert(watch_sources, '$[#]', $source) END
       WHERE id = $id`,
    )
    .run({ id, source, now: now.toISOString() });
  if (r.changes) wake(id, now);
  return r.changes > 0;
}

export function unwatchCompany(id: number): boolean {
  return (
    open()
      .query(
        "UPDATE companies SET watched_at = NULL, watch_sources = NULL WHERE id = ? AND watched_at IS NOT NULL",
      )
      .run(id).changes > 0
  );
}

/** Dismiss a company: it leaves the Inbox, and whatever it posts later stays out. */
export function dismissCompany(id: number, now = new Date()): boolean {
  return (
    open()
      .query("UPDATE companies SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL")
      .run(now.toISOString(), id).changes > 0
  );
}

/** A Form D filing: kept on the company when it's newer than the one it has. */
export function setFunding(id: number, f: Funding): boolean {
  return (
    open()
      .query(
        `UPDATE companies SET funding = $f WHERE id = $id
         AND (funding IS NULL OR coalesce(json_extract(funding, '$.date'), '') < $date)`,
      )
      .run({ id, f: JSON.stringify(f), date: f.date }).changes > 0
  );
}

/** A company's signals, newest first. */
export function signalsOf(companyId: number, limit = 20) {
  return open()
    .query("SELECT * FROM signals WHERE company_id = ? ORDER BY received_at DESC, id DESC LIMIT ?")
    .all(companyId, limit) as Signal[];
}

export type Signal = {
  id: number;
  source: string;
  source_tag: string;
  ref: string;
  company_id: number | null;
  name: string | null;
  domain: string | null;
  title: string | null;
  location: string | null;
  url: string;
  text: string | null;
  author: string | null;
  kind: string | null;
  note: string | null;
  posted_at: string | null;
  received_at: string; // when it was received, or the post's own date for an old post filed later
  arrived_at: string | null; // when it reached you (core/db.ts)
  classify_tries: number;
};

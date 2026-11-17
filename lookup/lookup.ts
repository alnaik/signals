// Look up: a person's email, or the people at a company, asked by hand on your own providers.
// Each lookup runs in the server and is kept in the lookups table, so closing the panel (or the
// tab) doesn't stop it; what it found reaches a thread only when you press Save. Paid calls go
// through the registry under station "lookup", each press with its own budget: the most it said
// it could cost. Kept: the last 50 lookups; the emails they found 30 days, unless saved.

import { loadConfig } from "../core/config.ts";
import { DAY, open, tx } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { capLeft } from "../core/ledger.ts";
import { append, threadId } from "../core/log.ts";
import { isStandIn } from "../core/vocab.ts";
import { chooseCompany } from "../inbox/choose.ts";
import { companyByDomain, companyByName, getCompany, upsertCompany } from "../intake/companies.ts";
import { findContact } from "../providers/contact.ts";
import { declaredCost, ordered, people, withRunBudget } from "../providers/registry.ts";
import type { ContactHit, Person, PersonRef } from "../providers/types.ts";

export type Mode = "person" | "people";
export type Inputs = { company: string; name?: string; role?: string; github?: string; titles?: string[] };

/** One person a lookup found or was given, with what Find email turned up. */
export type Found = Person & {
  hits?: ContactHit[];
  steps?: string[];
  usd?: number;
  finding?: boolean; // Find email going now
  saved?: string; // the thread it was saved to
  dropped?: boolean; // its emails went after 30 days
};
export type Results = {
  company: { id: number | null; name: string; domain: string };
  people: Found[];
  skipped?: string[];
  error?: string;
  presses?: number; // Find email presses in this lookup
};
export type Lookup = {
  id: number;
  mode: Mode;
  inputs: Inputs;
  status: "running" | "done" | "failed";
  results: Results | null;
  usd: number;
  started_at: string;
  finished_at: string | null;
  seen_at: string | null;
  line?: string; // what it is doing now
};
export type Quote = { upTo: number; left: number; cap: number; slow: boolean };
/** What the server tells the board as a lookup goes: a progress line, then a toast at the end. */
export type Events = { progress: (id: number, line: string | null) => void; done: (text: string) => void };

const KEEP = 50;
const EMAIL_DAYS = 30;
const FREE_PRESSES = 3; // Find email presses in one lookup before each asks first
const quiet: Events = { progress: () => {}, done: () => {} };
const lines = new Map<number, string>();

type Row = Omit<Lookup, "inputs" | "results"> & { inputs: string; results: string | null };
const parse = (r: Row): Lookup => ({
  ...r,
  inputs: JSON.parse(r.inputs),
  results: r.results ? JSON.parse(r.results) : null,
  ...(lines.has(r.id) ? { line: lines.get(r.id) } : {}),
});

export function getLookup(id: number): Lookup | null {
  const r = open().query("SELECT * FROM lookups WHERE id = ?").get(id) as Row | null;
  return r ? parse(r) : null;
}

/** Read, change and write one lookup at once: two Find emails ending together both land. */
function update(id: number, fn: (l: Lookup) => void): Lookup {
  return tx(() => {
    const l = getLookup(id)!;
    fn(l);
    open()
      .query("UPDATE lookups SET status = ?, results = ?, usd = ?, finished_at = ?, seen_at = ? WHERE id = ?")
      .run(l.status, JSON.stringify(l.results), l.usd, l.finished_at, l.seen_at, id);
    return l;
  });
}

/** The company typed: a domain (or link), or the name of a company known here that has one. */
export function resolveCompany(text: string): Results["company"] {
  const t = text.trim();
  if (!t) throw new Error("A company is needed: a name known here, or its domain");
  if (!/\s/.test(t) && t.includes(".")) {
    let domain: string;
    try {
      domain = threadId(t);
    } catch {
      throw new Error(`"${t}" isn't a domain`);
    }
    if (isStandIn(domain)) throw new Error("That company has no website known here: type its domain");
    const c = companyByDomain(domain);
    return { id: c?.id ?? null, name: c?.name ?? domain, domain };
  }
  const c = companyByName(t);
  if (!c) throw new Error(`No company called "${t}" here: type its domain (acme.dev)`);
  if (!c.domain) throw new Error(`${c.name} has no website known here: type its domain`);
  return { id: c.id, name: c.name, domain: c.domain };
}

const personRef = (p: Person, domain: string, github?: string): PersonRef => ({
  name: p.name,
  role: p.role,
  profile_urls: p.profile_urls,
  source: p.source,
  domain,
  ...(github ? { github } : {}),
});

/** The most one press could cost (every paid provider in the order asked), and the month's room. */
export async function quote(mode: Mode, i: Partial<Inputs>): Promise<Quote> {
  let domain = "";
  try {
    domain = resolveCompany(i.company ?? "").domain;
  } catch {}
  const cap = mode === "people" ? "people" : "contact";
  const args =
    mode === "people"
      ? [domain, i.titles ?? [], i.company]
      : [personRef({ name: i.name ?? "", role: i.role ?? "", profile_urls: [], source: "lookup" }, domain)];
  const list = await ordered(cap);
  const upTo = list.reduce((n, p) => n + Math.max(0, declaredCost(p, cap, args) ?? 0), 0);
  return {
    upTo,
    left: capLeft(),
    cap: loadConfig().caps.month_usd,
    slow: cap === "contact" && list.some((p) => p.name === "exa"),
  };
}

/** The lookups for the panel: running ones first, then the rest, newest first. */
export function recent(): { lookups: Lookup[]; unseen: number } {
  const rows = open()
    .query(
      `SELECT * FROM lookups ORDER BY status = 'running' DESC, coalesce(finished_at, started_at) DESC LIMIT ${KEEP}`,
    )
    .all() as Row[];
  return { lookups: rows.map(parse), unseen: unseen() };
}

export const unseen = () =>
  (
    open().query("SELECT count(*) AS n FROM lookups WHERE status <> 'running' AND seen_at IS NULL").get() as {
      n: number;
    }
  ).n;

export function markSeen(now = new Date()): void {
  open()
    .query("UPDATE lookups SET seen_at = ? WHERE status <> 'running' AND seen_at IS NULL")
    .run(now.toISOString());
}

/** The last 50 kept; emails found more than 30 days ago dropped, unless saved to a thread. */
export function prune(now = new Date()): { deleted: number; dropped: number } {
  const d = open();
  const deleted = d
    .query(`DELETE FROM lookups WHERE id NOT IN (SELECT id FROM lookups ORDER BY id DESC LIMIT ${KEEP})`)
    .run().changes;
  const before = new Date(now.getTime() - EMAIL_DAYS * DAY).toISOString();
  let dropped = 0;
  const old = d
    .query("SELECT id FROM lookups WHERE finished_at < ? AND results LIKE '%\"email\"%'")
    .all(before) as { id: number }[];
  for (const { id } of old)
    update(id, (l) => {
      for (const p of l.results?.people ?? []) {
        if (p.saved || !p.hits?.some((h) => h.channel === "email")) continue;
        p.hits = p.hits.filter((h) => h.channel !== "email");
        p.dropped = true;
        dropped++;
      }
    });
  return { deleted, dropped };
}

/** A lookup the server was running when it stopped: said so, never left "running". */
export function stopInterrupted(now = new Date()): number {
  const ids = open().query("SELECT id FROM lookups WHERE status = 'running'").all() as { id: number }[];
  for (const { id } of ids)
    update(id, (l) => {
      l.status = "failed";
      l.finished_at = now.toISOString();
      l.results ??= { company: { id: null, name: l.inputs.company, domain: "" }, people: [] };
      const r = l.results;
      r.error = "stopped: the board restarted";
      for (const p of r.people) delete p.finding;
    });
  return ids.length;
}

const emailWord = (hits: ContactHit[] = []) => {
  const e = hits.find((h) => h.channel === "email");
  return e ? `${e.value} (${e.confidence})` : "no email";
};

/** Start a lookup; it runs on after this returns. A bad input throws, with what to type instead. */
export function startLookup(
  mode: Mode,
  raw: Partial<Inputs>,
  ev: Events = quiet,
  now = new Date(),
): { id: number; done: Promise<void> } {
  const company = resolveCompany(raw.company ?? "");
  const inputs: Inputs = { company: (raw.company ?? "").trim() };
  if (mode === "person") {
    inputs.name = (raw.name ?? "").trim();
    inputs.role = (raw.role ?? "").trim();
    const gh = (raw.github ?? "").trim().replace(/^@/, "");
    if (gh) inputs.github = gh;
    if (!inputs.name) throw new Error("A name is needed");
  } else {
    inputs.titles = (raw.titles ?? []).map((t) => t.trim()).filter(Boolean);
    if (!inputs.titles.length) throw new Error("At least one title is needed (CTO, Head of Engineering)");
  }
  const results: Results = { company, people: [] };
  const { id } = open()
    .query(
      "INSERT INTO lookups (mode, inputs, status, results, started_at) VALUES (?, ?, 'running', ?, ?) RETURNING id",
    )
    .get(mode, JSON.stringify(inputs), JSON.stringify(results), now.toISOString()) as { id: number };
  prune(now);
  const done = (mode === "person" ? runPerson(id, inputs, company, ev) : runPeople(id, inputs, company, ev))
    .catch((err) => {
      update(id, (l) => {
        l.status = "failed";
        l.finished_at = new Date().toISOString();
        l.results!.error = (err as Error).message.slice(0, 200);
      });
      ev.done(`Look up failed: ${(err as Error).message.slice(0, 120)}`);
    })
    .finally(() => {
      lines.delete(id);
      ev.progress(id, null);
    });
  return { id, done };
}

/** Find one person's channels through the contact waterfall, inside the press's own budget. */
async function contactOf(id: number, p: PersonRef, ev: Events) {
  const q = await quote("person", { company: p.domain, name: p.name, role: p.role });
  const say = (line: string) => {
    lines.set(id, line);
    ev.progress(id, line);
  };
  return withRunBudget(q.upTo, () =>
    findContact(p, { station: "lookup" }, (pr) =>
      say(`asking ${pr.label}${pr.name === "exa" ? " · its agent can take up to 3 min" : ""}`),
    ),
  );
}

async function runPerson(id: number, i: Inputs, c: Results["company"], ev: Events): Promise<void> {
  const p = personRef(
    { name: i.name!, role: i.role ?? "", profile_urls: [], source: "you" },
    c.domain,
    i.github,
  );
  const { result, spent, skipped } = await contactOf(id, p, ev);
  update(id, (l) => {
    l.status = "done";
    l.finished_at = new Date().toISOString();
    l.usd += spent;
    l.results!.people = [
      { name: p.name, role: p.role, profile_urls: [], source: "you", hits: result.hits, steps: result.steps },
    ];
    if (skipped.length) l.results!.skipped = skipped;
  });
  ev.done(`Look up · ${p.name} at ${c.name}: ${emailWord(result.hits)}`);
}

async function runPeople(id: number, i: Inputs, c: Results["company"], ev: Events): Promise<void> {
  const q = await quote("people", { company: c.domain, titles: i.titles });
  lines.set(id, `looking for ${i.titles!.join(", ")} at ${c.name}`);
  ev.progress(id, lines.get(id)!);
  const { result, spent, skipped } = await withRunBudget(q.upTo, () =>
    people(c.domain, i.titles!, { station: "lookup" }, c.name),
  );
  const found = (result.result ?? []).slice(0, 25);
  update(id, (l) => {
    l.status = "done";
    l.finished_at = new Date().toISOString();
    l.usd += spent;
    l.results!.people = found;
    if (skipped.length) l.results!.skipped = skipped;
    if (!found.length)
      l.results!.error = result.steps.some((s) => s.error)
        ? `No one found: ${result.steps.map((s) => `${s.provider}: ${s.error ?? "none"}`).join("; ")}`.slice(
            0,
            300,
          )
        : "No one found";
  });
  ev.done(`Look up · ${c.name}: ${found.length} ${found.length === 1 ? "person" : "people"}`);
}

/**
 * Find email for one person a People lookup found. The first three presses in a lookup go at once;
 * each after asks first (`ask`), and goes with `confirm`.
 */
export function findEmail(
  id: number,
  n: number,
  confirm = false,
  ev: Events = quiet,
): { ask: string } | { done: Promise<void> } {
  const l = getLookup(id);
  const p = l?.results?.people[n];
  if (l?.mode !== "people" || !p) throw new Error("That person isn't in this lookup");
  if (p.finding) throw new Error(`Already finding ${p.name}'s email`);
  const presses = l.results!.presses ?? 0;
  if (presses >= FREE_PRESSES && !confirm)
    return { ask: `That's Find email ${presses + 1} in this lookup. Go on?` };
  update(id, (x) => {
    x.status = "running";
    x.finished_at = null;
    x.seen_at = null;
    x.results!.presses = presses + 1;
    x.results!.people[n]!.finding = true;
  });
  const ref = personRef(p, l.results!.company.domain);
  const done = contactOf(id, ref, ev)
    .then(({ result, spent, skipped }) => {
      update(id, (x) => {
        const q = x.results!.people[n]!;
        delete q.finding;
        q.hits = result.hits;
        q.steps = result.steps;
        q.usd = (q.usd ?? 0) + spent;
        x.usd += spent;
        if (skipped.length) x.results!.skipped = [...new Set([...(x.results!.skipped ?? []), ...skipped])];
        if (!x.results!.people.some((y) => y.finding)) {
          x.status = "done";
          x.finished_at = new Date().toISOString();
        }
      });
      ev.done(`Look up · ${p.name}: ${emailWord(result.hits)}`);
    })
    .catch((err) => {
      update(id, (x) => {
        delete x.results!.people[n]!.finding;
        x.results!.error = (err as Error).message.slice(0, 200);
        if (!x.results!.people.some((y) => y.finding)) {
          x.status = "done";
          x.finished_at = new Date().toISOString();
        }
      });
      ev.done(`Look up failed: ${(err as Error).message.slice(0, 120)}`);
    })
    .finally(() => {
      lines.delete(id);
      ev.progress(id, null);
    });
  return { done };
}

/**
 * Save one person a lookup found to the company's thread: a contact entry, as Work's gather writes
 * it, which makes the thread "person found". The thread is opened first if the company has none.
 */
export function saveFound(
  id: number,
  n: number,
  now = new Date(),
): { ok: true; toast: string; thread: string } | { ok: false; status: number; toast: string } {
  const l = getLookup(id);
  const p = l?.results?.people[n];
  if (!l || !p) return { ok: false, status: 404, toast: "That person isn't in this lookup" };
  if (p.finding) return { ok: false, status: 409, toast: `Still finding ${p.name}'s email` };
  const c = l.results!.company;
  const companyId =
    (c.id !== null && getCompany(c.id)?.id) ||
    companyByDomain(c.domain)?.id ||
    upsertCompany({ name: c.name === c.domain ? null : c.name, domain: c.domain, from: "hand" }, now);
  const opened = chooseCompany(companyId, "work", now);
  if (!opened.ok || !opened.thread) return { ok: false, status: 409, toast: opened.toast };
  const thread = opened.thread;
  append(thread, {
    actor: "lookup",
    kind: "contact",
    ts: now.toISOString(),
    // You named the person yourself (verified); a people search's find is a lead (pattern).
    data: {
      name: p.name,
      role: p.role,
      confidence: l.mode === "person" ? "verified" : "pattern",
      channels: p.hits ?? [],
    },
  });
  index.reindex(thread);
  update(id, (x) => {
    x.results!.people[n]!.saved = thread;
  });
  return { ok: true, toast: `Saved ${p.name} to ${c.name}: the thread is now "person found"`, thread };
}

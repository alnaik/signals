// Review titles: roles in your places whose title names a job but has none of your title words
// (Score's `review`, kept on each role), grouped, biggest first. Add puts a group's phrase in
// your title words (every open role is scored again, and those roles fit from now); Not mine
// stops offering the group (filters.title_skip), and changes no score. Nothing becomes a fit
// without your press. Your title words are listed too, each with its record, and Drop takes one
// out of them (filters.title_dropped).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadFilters, reviewTitle, workMode } from "../ats/filters.ts";
import { DAY, getMeta, open, setMeta } from "../core/db.ts";
import { paths } from "../core/paths.ts";
import { ensureScored } from "../intake/refresh.ts";
import { cameAt, EXPIRE_DAYS, shortPlace, sinceWatched } from "./query.ts";

export type TitleGroup = {
  key: string; // the group, as kept on its roles: "Data Engineer + science", "security engineer"
  phrase: string; // what its titles say there, the commonest form ("Data Science Engineer"): what Add adds; "" when they say it in many orders
  like: string | null; // the phrase of yours it is close to, tier 1 only
  tier: 1 | 2 | 3; // 1 close to a phrase of yours; 2 another job that builds; 3 any other job
  roles: number;
  titles: string[]; // a few of its titles, newest first
  fresh: boolean; // first seen since you last opened Review titles
};

// A group's job word that builds things: the second tier. Anything else (manager, analyst,
// consultant, director …) is the third, shown folded.
const BUILD = /(^| )(engineer\w*|developer|programmer|scientist|architect|research\w*|technical staff)$/;
const SAMPLES = 3;
const LISTED = 200; // a group's roles listed when it is opened

/** One role in an opened group: its own Add puts its exact title in your title words. */
export type TitleRole = {
  id: number;
  title: string;
  company: string;
  location: string; // in full: the place's tooltip
  place: string; // short (shortPlace)
  mode: string;
  url: string;
};

/** The roles Review titles counts: open, not fitting, a group not skipped, at a company not dismissed, not decided. */
const pool = `FROM roles r JOIN companies c ON c.id = r.company_id
  WHERE r.closed_at IS NULL AND r.fits = 0 AND r.review IS NOT NULL
    AND c.dismissed_at IS NULL AND r.state IN ('new', 'archived')
    AND r.review NOT IN (SELECT value FROM json_each($skip))`;
const skipped = () => ({ skip: JSON.stringify(loadFilters().title_skip ?? []) });

/** A group close to a phrase of yours ("Data Engineer + science", "AI Engineer (any order)") or another job that builds: tiers 1 and 2. */
const likely = (key: string) => key.includes(" + ") || key.endsWith("(any order)") || BUILD.test(key);

/**
 * The Inbox's line: how many roles might be yours, in how many groups, how many groups are new.
 * Tiers 1 and 2 only: the third (managers, analysts, consultants …) is most of the roles (19,211 of
 * 28,145 on 2026-11-17) and is the least likely yours; Review titles still lists it, folded.
 */
export function reviewCount(): { roles: number; groups: number; fresh: number } {
  ensureScored();
  const rows = open()
    .query(`SELECT r.review AS key, count(*) AS n, min(r.first_seen) AS first ${pool} GROUP BY r.review`)
    .all(skipped()) as { key: string; n: number; first: string }[];
  const seen = getMeta("review_seen_at");
  const out = { roles: 0, groups: 0, fresh: 0 };
  for (const g of rows) {
    if (!likely(g.key)) continue;
    out.roles += g.n;
    out.groups++;
    if (seen && g.first > seen) out.fresh++;
  }
  return out;
}

/**
 * Every group, biggest first within its tier. Measured 2026-11-17 on the live data: 29,452 roles
 * in 7,719 groups, read and grouped in about 0.1 s. `seen`: you are looking now, so groups new
 * since are counted from here on.
 */
export function reviewTitles(o: { seen?: boolean } = {}, now = new Date()): TitleGroup[] {
  ensureScored();
  const f = loadFilters();
  const rows = open()
    .query(`SELECT r.review, r.title, r.first_seen ${pool} ORDER BY r.first_seen DESC`)
    .all(skipped()) as { review: string; title: string; first_seen: string }[];
  const seen = getMeta("review_seen_at");
  const groups = new Map<string, { titles: string[]; first: string; roles: number }>();
  for (const r of rows) {
    const g = groups.get(r.review) ?? { titles: [], first: r.first_seen, roles: 0 };
    g.roles++;
    if (r.first_seen < g.first) g.first = r.first_seen;
    if (g.titles.length < 20 && !g.titles.includes(r.title)) g.titles.push(r.title);
    groups.set(r.review, g);
  }
  if (o.seen) setMeta("review_seen_at", now.toISOString());
  const out: TitleGroup[] = [];
  for (const [key, g] of groups) {
    // The phrase its titles say most, and the phrase of yours it is close to.
    const said = new Map<string, number>();
    let like: string | null = null;
    for (const t of g.titles) {
      const r = reviewTitle(t, f);
      if (!r || r.key !== key) continue;
      like = r.like;
      said.set(r.phrase, (said.get(r.phrase) ?? 0) + 1);
    }
    // Your words in another order ("Engineer, Applied AI") say no one phrase: nothing to add.
    const phrase = key.endsWith("(any order)")
      ? ""
      : ([...said.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key);
    out.push({
      key,
      phrase,
      like,
      tier: like ? 1 : BUILD.test(key) ? 2 : 3,
      roles: g.roles,
      titles: g.titles.slice(0, SAMPLES),
      fresh: !!seen && g.first > seen,
    });
  }
  return out.sort((a, b) => a.tier - b.tier || b.roles - a.roles || a.phrase.localeCompare(b.phrase));
}

/**
 * A group's roles, newest first, the first 200 of `total`: what opening it on the page lists. The
 * roles reviewTitles counts, so one that fits after an Add leaves.
 */
export function groupRoles(key: string): { roles: TitleRole[]; total: number } {
  ensureScored();
  const d = open();
  const at = { ...skipped(), key };
  const rows = d
    .query(
      `SELECT r.id, r.title, c.name AS company, r.location, r.mode, r.url ${pool} AND r.review = $key
       ORDER BY r.first_seen DESC, r.id DESC LIMIT ${LISTED}`,
    )
    .all(at) as Omit<TitleRole, "place">[];
  const { n } = d.query(`SELECT count(*) AS n ${pool} AND r.review = $key`).get(at) as { n: number };
  const yours = loadFilters();
  return {
    roles: rows.map((r) => ({
      ...r,
      place: shortPlace(workMode({ title: r.title, location: r.location }).place, yours),
    })),
    total: n,
  };
}

/** The profile's filters as written (not loadFilters': its `remote_ok` stays as the file has it). */
function profile(): { file: string; p: { filters?: Record<string, unknown> } } {
  const file = paths.me("profile.json");
  return { file, p: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {} };
}
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** Not mine: the group is no longer offered. Its roles keep their group; search still finds them. */
export function skipTitle(key: string): void {
  const { file, p } = profile();
  const f = p.filters ?? {};
  const skip = listOf(f.title_skip);
  if (!skip.includes(key)) p.filters = { ...f, title_skip: [...skip, key] };
  writeFileSync(file, JSON.stringify(p, null, 2));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The title words with this phrase added at the end (as Settings lists them), and taken off the
 * words you dropped; null when it is there.
 */
export function withTitle(phrase: string): { title_include: string[]; title_dropped?: string[] } | null {
  const f = profile().p.filters ?? {};
  const list = listOf(f.title_include);
  if (list.some((w) => same(w, phrase))) return null;
  const dropped = listOf(f.title_dropped);
  const kept = dropped.filter((w) => !same(w, phrase));
  return {
    title_include: [...list, phrase.trim()],
    ...(kept.length < dropped.length ? { title_dropped: kept } : {}),
  };
}

/**
 * The title words without this one, and it among the words you dropped (so its titles aren't
 * offered here again); null when it isn't one of yours.
 */
export function withoutTitle(word: string): { title_include: string[]; title_dropped: string[] } | null {
  const f = profile().p.filters ?? {};
  const list = listOf(f.title_include);
  const kept = list.filter((w) => !same(w, word));
  if (kept.length === list.length) return null;
  const dropped = listOf(f.title_dropped).filter((w) => !same(w, word));
  return { title_include: kept, title_dropped: [...dropped, word.trim()] };
}

// A role (r, of company c) in the Inbox, as the Inbox lists it (query.ts): new to you, fitting,
// open, come in the last 21 days, since you watched its company, at a company not dismissed.
const inInbox = `r.state = 'new' AND r.fits = 1 AND r.closed_at IS NULL AND ${cameAt("r.")} >= $cutoff
  AND ${sinceWatched(cameAt("r."), "c.watched_at")} AND (c.watched_at IS NOT NULL OR c.dismissed_at IS NULL)`;
const cutoff = (now: Date) => ({ cutoff: new Date(now.getTime() - EXPIRE_DAYS * DAY).toISOString() });

/** How many roles are in the Inbox. */
export const inboxRoles = (now = new Date()): number =>
  (
    open()
      .query(`SELECT count(*) AS n FROM roles r JOIN companies c ON c.id = r.company_id WHERE ${inInbox}`)
      .get(cutoff(now)) as { n: number }
  ).n;

/** One of your title words and its record: roles it brings to the Inbox now, and those you applied to and dismissed. */
export type TitleWord = { word: string; inbox: number; applied: number; dismissed: number };

/**
 * Your title words, most Inbox roles first; a word that matched nothing has zeros. A role counts
 * under the word it matched (Score's `matched`, the word before " · "): in the Inbox as the Inbox
 * shows it (query.ts), applied and dismissed whether open or closed.
 */
export function titleWords(now = new Date()): TitleWord[] {
  ensureScored();
  const rows = open()
    .query(
      `SELECT CASE WHEN instr(r.matched, ' · ') > 0 THEN substr(r.matched, 1, instr(r.matched, ' · ') - 1)
           ELSE r.matched END AS word,
         sum(${inInbox}) AS inbox, sum(r.state = 'applied') AS applied, sum(r.state = 'dismissed') AS dismissed
       FROM roles r JOIN companies c ON c.id = r.company_id
       WHERE r.matched IS NOT NULL GROUP BY word`,
    )
    .all(cutoff(now)) as TitleWord[];
  const by = new Map(rows.map((r) => [r.word, r]));
  const words = [
    ...new Set(
      listOf(loadFilters().title_include)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];
  return words
    .map((word) => {
      const r = by.get(word);
      return { word, inbox: r?.inbox ?? 0, applied: r?.applied ?? 0, dismissed: r?.dismissed ?? 0 };
    })
    .sort((a, b) => b.inbox - a.inbox);
}

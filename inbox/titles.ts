// Review titles: roles in your places whose title names a job but has none of your title words
// (Score's `review`, kept on each role), grouped, biggest first. Add puts a group's phrase in
// your title words (every open role is scored again, and those roles fit from now); Not mine
// stops offering the group (filters.title_skip), and changes no score. Nothing becomes a fit
// without your press.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadFilters, reviewTitle } from "../ats/filters.ts";
import { getMeta, open, setMeta } from "../core/db.ts";
import { paths } from "../core/paths.ts";
import { ensureScored } from "../intake/refresh.ts";

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

/** The roles Review titles counts: open, not fitting, a group not skipped, at a company not dismissed, not decided. */
const pool = `FROM roles r JOIN companies c ON c.id = r.company_id
  WHERE r.closed_at IS NULL AND r.fits = 0 AND r.review IS NOT NULL
    AND c.dismissed_at IS NULL AND r.state IN ('new', 'archived')
    AND r.review NOT IN (SELECT value FROM json_each($skip))`;
const skipped = () => ({ skip: JSON.stringify(loadFilters().title_skip ?? []) });

/** The Inbox's line: how many roles might be yours, in how many groups, how many groups are new. */
export function reviewCount(): { roles: number; groups: number; fresh: number } {
  ensureScored();
  const r = open()
    .query(`SELECT count(*) AS roles, count(DISTINCT review) AS groups FROM (SELECT r.review ${pool})`)
    .get(skipped()) as { roles: number; groups: number };
  const seen = getMeta("review_seen_at");
  const fresh = seen
    ? (
        open()
          .query(
            `SELECT count(*) AS n FROM (SELECT r.review ${pool} GROUP BY r.review HAVING min(r.first_seen) > $seen)`,
          )
          .get({ ...skipped(), seen }) as { n: number }
      ).n
    : 0;
  return { ...r, fresh };
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

/** The title words with this phrase added at the end (as Settings lists them), or null when it is there. */
export function withTitle(phrase: string): string[] | null {
  const list = listOf(profile().p.filters?.title_include);
  return list.some((w) => w.trim().toLowerCase() === phrase.trim().toLowerCase())
    ? null
    : [...list, phrase.trim()];
}

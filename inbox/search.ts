// The Inbox's search box: which companies and roles a few typed words find. Every word typed must
// start a word of the text (any order, case and accents ignored): "robo" finds Robotics, "rust"
// doesn't find Trust. A typo is forgiven in company names only, and only when nothing matched as
// typed ("antrhopic" finds Anthropic). Roles are those you can still act on: open, fitting, new or
// archived. One pass in memory per request (about 20 ms on 14,000 roles); no index to keep.
import { DAY, open } from "../core/db.ts";
import { EXPIRE_DAYS } from "./query.ts";

export function normalise(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const words = (s: string): string[] => normalise(s).split(" ").filter(Boolean);

/** Every token starts some word. */
export function prefixMatch(text: string[], tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => text.some((w) => w.startsWith(t)));
}

/** At most `max` edits apart (insert, delete, substitute, swap two neighbours). */
export function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]! <= max;
}

/** Every token of 4 letters or more is a word of the text with a typo or two (8 or more: two). */
export function fuzzyMatch(text: string[], tokens: string[]): boolean {
  return (
    tokens.length > 0 &&
    tokens.every((t) => t.length >= 4 && text.some((w) => near(t, w, t.length >= 8 ? 2 : 1)))
  );
}

export type Hits = {
  companies: number[]; // every company the words find, by name or by a role or signal
  names: Set<number>; // found by name: their rows and roles are as without a search
  roles: Map<number, number[]>; // found by a role: these role ids, the ones its row opens to
  titles: Map<number, string[]>; // what matched, roles first, for the row
};

export function searchHits(q: string, o: { remote?: boolean } = {}, now = new Date()): Hits {
  const tokens = words(q);
  const d = open();
  const names = new Set<number>();
  const roles = new Map<number, number[]>();
  const titles = new Map<number, string[]>();
  if (!tokens.length) return { companies: [], names, roles, titles };

  // Companies: the name, its other names (kept squashed: "37signals"), the domain's first label.
  const companies = d.query("SELECT id, name, domain FROM companies").all() as {
    id: number;
    name: string;
    domain: string | null;
  }[];
  const keys = new Map<number, string[]>();
  for (const r of d.query("SELECT company_id, name_key FROM company_names").all() as {
    company_id: number;
    name_key: string;
  }[])
    keys.set(r.company_id, [...(keys.get(r.company_id) ?? []), r.name_key]);
  const squashed = tokens.join("");
  const text = (c: (typeof companies)[number]) => [
    ...words(c.name),
    ...(c.domain ? words(c.domain.split(".")[0]!) : []),
  ];
  for (const c of companies)
    if (prefixMatch(text(c), tokens) || (keys.get(c.id) ?? []).some((k) => k.startsWith(squashed)))
      names.add(c.id);
  if (names.size === 0) for (const c of companies) if (fuzzyMatch(text(c), tokens)) names.add(c.id);

  const add = (company: number, title: string) => {
    const t = titles.get(company) ?? [];
    if (!t.includes(title)) titles.set(company, [...t, title]);
  };
  const rows = d
    .query(
      `SELECT id, company_id, title FROM roles
       WHERE closed_at IS NULL AND fits = 1 AND state IN ('new', 'archived')
         ${o.remote ? "AND mode = 'remote'" : ""}`,
    )
    .all() as { id: number; company_id: number; title: string }[];
  for (const r of rows) {
    if (!prefixMatch(words(r.title), tokens)) continue;
    roles.set(r.company_id, [...(roles.get(r.company_id) ?? []), r.id]);
    add(r.company_id, r.title);
  }
  // A company only a signal named has no roles: its signal's title is what there is to find.
  const signals = d
    .query(
      `SELECT company_id, title FROM signals
       WHERE company_id IS NOT NULL AND title IS NOT NULL AND received_at >= ?`,
    )
    .all(new Date(now.getTime() - EXPIRE_DAYS * DAY).toISOString()) as {
    company_id: number;
    title: string;
  }[];
  const bySignal = new Set<number>();
  for (const s of signals)
    if (prefixMatch(words(s.title), tokens)) {
      bySignal.add(s.company_id);
      if (!roles.has(s.company_id)) add(s.company_id, s.title);
    }
  return { companies: [...new Set([...names, ...roles.keys(), ...bySignal])], names, roles, titles };
}

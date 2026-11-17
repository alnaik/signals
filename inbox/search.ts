// The Inbox's search box: which open roles a few typed words find, at any company, fitting or not,
// in any state. Every word must be found somewhere in the role: its company's name (or other
// names, or its website's first label), its title, its place, or its kept description. Words are
// read as titles are (ats/filters.ts tokenise): case, accents, punctuation, plural and the usual
// short forms don't matter ("Full-Stack" is "full stack", "ML" is "machine learning"); small words
// (and, of, the …) and "&" are left out. A word of three letters or more matches where a word
// starts ("robo" finds Robotics, "rust" doesn't find Trust); a shorter one, the whole word, except
// in a company's name. "Two words" in quotes must stand together; -word leaves out the roles with
// it. A US state's name also finds its code in a title or place and the other way round (a code
// typed in capitals: "CO"); never in a description, where pay-transparency notes name them all.
// Measured 2026-11-17 on 156,251 open roles: the first search after a change about 0.4 s (each
// role's words read once, kept until intake changes something), the next ones 20 to 60 ms.
import { CODES, STATES, tokenise, variants } from "../ats/filters.ts";
import { DAY, getMeta, open } from "../core/db.ts";
import { EXPIRE_DAYS } from "./query.ts";

/** A text's words, as titles are read (ats/filters.ts tokenise). */
export const words = (s: string): string[] => tokenise(s).t;

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

// --- what was typed --------------------------------------------------------------------

type Term = {
  said: string; // as typed, for the lines that name it
  toks: string[]; // folded words, standing together
  not: boolean; // -word: no role with it
  quoted: boolean;
  alts: string[][]; // other words that count in a title or place (a state's name for its code)
  code: string | null; // a state's code in capitals, in a title or place
};

const STATE_TOKS = Object.entries(STATES).map(([name, code]) => ({ toks: tokenise(name).t, code }));
const CODE_NAME = new Map(STATE_TOKS.map((s) => [s.code, s.toks]));

/** The typed words as terms: "phrases" and -words first, then a state's name taken as one. */
export function terms(q: string): Term[] {
  const out: Term[] = [];
  const add = (said: string, not: boolean, quoted: boolean) => {
    const toks = tokenise(said).t;
    if (toks.length) out.push({ said, toks, not, quoted, alts: [], code: null });
  };
  const rest = q
    .trim()
    .slice(0, 80)
    .replace(/(^|\s)(-?)"([^"]*)"?/g, (_, sp: string, not: string, phrase: string) => {
      add(phrase, not === "-", true);
      return sp;
    });
  for (const w of rest.split(/\s+/).filter(Boolean)) {
    const not = w.length > 1 && w.startsWith("-");
    const said = not ? w.slice(1) : w;
    add(said, not, false);
    // A code typed in capitals ("CO") is a state's.
    const t = out.at(-1);
    if (t?.said === said && /^[A-Z]{2}$/.test(said) && CODES.has(said) && !not) {
      t.code = said;
      t.alts = [CODE_NAME.get(said)!];
    }
  }
  // A state's name, of one word or more ("new york"): one term, its code counts too.
  for (let i = 0; i < out.length; i++)
    for (let k = 3; k >= 1; k--) {
      const run = out.slice(i, i + k);
      if (run.length < k || run.some((t) => t.not || t.quoted || t.code)) continue;
      const toks = run.flatMap((t) => t.toks);
      const s = STATE_TOKS.find((x) => x.toks.join(" ") === toks.join(" "));
      if (!s) continue;
      out.splice(i, k, {
        said: run.map((t) => t.said).join(" "),
        toks,
        not: false,
        quoted: false,
        alts: [],
        code: s.code,
      });
      break;
    }
  return out;
}

// --- each open role's words, kept --------------------------------------------------------

type Row = { id: number; company: number; fits: boolean; title: string; place: string; codes: string };
type Table = {
  mark: string;
  rows: Row[];
  companies: Map<number, string>; // every name's words, one sentinel string
  firsts: Map<number, string[]>; // each name's words on its own (" deloitte consulting "): where a name starts
  names: Map<number, string>;
};
// Sentinel strings (" senior backend engineer "): a word found by `includes`, no arrays to keep.
const line = (s: string) => ` ${tokenise(s).t.join(" ")} `;
const codesIn = (s: string) => {
  const found = [...s.matchAll(/\b([A-Z]{2})\b/g)].map((m) => m[1]!).filter((c) => CODES.has(c));
  return found.length ? ` ${found.join(" ")} ` : "";
};

let table: Table | null = null;
// A role's words read once: kept by id while its title and place are the same.
const known = new Map<number, { title: string; location: string; t: string; p: string; c: string }>();

/** The open roles' words, read again when intake changed something (meta intake_changed_at). */
function load(): Table {
  const mark = `${getMeta("intake_changed_at") ?? ""}|${getMeta("filters") ?? ""}`;
  if (table?.mark === mark) return table;
  const d = open();
  const rows = d
    .query("SELECT id, company_id, fits, title, location FROM roles WHERE closed_at IS NULL")
    .all() as { id: number; company_id: number; fits: number; title: string; location: string }[];
  const out: Row[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    let k = known.get(r.id);
    if (!k || k.title !== r.title || k.location !== r.location) {
      k = {
        title: r.title,
        location: r.location,
        t: line(r.title),
        p: line(r.location),
        c: codesIn(`${r.title} ${r.location}`),
      };
      known.set(r.id, k);
    }
    seen.add(r.id);
    out.push({ id: r.id, company: r.company_id, fits: r.fits === 1, title: k.t, place: k.p, codes: k.c });
  }
  for (const id of known.keys()) if (!seen.has(id)) known.delete(id);
  // A company: its name, its other names (kept squashed: "37signals") and its website's first label.
  const companies = new Map<number, string>();
  const firsts = new Map<number, string[]>();
  const names = new Map<number, string>();
  for (const c of d.query("SELECT id, name, domain FROM companies").all() as {
    id: number;
    name: string;
    domain: string | null;
  }[]) {
    names.set(c.id, c.name);
    const each = [line(c.name), ...(c.domain ? [line(c.domain.split(".")[0]!)] : [])];
    firsts.set(c.id, each);
    companies.set(c.id, each.join(""));
  }
  for (const r of d.query("SELECT company_id, name_key FROM company_names").all() as {
    company_id: number;
    name_key: string;
  }[]) {
    companies.set(r.company_id, `${companies.get(r.company_id) ?? ""}${line(r.name_key)}`);
    firsts.set(r.company_id, [...(firsts.get(r.company_id) ?? []), line(r.name_key)]);
  }
  table = { mark, rows: out, companies, firsts, names };
  return table;
}

// --- one search ----------------------------------------------------------------------------

const within = (field: string, toks: string[], prefix: boolean) => {
  const j = toks.join(" ");
  return prefix && toks.at(-1)!.length >= 3 ? field.includes(` ${j}`) : field.includes(` ${j} `);
};

/** The FTS5 query for a term: each form it can take, quoted (typed text never reaches MATCH). */
function ftsQuery(t: Term): string | null {
  const one = (w: string, prefix: boolean) => `"${w}"${prefix && w.length >= 3 ? "*" : ""}`;
  const form = (ws: string[], prefix = true) =>
    ws.length === 1
      ? one(ws[0]!, prefix)
      : `NEAR(${ws.map((w) => one(w, prefix)).join(" ")}, ${ws.length - 1})`;
  const forms = new Set<string>();
  const split = (s: string) => s.toLowerCase().match(/[a-z0-9]+[+#]*/g) ?? [];
  if (t.quoted || t.toks.length > 1) forms.add(form(t.toks));
  else {
    const as = [t.said.toLowerCase(), t.toks.join(" ")];
    for (const v of variants(t.said)) {
      const ws = split(v);
      // A short form of a word ("sr" for senior, "eng" for engineer) as the whole word only.
      if (ws.length) forms.add(form(ws, as.includes(v)));
    }
  }
  return forms.size ? [...forms].join(" OR ") : null;
}

const ftsKept = new Map<string, Set<number>>();
/** The roles whose kept description has the term. */
function described(t: Term, mark: string): Set<number> {
  const q = ftsQuery(t);
  if (!q) return new Set();
  const key = `${mark}|${q}`;
  let ids = ftsKept.get(key);
  if (!ids) {
    ids = new Set(
      (
        open().query("SELECT rowid AS id FROM role_fts WHERE role_fts MATCH ?").all(q) as { id: number }[]
      ).map((r) => r.id),
    );
    if (ftsKept.size > 200) ftsKept.clear();
    ftsKept.set(key, ids);
  }
  return ids;
}

export type Found = {
  terms: string[]; // the words searched, as typed
  roles: Map<number, number[]>; // company -> the roles found there
  fits: Map<number, number>; // company -> how many of those fit
  companies: number[]; // in order: found by name first, then the most roles that fit, then the most roles
  named: number[]; // the companies the most particular word names (at most 5): the read offer's
  total: number;
  fitting: number;
  // A word that leaves no or few roles: how many there are without it, and a company name it
  // may have meant ("Did you mean Deloitte?").
  missing: { word: string; anywhere: boolean; without: number; meant: string | null } | null;
  // The company found by a role's title, not its name: what matched, for its row.
  titles: Map<number, string[]>;
  signals: Set<number>; // companies only a recent signal's title found (no role)
  // Found roles whose words (the company's name aside) stand together, as typed: first in their
  // company, after those that fit ("deloitte ai and data": the AI & Data team's roles).
  together: Set<number>;
};

const found = new Map<string, Found>();

/** Find the roles the words name; kept for the same words until intake changes something. */
const none = (): Found => ({
  terms: [],
  roles: new Map(),
  fits: new Map(),
  companies: [],
  named: [],
  total: 0,
  fitting: 0,
  missing: null,
  titles: new Map(),
  signals: new Set(),
  together: new Set(),
});

export function search(q: string, now = new Date()): Found {
  if (!terms(q).some((t) => !t.not)) return none(); // nothing to look for: -words alone find nothing
  const tb = load();
  const key = `${tb.mark}|${q.trim()}`;
  const kept = found.get(key);
  if (kept) return kept;
  const ts = terms(q);
  const pos = ts.filter((t) => !t.not);
  const neg = ts.filter((t) => t.not);
  // Per term: the companies its word names, and the roles whose description has it.
  const byName = ts.map((t) => {
    const s = new Set<number>();
    // In a name a short word matches where a word starts too: "co" finds Cohere; a state's code
    // typed in capitals is a place, no name.
    if (!(t.code && t.code === t.said))
      for (const [id, name] of tb.companies) if (name.includes(` ${t.toks.join(" ")}`)) s.add(id);
    return s;
  });
  const text = ts.map((t) => (t.code ? new Set<number>() : described(t, tb.mark)));
  const hit = (t: Term, i: number, r: Row) =>
    byName[i]!.has(r.company) ||
    within(r.title, t.toks, true) ||
    within(r.place, t.toks, true) ||
    t.alts.some((a) => within(r.title, a, true) || within(r.place, a, true)) ||
    (!!t.code && r.codes.includes(` ${t.code} `)) ||
    text[i]!.has(r.id);
  const full = (1 << pos.length) - 1;
  const anywhere = pos.map(() => 0);
  const without = pos.map(() => 0);
  const roles = new Map<number, number[]>();
  const fits = new Map<number, number>();
  const titles = new Map<number, string[]>();
  let total = 0;
  let fitting = 0;
  const posAt = pos.map((t) => ts.indexOf(t));
  const negAt = neg.map((t) => ts.indexOf(t));
  if (pos.length)
    for (const r of tb.rows) {
      if (neg.some((t, k) => hit(t, negAt[k]!, r))) continue;
      let mask = 0;
      for (let k = 0; k < pos.length; k++) if (hit(pos[k]!, posAt[k]!, r)) mask |= 1 << k;
      for (let k = 0; k < pos.length; k++) {
        if (mask & (1 << k)) anywhere[k]!++;
        else if ((mask | (1 << k)) === full) without[k]!++;
      }
      if (mask !== full) continue;
      total++;
      if (r.fits) fitting++;
      roles.set(r.company, [...(roles.get(r.company) ?? []), r.id]);
      if (r.fits) fits.set(r.company, (fits.get(r.company) ?? 0) + 1);
    }
  // What a role's row says matched: its title, when a word found it there.
  if (roles.size) {
    const ids = [...roles.values()].flat();
    const d = open();
    for (const r of d
      .query(
        "SELECT company_id, title FROM roles WHERE id IN (SELECT value FROM json_each(?)) ORDER BY fits DESC",
      )
      .all(JSON.stringify(ids.slice(0, 5000))) as { company_id: number; title: string }[]) {
      const t = titles.get(r.company_id) ?? [];
      if (t.length < 3 && !t.includes(r.title)) titles.set(r.company_id, [...t, r.title]);
    }
  }
  // A company only a recent signal names, with no role: its signal's title is what there is to find.
  const signals = new Set<number>();
  if (pos.length && !neg.length) {
    const recent = open()
      .query(
        `SELECT company_id, title FROM signals
         WHERE company_id IS NOT NULL AND title IS NOT NULL AND received_at >= ?`,
      )
      .all(new Date(now.getTime() - EXPIRE_DAYS * DAY).toISOString()) as {
      company_id: number;
      title: string;
    }[];
    for (const s of recent) {
      if (roles.has(s.company_id) || signals.has(s.company_id)) continue;
      const w = line(s.title);
      if (pos.every((t, k) => byName[posAt[k]!]!.has(s.company_id) || within(w, t.toks, true))) {
        signals.add(s.company_id);
        titles.set(s.company_id, [s.title]);
      }
    }
  }
  // The most particular word that names a company: "deloitte" names one, "data" fifty.
  // A name it starts: "software" in "Veeam Software" names no company.
  const best = pos
    .filter((t) => !t.code)
    .map((t) => {
      const w = ` ${t.toks.join(" ")}`;
      const ids = [...byName[ts.indexOf(t)]!].filter((id) => tb.firsts.get(id)!.some((f) => f.startsWith(w)));
      return { t, ids: new Set(ids) };
    })
    .filter((x) => x.ids.size > 0 && x.ids.size <= 5)
    .sort((a, b) => a.ids.size - b.ids.size)[0];
  const naming = best?.ids;
  const named = naming ? [...naming] : [];
  const ranked = [...roles.keys(), ...signals].sort(
    (a, b) =>
      Number(naming?.has(b) ?? 0) - Number(naming?.has(a) ?? 0) ||
      (fits.get(b) ?? 0) - (fits.get(a) ?? 0) ||
      (roles.get(b)?.length ?? 0) - (roles.get(a)?.length ?? 0) ||
      (tb.names.get(a) ?? "").localeCompare(tb.names.get(b) ?? ""),
  );
  // A word that leaves nothing, or few: the one whose leaving out finds the most.
  let missing: Found["missing"] = null;
  if (pos.length && total < 5) {
    const k = without.reduce((best, n, i) => (n > (without[best] ?? 0) ? i : best), 0);
    const t = pos[k]!;
    if ((pos.length > 1 && without[k]! > total) || anywhere[k] === 0) {
      let meant: string | null = null;
      // Found nowhere: a company's name with a typo or two?
      if (anywhere[k] === 0 && t.toks.length === 1 && t.toks[0]!.length >= 4) {
        const w = t.toks[0]!;
        const cands = [...tb.names].filter(([id]) => fuzzyMatch(words(tb.names.get(id)!), [w]));
        const held = (id: number) => tb.rows.reduce((n, r) => n + (r.company === id ? 1 : 0), 0);
        if (cands.length)
          meant = cands.map(([id, name]) => ({ name, n: held(id) })).sort((a, b) => b.n - a.n)[0]!.name;
      }
      missing = {
        word: t.said,
        anywhere: anywhere[k]! > 0,
        without: pos.length > 1 ? without[k]! : 0,
        meant,
      };
    }
  }
  const together = new Set<number>();
  const rest = pos.filter((t) => !t.code && t !== best?.t);
  if (rest.length >= 2 && total) {
    const toks = rest.flatMap((t) => t.toks);
    const near = described(
      { said: toks.join(" "), toks, not: false, quoted: true, alts: [], code: null },
      tb.mark,
    );
    const got = new Set([...roles.values()].flat());
    for (const r of tb.rows)
      if (got.has(r.id) && (near.has(r.id) || within(r.title, toks, true))) together.add(r.id);
  }
  const out: Found = {
    terms: ts.map((t) => (t.not ? `-${t.said}` : t.said)),
    roles,
    fits,
    companies: ranked,
    named,
    total,
    fitting,
    missing,
    titles,
    signals,
    together,
  };
  if (found.size > 50) found.clear();
  found.set(key, out);
  return out;
}

/**
 * The companies whose name has every word (or whose other name starts with them squashed:
 * "37 signals"), else, when none does, those with a typo or two in it. The Signals screen's search.
 */
export function namesFound(q: string): Set<number> {
  const tokens = words(q);
  const names = new Set<number>();
  if (!tokens.length) return names;
  const d = open();
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
  return names;
}

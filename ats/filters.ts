// Location, remote and title filters from me/profile.json, applied to postings.
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../core/paths.ts";

export type PostingFilters = {
  locations?: string[]; // any match passes, e.g. ["London", "United Kingdom"]
  metros?: Record<string, string[]>; // the Inbox's city switch: the locations grouped, e.g. {"Colorado": ["Denver", "Boulder", "CO"]}
  remote_ok?: boolean; // remote postings pass regardless of location; missing means they do (remoteOk)
  title_include?: string[];
  title_exclude?: string[];
  // Review titles' Not mine: groups (Score's `review`) no longer offered. Not an exclusion, and
  // not part of what scoring reads (intake/refresh.ts filtersKey leaves it out).
  title_skip?: string[];
};

/**
 * Are remote roles fine? Only an explicit `false` says no: a profile that never set it (first run
 * saved none until 2026-11-12) means yes, as Settings and first run show it ticked.
 */
export const remoteOk = (f: PostingFilters): boolean => f.remote_ok !== false;

/** The profile's filters, `remote_ok` always set (remoteOk), so scoring and its key see one value. */
export function loadFilters(): PostingFilters {
  const file = paths.me("profile.json");
  let f: PostingFilters = {};
  if (existsSync(file))
    try {
      f = JSON.parse(readFileSync(file, "utf8")).filters ?? {};
    } catch {}
  return { ...f, remote_ok: remoteOk(f) };
}

// A filter word matches where a word starts ("Unity" not in "Community"), so a stem like
// "Prototyp" still catches "Prototyping". Short words match whole words only: "AR" must not
// match "Architect", nor "US" "USA Today". Edges that aren't letters (".NET", "C++") match as is.
function wordRe(n: string, flags = "i"): RegExp | null {
  const w = n.trim();
  if (!w) return null;
  const start = /^\w/.test(w) ? "\\b" : "";
  const end = w.length <= 3 && /\w$/.test(w) ? "\\b" : "";
  return new RegExp(`${start}${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${end}`, flags);
}
type Words = { word: string; re: RegExp }[];
const compileWords = (list: string[] = [], codes = false): Words =>
  list.flatMap((word) => {
    const re = wordRe(word, codes && /^[A-Z]{2}$/.test(word.trim()) ? "" : "i");
    return re ? [{ word: word.trim(), re }] : [];
  });
const first = (hay: string, words: Words) => words.find((w) => w.re.test(hay))?.word;

// Countries and Canada's provinces a role's place may name: a US city's name there is another
// place (Cambridge, UK; Durham, England; San Jose, Costa Rica), so such a role doesn't fit someone
// who picked the US city. Measured 2026-11-12 on 125,625 open roles: 68 fit only that way.
const ABROAD = new RegExp(
  `\\b(${[
    "united kingdom",
    "uk",
    "england",
    "scotland",
    "wales",
    "ireland",
    "canada",
    "india",
    "germany",
    "france",
    "netherlands",
    "spain",
    "portugal",
    "italy",
    "poland",
    "romania",
    "bulgaria",
    "serbia",
    "croatia",
    "greece",
    "czech( republic)?",
    "czechia",
    "hungary",
    "austria",
    "switzerland",
    "belgium",
    "denmark",
    "norway",
    "sweden",
    "finland",
    "estonia",
    "latvia",
    "lithuania",
    "ukraine",
    "turkey",
    "israel",
    "uae",
    "united arab emirates",
    "dubai",
    "saudi arabia",
    "egypt",
    "nigeria",
    "kenya",
    "south africa",
    "australia",
    "new zealand",
    "singapore",
    "malaysia",
    "indonesia",
    "philippines",
    "vietnam",
    "thailand",
    "japan",
    "korea",
    "taiwan",
    "china",
    "hong kong",
    "pakistan",
    "bangladesh",
    "sri lanka",
    "brazil",
    "mexico",
    "argentina",
    "chile",
    "colombia",
    "peru",
    "uruguay",
    "costa rica",
    "ontario",
    "british columbia",
    "quebec",
    "alberta",
    "nova scotia",
    "manitoba",
    "lincolnshire",
  ].join("|")})\\b`,
  "i",
);
const US = /(^|[^a-z])(us|usa|u\.s\.(a\.)?)(?![a-z])|\bunited states\b/i;

/**
 * Does a role's place name one of these words? A place often lists several ("Boulder, CO · San
 * Jose, CA"; "Cambridge, MA; London, UK"): each part on its own, any of them counts. With `us`
 * (the profile's places are American) a part that names another country or a Canadian province,
 * and not the US, is that country's: "Cambridge, United Kingdom" isn't Cambridge, MA. A code in
 * capitals ("CO") matches only in capitals: "Co. Dublin" isn't Colorado.
 */
function atPlace(location: string, words: Words, us: boolean): string | undefined {
  for (const part of location.split(/\s*(?:[;|·•\n]|\s\/\s|\s+or\s+)\s*/)) {
    const w = first(part, words);
    if (w && !(us && ABROAD.test(part) && !US.test(part))) return w;
  }
  return undefined;
}

/**
 * A place that names no city, only the US or how the role is worked ("United States", "USA",
 * "Hybrid", "On-site"): to an American profile it says no more than a blank one, and passes as
 * one does (shown "location unknown"). 239 fitting roles said "United States" alone, 2026-11-12.
 */
function noCity(location: string): boolean {
  const rest = location
    .replace(HYBRID_ALL, "")
    .replace(ONSITE_ALL, "")
    .replace(/\b(united states( of america)?|usa?|u\.s\.(a\.)?)(?![a-z])/gi, "");
  return !/\p{L}/u.test(rest);
}

/**
 * Does a role's location name one of a city's words (`metros`)? As the location filter matches;
 * `us`: the profile's places are American (usPlaces).
 */
const metroWords = new WeakMap<string[], Words>();
export function inMetro(location: string, words: string[], us = false): boolean {
  let w = metroWords.get(words);
  if (!w) {
    w = compileWords(
      words.filter((x) => typeof x === "string"),
      true,
    );
    metroWords.set(words, w);
  }
  return !!atPlace(location, w, us);
}

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

const REMOTE = /\b(remote|anywhere|distributed|wfh|telecommut\w*|work from home)\b/i;
const HYBRID = /\bhybrid\b/i;
const ONSITE = /\b(on[-\s]?site|in[-\s]?office|in[-\s]?person)\b/i;
// The same, for every place they stand (made once: scoring reads every open role).
const REMOTE_ALL = new RegExp(REMOTE.source, "gi");
const HYBRID_ALL = new RegExp(HYBRID.source, "gi");
const ONSITE_ALL = new RegExp(ONSITE.source, "gi");

/**
 * Remote, hybrid or on-site from the posting's location, then its title ("Software Developer -
 * WFH", location "United States"), then the start of its text when neither says. `place` is the
 * location without the mode words, for display only: dedupe keys on `location`, so it is never
 * written back.
 */
export function workMode(job: { location?: string; title: string; description?: string }): {
  mode: WorkMode;
  place: string;
} {
  const loc = job.location ?? "";
  const place = loc
    .replace(REMOTE_ALL, "")
    .replace(HYBRID_ALL, "")
    .replace(ONSITE_ALL, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:/|·–—-]+|[\s,;:/|·–—-]+$/g, "");
  const mode = ((): WorkMode => {
    if (REMOTE.test(loc)) return "remote";
    if (HYBRID.test(loc)) return "hybrid";
    if (ONSITE.test(loc)) return "onsite";
    // Titles say remote or hybrid; "distributed" in a title is about systems, not the office.
    if (/\b(remote|wfh|work from home)\b/i.test(job.title)) return "remote";
    if (HYBRID.test(job.title)) return "hybrid";
    const text = (job.description ?? "").slice(0, 1000);
    if (/\b(not|no|non)[-\s]?remote\b/i.test(text)) return "onsite";
    if (/\bhybrid\b|\d\s*days?\s*(a|per)\s*week\s*in\b/i.test(text)) return "hybrid";
    if (/\b(fully|100%) remote\b|this (role|position) is (fully )?remote\b/i.test(text)) return "remote";
    if (ONSITE.test(text)) return "onsite";
    return "unknown";
  })();
  return { mode, place };
}

// --- title words ----------------------------------------------------------------------
// One tokeniser for titles, the title words and the Inbox's search: letters and digits, accents
// dropped, case ignored; "+" and "#" stay at a word's end (c++, c#). Each word is folded the same
// way on both sides, so "Full-Stack" is "Full Stack", "Solution Architect" is "Solutions
// Architect" and "Sr. SW Engineer" is "Senior Software Engineer". Measured 2026-11-17 on 156,232
// open roles: 742 more fit in your places, 29 fewer, all by your own exclusions ("Software
// Engineering Mgr" is an "Engineering Manager"); scoring every one takes about 0.3 s, as before.

const MARKS = /[̀-ͯ]/g;
// What stood between two words. 0: a blank, hyphen or dot ("Full-Stack", "Sr. Engineer"): they
// are adjacent. 1: "/", "&", "+" or a small word: alternatives ("Product & Engineering" is not a
// "Product Engineer"). 2: a hard boundary, before and after are different things ("Security
// Engineer, Infrastructure"; "Engineer II - Backend").
const HARD = /[,;:|()[\]{}–—]|\s-\s|\s-$|^-\s/;
const SOFT = /[^a-z0-9\s.'’-]/;
const STOP = new Set(["and", "of", "the", "for", "in", "a", "an", "to", "at", "with"]);
// Short forms in titles, each read as what it stands for, on both sides. Kept short: `dev` is
// development, not developer, so "Tech Bus Dev" isn't a Developer and Amazon's "Software Dev
// Engineer" is a "Software Development" role (241 of them, 2026-11-17).
const ABBREV: Record<string, string> = {
  sw: "software",
  dev: "development",
  devt: "development",
  eng: "engineer",
  engr: "engineer",
  swe: "software engineer",
  sde: "software development engineer",
  mle: "machine learning engineer",
  ml: "machine learning",
  mgr: "manager",
  sr: "senior",
  jr: "junior",
  mts: "member of technical staff",
  arch: "architect",
  infra: "infrastructure",
  fullstack: "full stack",
  frontend: "front end",
  backend: "back end",
};
// The misspellings boards make of the words that matter (25 titles in all open roles, 2026-11-17).
const SPELLING: Record<string, string> = {
  enginner: "engineer",
  enginer: "engineer",
  engineeer: "engineer",
  engineerr: "engineer",
  engiener: "engineer",
  enginering: "engineering",
  engneering: "engineering",
  sofware: "software",
  develoer: "developer",
};
// Level and ladder words: never what the job is (the Review list's groups leave them out).
const LEVEL = new Set(
  "senior staff principal lead junior associate i ii iii iv v vi 1 2 3 4 5 6 7 8 9 l3 l4 l5 l6 l7 l8 e3 e4 e5 e6 e7 e8 ic3 ic4 ic5 ic6 p1 p2 p3 p4 p5 p6 mid midlevel distinguished new grad graduate entry".split(
    " ",
  ),
);
/** Plural to singular, both sides: "Systems" is "System". Never on three letters (iOS, AWS) or "-ss". */
const singular = (w: string) => (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/**
 * A text's words, folded (`t`), with what stood before each (`brk`, see HARD), the segment it is
 * in (`seg`: hard breaks counted) and where its word stood in `src` (the text, accents dropped,
 * case kept): `at` to `to`. A short form gives several words at one place ("SW" is "software").
 */
export type Toks = { t: string[]; seg: number[]; brk: number[]; at: number[]; to: number[]; src: string };

const SHORT = new Map(Object.entries(ABBREV).map(([k, v]) => [k, v.split(" ")]));
const FIXED = new Map(Object.entries(SPELLING));
const WORD = /[a-z0-9]+[+#]*/g;

export function tokenise(s: string): Toks {
  // Most titles are plain ASCII: no accents to drop.
  const folded = /^[ -~]*$/.test(s) ? s : s.normalize("NFKD").replace(MARKS, "");
  let low = folded.toLowerCase();
  const src = low.length === folded.length ? folded : low;
  if (/['’]/.test(low)) low = low.replace(/['’]s\b/g, "  "); // "Women's" is "Women", at the same places
  const x: Toks = { t: [], seg: [], brk: [], at: [], to: [], src };
  let n = 0;
  let last = -1;
  let carry = -1; // a small word dropped: the next word's break is at least soft
  const put = (w: string, b: number, at: number) => {
    x.t.push(singular(w));
    x.seg.push(n);
    x.brk.push(b);
    x.at.push(at);
    x.to.push(last);
  };
  WORD.lastIndex = 0;
  for (let m = WORD.exec(low); m; m = WORD.exec(low)) {
    const gap = last < 0 ? "" : low.slice(last, m.index);
    let b = gap === "" || gap === " " ? 0 : HARD.test(gap) ? 2 : SOFT.test(gap) ? 1 : 0;
    if (carry >= 0) b = Math.max(b, carry, 1);
    last = m.index + m[0].length;
    if (STOP.has(m[0])) {
      carry = Math.max(carry, b);
      continue;
    }
    carry = -1;
    if (b === 2) n++;
    const w = FIXED.get(m[0]) ?? m[0];
    const parts = SHORT.get(w);
    if (!parts) {
      put(w, b, m.index);
      continue;
    }
    for (const part of parts) {
      if (STOP.has(part)) {
        b = Math.max(b, 1); // "member of technical staff"
        continue;
      }
      put(part, b, m.index);
      b = 0;
    }
  }
  return x;
}

const REVERSE = new Map<string, string[]>();
for (const [k, v] of Object.entries(ABBREV))
  if (!v.includes(" ")) REVERSE.set(singular(v), [...(REVERSE.get(singular(v)) ?? []), k]);

/**
 * The forms one typed word can take in text that isn't folded (a role's description, searched
 * with SQLite's FTS5): as typed, folded (a short form's words as a phrase: "ml" is also "machine
 * learning"), and the short forms of what it folds to ("senior" is also "sr").
 */
export function variants(word: string): string[] {
  const raw = word.toLowerCase();
  const x = tokenise(raw);
  const out = new Set([raw, x.t.join(" ")]);
  if (x.t.length === 1) for (const s of REVERSE.get(x.t[0]!) ?? []) out.add(s);
  out.delete("");
  return [...out];
}

// What a title names when it names a job, as folded words: a title word that names none
// ("Mobile", "Embedded", "Quest") is a kind of one, and counts only beside one of these ("Mobile
// Engineer", not "Mobile Dog Groomer"). A title word that is or holds one ("Developer", "Data
// Engineer", "SRE") stands alone.
const ROLE_EXACT = new Set(
  "development builder lead leader director head expert relations software devops devrel sre founding ios android"
    .split(" ")
    .map(singular),
);
const ROLE_PAIR: [string, string][] = [
  ["full", "stack"],
  ["front", "end"],
  ["back", "end"],
  ["technical", "staff"],
];
const ROLE_STEM = [
  "engineer",
  "developer",
  "programmer",
  "architect",
  "scientist",
  "research",
  "designer",
  "prototyper",
  "manager",
  "management",
  "specialist",
  "analyst",
  "technologist",
  "consultant",
  "advocate",
  "administrator",
  "intern",
  "tpm",
];
const roleWords = new Map<string, boolean>(); // a word's answer, kept: titles share their words
const isRole = (w: string) => {
  let r = roleWords.get(w);
  if (r === undefined) {
    r = ROLE_EXACT.has(w) || ROLE_STEM.some((s) => w.startsWith(s));
    if (roleWords.size < 100_000) roleWords.set(w, r);
  }
  return r;
};
const pairAt = (t: string[]) => t.findIndex((w, i) => ROLE_PAIR.some(([a, b]) => w === a && t[i + 1] === b));
const hasRole = (t: string[]) => t.some(isRole) || pairAt(t) >= 0;

// A phrase of the owner's that ends in one of these also matches with the others ("Web
// Developer" is a "Web Engineer"; the exclusion "Hardware Engineer" leaves out "Hardware Developer").
const HEADS = ["engineer", "developer", "programmer"];

type Phrase = {
  word: string; // as the owner wrote it
  tok: string[]; // folded words; the last matches where a word starts ("Prototyp"), except a short single word
  brk: number[]; // what the owner wrote between them: "TS/SCI" also matches "TS SCI"; "Full Stack" not "Full/Stack"
  exact: boolean; // one word of three letters or fewer: the whole word ("AR" is not "Architect")
  role: boolean; // names a job by itself; else the title needs a job word too
  i: number; // its place in the list: the first in the owner's order is the one reported
  rank: number; // 0 as written; 1 another form (joined, another job word), reported only when none as written is
};
type Phrases = {
  byFirst: Map<string, Phrase[]>; // phrases of several words and short single words, by their first
  stems: Map<string, Phrase[]>; // single words matched where a word starts, by their first three letters
  byTok: Map<string, Phrase[]>; // phrases of several words by each of their words: what `close` looks for
};

function compilePhrases(list: string[] = []): Phrases {
  const c: Phrases = { byFirst: new Map(), stems: new Map(), byTok: new Map() };
  const put = (m: Map<string, Phrase[]>, k: string, p: Phrase) => m.set(k, [...(m.get(k) ?? []), p]);
  list.forEach((word, i) => {
    const w = typeof word === "string" ? word.trim() : "";
    const x = tokenise(w);
    const tok = x.t;
    if (!tok.length) return;
    const role = hasRole(tok);
    const forms = [tok];
    if (tok.length === 2) forms.push([tok.join("")]); // "Top Secret" is "TopSecret"
    if (tok.length > 1 && HEADS.includes(tok.at(-1)!))
      for (const h of HEADS) if (h !== tok.at(-1)) forms.push([...tok.slice(0, -1), h]);
    for (const f of forms) {
      const p: Phrase = {
        word: w,
        tok: f,
        brk: f.length === tok.length ? x.brk : [0],
        exact: f === tok && tok.length === 1 && w.length <= 3,
        role,
        i,
        rank: f === tok ? 0 : 1,
      };
      if (f.length > 1) for (const t of new Set(f)) put(c.byTok, t, p);
      if (f.length === 1 && !p.exact) put(c.stems, f[0]!.slice(0, 3), p);
      else put(c.byFirst, f[0]!, p);
    }
  });
  return c;
}

/** Does the phrase start at word `i`: its words adjacent and in order, the last where a word starts. */
function phraseAt(x: Toks, i: number, p: Phrase): boolean {
  const n = p.tok.length;
  if (i + n > x.t.length) return false;
  for (let k = 1; k < n; k++) if (x.brk[i + k]! > p.brk[k]!) return false;
  for (let k = 0; k < n - 1; k++) if (x.t[i + k] !== p.tok[k]) return false;
  const last = x.t[i + n - 1]!;
  return p.exact ? last === p.tok[n - 1] : last.startsWith(p.tok[n - 1]!);
}

/** The phrase the words hold, as written before another form, then the first in the owner's order. */
function titleMatch(x: Toks, c: Phrases): Phrase | undefined {
  let best: Phrase | undefined;
  const better = (p: Phrase) => !best || p.rank < best.rank || (p.rank === best.rank && p.i < best.i);
  for (let i = 0; i < x.t.length; i++) {
    const w = x.t[i]!;
    const first = c.byFirst.get(w);
    if (first) for (const p of first) if (better(p) && phraseAt(x, i, p)) best = p;
    const stems = w.length >= 3 && c.stems.size ? c.stems.get(w.slice(0, 3)) : undefined;
    if (stems) for (const p of stems) if (better(p) && w.startsWith(p.tok[0]!)) best = p;
  }
  return best;
}

type Close = { phrase: Phrase; filler: string; from: number; to: number };
/**
 * A phrase of several words the title nearly has: its words in order within one segment, one or
 * two other words between ("Data Science Engineer" is close to "Data Engineer"), the fewest
 * between first; else all its words in one segment in any order ("Distinguished Engineer AI").
 * `filler` is the words between ("" in any order); `from`..`to` the words it spans.
 */
function closeMatch(x: Toks, c: Phrases, gap = 2): Close | undefined {
  const { t, seg } = x;
  const cands = new Set<Phrase>();
  for (const w of t) for (const p of c.byTok.get(w) ?? []) cands.add(p);
  let best: Close | undefined;
  let fewest = gap + 1;
  for (const p of cands) {
    outer: for (let i = 0; i < t.length; i++) {
      if (t[i] !== p.tok[0]) continue;
      let j = i + 1;
      const fill: string[] = [];
      for (let k = 1; k < p.tok.length; k++) {
        let found = -1;
        for (let g = 0; g <= gap && j + g < t.length && seg[j + g] === seg[i]; g++) {
          const w = t[j + g]!;
          if (k === p.tok.length - 1 ? w.startsWith(p.tok[k]!) : w === p.tok[k]) {
            found = j + g;
            break;
          }
        }
        if (found < 0) continue outer;
        fill.push(...t.slice(j, found));
        j = found + 1;
      }
      if (fill.length && (fill.length < fewest || (fill.length === fewest && p.i < best!.phrase.i))) {
        best = { phrase: p, filler: fill.join(" "), from: i, to: j - 1 };
        fewest = fill.length;
      }
      break;
    }
  }
  if (best) return best;
  for (const p of cands) {
    if (best && p.i >= best.phrase.i) continue;
    for (let s = 0; s <= (seg.at(-1) ?? -1); s++) {
      const at = p.tok.map((pt, k) =>
        t.findIndex((w, i) => seg[i] === s && (k === p.tok.length - 1 ? w.startsWith(pt) : w === pt)),
      );
      if (at.every((i) => i >= 0)) {
        best = { phrase: p, filler: "", from: Math.min(...at), to: Math.max(...at) };
        break;
      }
    }
  }
  return best;
}

/**
 * A title's group in the Review list when it is close to none of your phrases: its job word (the
 * last in the first segment that has one: "Research Scientist" is a scientist) and up to two words
 * before it, level and small words left out ("Senior Palantir AI and Data Science Engineer" is
 * "data science engineer"). `from`..`to`: the words it spans.
 */
function headOf(x: Toks): { key: string; from: number; to: number } | null {
  const { t, seg } = x;
  const last = (ok: (w: string) => boolean) => {
    const i = t.findIndex(ok);
    if (i < 0) return -1;
    let j = i;
    for (let k = i + 1; k < t.length && seg[k] === seg[i]; k++) if (ok(t[k]!)) j = k;
    return j;
  };
  let i = last((w) => isRole(w) && !LEVEL.has(w));
  if (i < 0) i = last(isRole);
  if (i < 0) {
    const p = pairAt(t); // "Member of Technical Staff"
    return p < 0 ? null : { key: `${t[p]} ${t[p + 1]}`, from: p, to: p + 1 };
  }
  // Before it in its segment, level words left out; a job word that is one ("Lead") is kept.
  const ks = t.flatMap((w, k) => (seg[k] === seg[i] && k < i && !LEVEL.has(w) ? [k] : [])).slice(-2);
  ks.push(i);
  return { key: ks.map((k) => t[k]).join(" "), from: ks[0]!, to: i };
}

export const head = (x: Toks): string => headOf(x)?.key ?? "";

/**
 * The Review list's group of a title in your places that names a job and has none of your
 * words: "Data Engineer + science" (your phrase, with the words between), "AI Engineer (any
 * order)", else its head ("security engineer"); `phrase` is what the title says there ("Data
 * Science Engineer"), what Add adds. null when the title names no job.
 */
function reviewOf(x: Toks, c: Phrases): { key: string; phrase: string; like: string | null } | null {
  if (!hasRole(x.t)) return null;
  const span = (from: number, to: number) => x.src.slice(x.at[from], x.to[to]).trim();
  const cl = closeMatch(x, c);
  if (cl)
    return {
      key: cl.filler ? `${cl.phrase.word} + ${cl.filler}` : `${cl.phrase.word} (any order)`,
      phrase: span(cl.from, cl.to),
      like: cl.phrase.word,
    };
  const h = headOf(x);
  return h ? { key: h.key, phrase: span(h.from, h.to), like: null } : null;
}

export type Score = {
  fits: boolean;
  matched: string | null;
  // In your places, names a job, none of your words and none you left out: its group in the
  // Review list (reviewOf). null otherwise.
  review: string | null;
};
type Compiled = {
  include: Phrases;
  exclude: Phrases;
  hasInclude: boolean;
  locations: Words;
  remoteOk: boolean;
  us: boolean; // the profile's places are American: a remote role must be open in the US
};
const compiled = new WeakMap<PostingFilters, Compiled>();
function compile(f: PostingFilters): Compiled {
  let c = compiled.get(f);
  if (!c) {
    c = {
      include: compilePhrases(f.title_include),
      exclude: compilePhrases(f.title_exclude),
      hasInclude: (f.title_include ?? []).some((w) => typeof w === "string" && tokenise(w).t.length > 0),
      locations: compileWords(f.locations, true),
      remoteOk: remoteOk(f),
      us: profileStates(f.locations ?? []).length > 0,
    };
    compiled.set(f, c);
  }
  return c;
}

/** The title's word of yours, as a job (a kind of job needs a job word in the title), and the one left out. */
function titleOf(x: Toks, c: Compiled): { out?: string; title?: string } {
  const out = titleMatch(x, c.exclude);
  if (out) return { out: out.word };
  const p = titleMatch(x, c.include);
  return p && (p.role || hasRole(x.t)) ? { title: p.word } : {};
}

// Bumped when `score` changes how it reads a role, so every open role is scored again
// (intake/refresh.ts filtersKey). 5: a near miss keeps its title word. 6: title words matched as
// folded words (tokenise), and `review` set.
export const SCORE_RULES = 6;

/**
 * Is a remote role open in the US? Its location says nothing but how it's worked ("Remote",
 * "Anywhere", "2 Locations"), or names the US: "Remote US", "Remote (Any State)", a state's name or
 * its code in capitals. "Remote Canada", "Germany · Remote" and "Remote - Europe" aren't.
 * Measured 2026-11-01: 464 fitting remote roles were abroad; a city the profile doesn't list with no
 * state ("Remote - Dallas") is the miss, and "IN" (India's code, Indiana's too) passes.
 */
function remoteInUs(location: string): boolean {
  const rest = location
    .replace(REMOTE_ALL, "")
    .replace(HYBRID_ALL, "")
    .replace(ONSITE_ALL, "")
    .replace(/\b(global|worldwide|locations?|\d+\s+(other\s+)?locations?)\b/gi, "")
    .replace(/\b\d{5}(-\d{4})?\b/g, "");
  if (!/\p{L}/u.test(rest)) return true;
  if (/(^|[^a-z])(us|usa|u\.s\.(a\.)?)(?![a-z])/i.test(rest)) return true;
  if (/\b(united states|americas?|amer|north america|any state|all states)\b/i.test(rest)) return true;
  const lower = rest.toLowerCase();
  if (Object.keys(STATES).some((n) => new RegExp(`\\b${n}\\b`).test(lower))) return true;
  return [...rest.matchAll(/\b([A-Z]{2})\b/g)].some((m) => CODES.has(m[1]!));
}

/**
 * Does a posting pass the profile's filters, and on what: the title word it matched and the place
 * (or "remote"). A near miss, a title that has one of your words in a place that isn't one of
 * yours, keeps its title word and doesn't fit (the Signals section lists those first). Built once
 * per filters object, so scoring a whole board costs no regex building.
 */
export function score(
  job: { title: string; location?: string; description?: string },
  f: PostingFilters,
): Score {
  const c = compile(f);
  const loc = job.location ?? "";
  const x = tokenise(job.title);
  const { out, title } = titleOf(x, c);
  if (out) return { fits: false, matched: null, review: null };
  // The place, read only when it matters: the title has a word of yours, or names a job.
  let place: string | undefined;
  const inPlace = () => {
    if (!c.locations.length) return true;
    place = atPlace(loc, c.locations, c.us);
    if (!place && c.remoteOk && workMode(job).mode === "remote" && (!c.us || remoteInUs(loc)))
      place = "remote";
    return !!place || loc === "" || (c.us && noCity(loc));
  };
  if (c.hasInclude && !title) {
    const review = hasRole(x.t) && inPlace() ? (reviewOf(x, c.include)?.key ?? null) : null;
    return { fits: false, matched: null, review };
  }
  if (!inPlace()) return { fits: false, matched: title ?? null, review: null };
  return { fits: true, matched: [title, place].filter(Boolean).join(" · ") || null, review: null };
}

/**
 * A title's group in the Review list (Score's `review`), what the title says there (`phrase`,
 * what Add adds) and the phrase of yours it is close to (`like`). null when it names no job.
 */
export const reviewTitle = (title: string, f: PostingFilters) =>
  reviewOf(tokenise(title), compile(f).include);

/**
 * Why a role doesn't pass the filters, in plain words ("Dallas, TX: outside your places"; "title
 * has none of your words"), or null when it does. As `score` reads it. `place` false: said beside
 * the role's own place, which isn't said again ("outside your places").
 */
export function missed(
  job: { title: string; location?: string; description?: string },
  f: PostingFilters,
  o: { place?: boolean } = {},
) {
  const c = compile(f);
  const loc = (job.location ?? "").trim();
  const x = tokenise(job.title);
  const { out, title } = titleOf(x, c);
  if (out) return `title has “${out}”, a word you left out`;
  if (c.hasInclude && !title) {
    const like = hasRole(x.t) ? closeMatch(x, c.include)?.phrase.word : undefined;
    return like ? `title has none of your words · close to “${like}”` : "title has none of your words";
  }
  if (score(job, f).fits) return null;
  const { mode, place } = workMode(job);
  const full = place || loc;
  const where =
    o.place === false ? "" : full.length > 60 ? `${full.slice(0, 58).replace(/[\s,;·]+\S*$/, "")}…` : full;
  if (mode === "remote" && !c.remoteOk) return "remote, and you left remote roles out";
  if (mode === "remote") return where ? `remote in ${where}, not the US` : "remote, but not open in the US";
  return where ? `${where}: outside your places` : "outside your places";
}

export function passes(
  job: { title: string; location?: string; description?: string },
  f: PostingFilters,
): boolean {
  return score(job, f).fits;
}

/**
 * The words a board's own search is asked for: the three commonest last words of the title list
 * ("Engineer", "Developer", …). Measured 2026-10-28 on the real profile: 74 title words joined
 * with OR is too long for a search box, and three stems cover them; `score` does the real filtering.
 */
export function stems(words: string[]): string[] {
  const count = new Map<string, number>();
  for (const w of words) {
    const last = w.trim().split(/\s+/).pop() ?? "";
    if (last.length < 4) continue; // "End" (Front End, Back End) is no search word
    const k = last.toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(
      ([k]) =>
        words
          .find((w) => w.trim().split(/\s+/).pop()?.toLowerCase() === k)!
          .trim()
          .split(/\s+/)
          .pop()!,
    );
}

// The profile's locations are the one list of places (decided 2026-10-28): the Inbox filter, Form D's
// states and board search's cities all come from it.
const STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};
const CODES = new Set(Object.values(STATES));

/** Are the profile's places American: does one of them name a state? */
export const usPlaces = (f: PostingFilters) => profileStates(f.locations ?? []).length > 0;

/**
 * The states the profile's locations name: a full state name ("Colorado") or a ", XX" code
 * ("Denver, CO"); Settings splits locations on commas, so an entry that is just a code ("CO")
 * counts too. Never inferred from a city.
 */
export function profileStates(locations: string[]): string[] {
  const out = new Set<string>();
  for (const l of locations) {
    const t = l.trim();
    const code = t.match(/,\s*([A-Z]{2})\b/)?.[1] ?? (/^[A-Z]{2}$/.test(t) ? t : undefined);
    if (code && CODES.has(code)) out.add(code);
    const name = t
      .toLowerCase()
      .replace(/[^a-z ]+/g, " ")
      .trim();
    // The longest state name the entry ends with ("West Virginia", not "Virginia").
    const full = Object.keys(STATES)
      .filter((s) => name === s || name.endsWith(` ${s}`))
      .sort((a, b) => b.length - a.length)[0];
    if (full) out.add(STATES[full]!);
  }
  return [...out];
}

const NOT_A_CITY =
  /^(remote|anywhere|worldwide|global|usa?|united states( of america)?|america|north america|uk|united kingdom|canada|europe|emea)$/i;

/** The cities the profile's locations name: whatever isn't a state, a code, a country or "Remote". */
export function profileCities(locations: string[]): string[] {
  const out: string[] = [];
  for (const l of locations) {
    const city = l.split(",")[0]!.trim();
    if (!city || NOT_A_CITY.test(city) || /^[A-Z]{2}$/.test(city)) continue;
    // A state's name isn't a city, except the two that are both.
    if (STATES[city.toLowerCase()] && !/^(new york|washington)$/i.test(city)) continue;
    if (!out.some((c) => c.toLowerCase() === city.toLowerCase())) out.push(city);
  }
  return out;
}

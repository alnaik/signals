// Location, remote and title filters from me/profile.json, applied to postings.
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../core/paths.ts";

export type PostingFilters = {
  locations?: string[]; // any match passes, e.g. ["London", "United Kingdom"]
  metros?: Record<string, string[]>; // the Inbox's city switch: the locations grouped, e.g. {"Colorado": ["Denver", "Boulder", "CO"]}
  remote_ok?: boolean; // remote postings pass regardless of location; missing means they do (remoteOk)
  title_include?: string[];
  title_exclude?: string[];
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
    .replace(new RegExp(HYBRID.source, "gi"), "")
    .replace(new RegExp(ONSITE.source, "gi"), "")
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
    .replace(new RegExp(REMOTE.source, "gi"), "")
    .replace(new RegExp(HYBRID.source, "gi"), "")
    .replace(new RegExp(ONSITE.source, "gi"), "")
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

// What a title names when it names a job: a title word that names none ("Mobile", "Embedded",
// "Quest") is a kind of one, and counts only beside one of these ("Mobile Engineer", not "Mobile
// Dog Groomer"). A title word that is or holds one ("Developer", "Data Engineer", "SRE") stands alone.
const ROLE =
  /\b(engineer\w*|enginner|developer\w*|development|dev|programmer\w*|architect\w*|scientist\w*|research\w*|designer\w*|prototyper|builder|manager\w*|management|mgr|lead|leader|director|head|specialist\w*|analyst\w*|technologist\w*|consultant\w*|expert|advocate\w*|administrator\w*|relations|technical staff|software|devops|devrel|sre|sde|swe|tpm|intern\w*|founding|full[\s-]?stack|front[\s-]?end|back[\s-]?end|ios|android)\b/i;

/** The first title word the title has, as a job: see ROLE. */
function titleWord(title: string, words: Words): string | undefined {
  return words.find((w) => w.re.test(title) && (ROLE.test(w.word) || ROLE.test(title)))?.word;
}

export type Score = { fits: boolean; matched: string | null };
type Compiled = {
  include: Words;
  exclude: Words;
  locations: Words;
  remoteOk: boolean;
  us: boolean; // the profile's places are American: a remote role must be open in the US
};
const compiled = new WeakMap<PostingFilters, Compiled>();
function compile(f: PostingFilters): Compiled {
  let c = compiled.get(f);
  if (!c) {
    c = {
      include: compileWords(f.title_include),
      exclude: compileWords(f.title_exclude),
      locations: compileWords(f.locations, true),
      remoteOk: remoteOk(f),
      us: profileStates(f.locations ?? []).length > 0,
    };
    compiled.set(f, c);
  }
  return c;
}

// Bumped when `score` changes how it reads a role, so every open role is scored again
// (intake/refresh.ts filtersKey). 5: a near miss keeps its title word.
export const SCORE_RULES = 5;

/**
 * Is a remote role open in the US? Its location says nothing but how it's worked ("Remote",
 * "Anywhere", "2 Locations"), or names the US: "Remote US", "Remote (Any State)", a state's name or
 * its code in capitals. "Remote Canada", "Germany · Remote" and "Remote - Europe" aren't.
 * Measured 2026-11-01: 464 fitting remote roles were abroad; a city the profile doesn't list with no
 * state ("Remote - Dallas") is the miss, and "IN" (India's code, Indiana's too) passes.
 */
function remoteInUs(location: string): boolean {
  const rest = location
    .replace(new RegExp(REMOTE.source, "gi"), "")
    .replace(new RegExp(HYBRID.source, "gi"), "")
    .replace(new RegExp(ONSITE.source, "gi"), "")
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
  if (c.exclude.length && first(job.title, c.exclude)) return { fits: false, matched: null };
  const title = c.include.length ? titleWord(job.title, c.include) : undefined;
  if (c.include.length && !title) return { fits: false, matched: null };
  let place: string | undefined;
  if (c.locations.length) {
    place = atPlace(loc, c.locations, c.us);
    if (!place && c.remoteOk && workMode(job).mode === "remote" && (!c.us || remoteInUs(loc)))
      place = "remote";
    if (!place && loc !== "" && !(c.us && noCity(loc))) return { fits: false, matched: title ?? null };
  }
  return { fits: true, matched: [title, place].filter(Boolean).join(" · ") || null };
}

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
  const out = c.exclude.length ? first(job.title, c.exclude) : undefined;
  if (out) return `title has “${out}”, a word you left out`;
  if (c.include.length && !titleWord(job.title, c.include)) return "title has none of your words";
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

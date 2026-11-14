// HN "Who is hiring?", no key. The official HN API finds the month's thread; Algolia's public
// HN API returns the whole thread in one request. A comment is remembered only once it passed
// the profile filters, so a filter change picks up the ones it skipped before.
import { loadFilters, remoteOk } from "../../ats/filters.ts";
import { getMeta, open, setMeta } from "../../core/db.ts";
import { htmlToText, politeGet } from "../../core/http.ts";
import { canUseSmallModel } from "../../core/model.ts";
import { namesNoCompany } from "../../intake/leads.ts";
import { dropSignals, type SignalRow } from "../../intake/prune.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { readSourceState, writeSourceState } from "../../signals/state.ts";

const API = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA = "https://hn.algolia.com/api/v1/items";
type Comment = { id: number; author?: string | null; text?: string | null; created_at_i?: number };
type Item = {
  id: number;
  by?: string;
  title?: string;
};

async function item(id: number): Promise<Item | null> {
  return JSON.parse((await politeGet(`${API}/item/${id}.json`)).text);
}

/** "Company | Role | Location | ..." → company name, plus the first link that names a company. */
export function parseComment(html: string): { company?: string; domain?: string; text: string } {
  const text = htmlToText(html);
  const first = text.split("\n")[0] ?? "";
  const company = first.includes("|") ? first.split("|")[0]!.trim() : undefined;
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) =>
    m[1]!.replace(/&#x2F;/g, "/").replace(/&amp;/g, "&"),
  );
  for (const h of hrefs) {
    try {
      const host = new URL(h).hostname.replace(/^www\./, "");
      if (!namesNoCompany(h)) return { company, domain: host, text };
    } catch {}
  }
  return { company, text };
}

/**
 * A post names its company in its first line ("Acme | Role | Place") or links its site. A
 * top-level comment with neither isn't a post (someone saying they're applying): the classifier
 * could only guess whose it is, and its guess was "Unknown".
 */
export const isPost = (p: { company?: string; domain?: string }) => !!(p.company || p.domain);

// People post themselves in the hiring thread too (seen in the live data, 2026-11): the "Who
// wants to be hired" template, a first-person opener with their own site as the link, or their
// name before the first "|". None is an employer.
const TEMPLATE = /\b(location|remote|willing to relocate|technologies|r[ée]sum[ée](?:\/cv)?|cv|email)\s*:/gi;
const WE = /\b(we|we're|we’re|we've|we are|our|us|hiring|join)\b/i;
const FIRST_PERSON = /\b(i'm|i’m|i am|i have|i've|i’ve|my)\b/i;
const OPENER =
  /^\s*(?:(?:hi|hello|hey)\b[\s,!.]*(?:hn|all|everyone|there)?[\s,!.]*)?(?:i'm|i’m|i am|my name is)\s/i;
// Two or three capitalised words, letters only: how a person's name looks (and some companies'
// names: "Marker Learning", which then say "we").
const PERSON = /^[A-Z][a-z'’-]+(?: [A-Z][a-z'’-]+){1,2}$/;

/** "seeker": a person offering themselves; "unsure": a name that may be a person's, for the model. */
export function postedBy(text: string, company?: string): "employer" | "seeker" | "unsure" {
  const labels = new Set([...text.matchAll(TEMPLATE)].map((m) => m[1]!.toLowerCase().slice(0, 6)));
  if (labels.has("willin") || (labels.has("techno") && labels.size >= 3)) return "seeker";
  if (OPENER.test(text) && !WE.test(text)) return "seeker";
  if (company && PERSON.test(company) && !WE.test(text)) return FIRST_PERSON.test(text) ? "seeker" : "unsure";
  return "employer";
}

export function matchesFilters(text: string): boolean {
  const f = loadFilters();
  const lower = text.toLowerCase();
  if (f.title_include?.length && !f.title_include.some((k) => lower.includes(k.toLowerCase()))) return false;
  if (
    f.title_exclude?.length &&
    f.title_exclude.some((k) => lower.includes(k.toLowerCase()) && !f.title_include?.length)
  )
    return false;
  if (f.locations?.length) {
    const remote = remoteOk(f) && /\bremote\b/i.test(text);
    if (!remote && !f.locations.some((l) => lower.includes(l.toLowerCase()))) return false;
  }
  return true;
}

/**
 * Once per data folder: the posts taken in before postedBy, by people offering themselves, go,
 * with the companies only they named and that you never acted on (intake/prune.ts). Rules only.
 */
export function dropSeekersOnce(now = new Date()): string[] {
  const KEY = "repair:hn-seekers";
  if (getMeta(KEY)) return [];
  const rows = open().query("SELECT * FROM signals WHERE source = 'hn'").all() as SignalRow[];
  const seekers = rows.filter((r) => {
    const first = (r.text ?? "").split("\n")[0] ?? "";
    return postedBy(r.text ?? "", first.includes("|") ? first.split("|")[0]!.trim() : undefined) === "seeker";
  });
  const out = dropSignals(seekers);
  setMeta(KEY, now.toISOString());
  if (!out.signals.length) return [];
  return [
    `${out.signals.length} posts by people offering themselves dropped`,
    ...out.companies.map((c) => `removed ${c}: only such a post named it`),
  ];
}

const hn: Source = {
  key: "hn",
  name: "HN Who is hiring",
  schedule: "every_6h",
  connected: () => true,
  fetch: async () => {
    for (const line of dropSeekersOnce()) console.log(`hn repair: ${line}`);
    const user = JSON.parse((await politeGet(`${API}/user/whoishiring.json`)).text) as {
      submitted: number[];
    };
    let thread: Item | null = null;
    for (const id of user.submitted.slice(0, 6)) {
      const it = await item(id);
      if (it?.title && /who is hiring/i.test(it.title)) {
        thread = it;
        break;
      }
    }
    if (!thread) throw new Error("no current Who is hiring thread");
    const state = readSourceState<{ thread?: number; seen: number[] }>("hn", { seen: [] });
    const seen = new Set(state.thread === thread.id ? state.seen : []);
    const tree = JSON.parse((await politeGet(`${ALGOLIA}/${thread.id}`)).text) as { children?: Comment[] };
    const leads: Lead[] = [];
    let read = 0;
    // Top-level comments only: replies are questions about a post, not posts.
    for (const c of tree.children ?? []) {
      if (seen.has(c.id) || !c.text) continue; // deleted and dead comments come back without text
      read++;
      const parsed = parseComment(c.text);
      if (!isPost(parsed)) continue;
      // A person offering themselves is no lead. A name that may be a person's goes to the small
      // model with no company, when one is connected, which says whether an employer is hiring;
      // without one it is taken as before.
      const by = postedBy(parsed.text, parsed.company);
      if (by === "seeker") continue;
      const ask = by === "unsure" && canUseSmallModel();
      if (!matchesFilters(parsed.text)) continue;
      seen.add(c.id);
      const at = c.created_at_i ? new Date(c.created_at_i * 1000).toISOString() : undefined;
      leads.push({
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        text: parsed.text.slice(0, 1500),
        ...(c.author ? { author: c.author } : {}),
        ...(ask ? {} : { company_hint: parsed.company }),
        ...(parsed.domain && !ask ? { domain: parsed.domain } : {}),
        seen_at: at,
        kind: "posting",
        posted_at: at,
        // The thread runs a month and its roles stay open that long.
        max_age_days: 35,
        source: "hn",
        source_tag: "HN",
        title: parsed.text.split("\n")[0]?.slice(0, 140),
      });
    }
    writeSourceState("hn", { thread: thread.id, seen: [...seen] });
    hn.read = read;
    return leads;
  },
  stillPasses: (s) => matchesFilters(s.text ?? ""),
  forget: (refs) => {
    const ids = new Set(refs.map((r) => Number(r.match(/[?&]id=(\d+)/)?.[1])));
    const state = readSourceState<{ thread?: number; seen: number[] }>("hn", { seen: [] });
    writeSourceState("hn", { ...state, seen: state.seen.filter((id) => !ids.has(id)) });
  },
};

export default hn;

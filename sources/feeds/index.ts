// Feeds (RSS or Atom): a newsletter, a blog, a jobs digest. Each feed address the person adds is
// read every 6 hours, robots.txt respected, and each new entry becomes signals. With a model, the
// small model names the hiring companies an entry is about, each with its website when the entry
// links it. Without one, only links that point at a company's job board, or at a site the link's
// own text names ("Anduril" → anduril.com), come in. Off until a feed is added.
// @ts-expect-error plain JS module
import { employerOf } from "../../ats/links.mjs";
import { label, sharesWord } from "../../ats/reader.ts";
import { loadConfig } from "../../core/config.ts";
import { htmlToText, politeGet, unescapeHtml } from "../../core/http.ts";
import { canUseSmallModel, NoModelKey, OverCap, smallJson } from "../../core/model.ts";
import { nameKey } from "../../intake/companies.ts";
import { siteDomain } from "../../intake/leads.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { readSourceState, writeSourceState } from "../../signals/state.ts";

export const KEY = "feeds";
// Offered in the tile's guide, off until added: a16z's jobs newsletter.
export const SUGGESTED = [{ url: "https://a16zjobs.substack.com/feed", name: "a16z Jobs newsletter" }];
const FIRST_DAYS = 14; // a new feed's entries from the last two weeks
const MODEL_ENTRIES = 20; // entries read by the model per run, at most

export const ACCEPT = "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8";

export const feedUrls = (): string[] => {
  const u = loadConfig().source[KEY]?.urls;
  return Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : [];
};

export type Entry = { id: string; title: string; url: string; html: string; at: string | null };

/** The entries of an RSS or Atom document: id, title, link, content as HTML, date. */
export function parseFeed(xml: string, feedUrl: string): Entry[] {
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const body = m[2]!;
    const tag = (name: string) => {
      const t = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]?.trim();
      if (t === undefined) return undefined;
      const cdata = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
      return cdata ? cdata[1]! : unescapeHtml(t);
    };
    const href =
      body.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
      body.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ??
      tag("link");
    const title = htmlToText(tag("title") ?? "").trim();
    if (!href || !title) continue;
    let url: string;
    try {
      url = new URL(unescapeHtml(href), feedUrl).href;
    } catch {
      continue;
    }
    const when = Date.parse(tag("pubDate") ?? tag("published") ?? tag("updated") ?? tag("dc:date") ?? "");
    out.push({
      id: tag("guid") ?? tag("id") ?? url,
      title,
      url,
      html: tag("content:encoded") ?? tag("content") ?? tag("description") ?? tag("summary") ?? "",
      at: Number.isNaN(when) ? null : new Date(when).toISOString(),
    });
  }
  return out;
}

/** An entry's links with their text. */
const anchors = (html: string, base: string) =>
  [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap((m) => {
    try {
      return [{ url: new URL(unescapeHtml(m[1]!), base).href, text: htmlToText(m[2]!).trim() }];
    } catch {
      return [];
    }
  });

const base = (e: Entry, feed: string, at: string) => ({
  text: `${e.title}\n${htmlToText(e.html).slice(0, 2000)}`.trim(),
  posted_at: e.at ?? at,
  seen_at: at,
  source: KEY,
  source_tag: new URL(feed).hostname.replace(/^www\./, ""),
});

/** Without a model: a job board's link (its employer known), or a site the link's own text names. */
export function linkLeads(e: Entry, feed: string, at: string): Lead[] {
  const out: Lead[] = [];
  const seen = new Set<string>();
  for (const a of anchors(e.html, e.url)) {
    const employer = employerOf(a.url) as string | null;
    const domain = employer ? null : siteDomain(a.url);
    // The link's text is a name, not an address ("https://a16z.com/investment-list/").
    const own = domain && a.text && !/^https?:|[/@]/.test(a.text) && sharesWord(a.text, label(domain));
    const key = employer ?? (own ? domain : null);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...base(e, feed, at),
      url: a.url,
      kind: employer ? "posting" : "company",
      ...(own ? { company_hint: a.text, domain: domain!, domain_from: "post" as const } : {}),
    });
  }
  return out;
}

const SYSTEM =
  "You read one entry from a newsletter or blog feed. List each company the entry says is hiring or has open roles, by its name as written, with the link from the entry that is that company's own website or job board, or an empty string when the entry gives none. Leave out the publisher, investors, sponsors and companies only mentioned in passing. An entry about no hiring company gives an empty list.";
const SCHEMA = {
  type: "object",
  properties: {
    companies: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, link: { type: "string" } },
        required: ["name", "link"],
        additionalProperties: false,
      },
    },
  },
  required: ["companies"],
  additionalProperties: false,
};

/** With a model: the hiring companies the entry names, each its own signal. */
async function modelLeads(e: Entry, feed: string, at: string): Promise<Lead[]> {
  const links = anchors(e.html, e.url);
  const user = `Feed: ${feed}\nTitle: ${e.title}\n\n<text>\n${htmlToText(e.html).slice(0, 12_000)}\n</text>\n\n<links>\n${links
    .slice(0, 120)
    .map((l) => `${l.text || "(no text)"} -> ${l.url}`)
    .join("\n")}\n</links>`;
  const { companies } = await smallJson<{ companies: { name: string; link: string }[] }>({
    station: "feeds",
    system: SYSTEM,
    user,
    schema: SCHEMA,
  });
  const linked = new Set(links.map((l) => l.url));
  const out: Lead[] = [];
  for (const c of companies) {
    const name = c.name.trim();
    if (!nameKey(name)) continue;
    // Only a link the entry itself has; a company's own site, not a job board's, is its domain.
    const link = linked.has(c.link) ? c.link : null;
    const domain = link && !employerOf(link) ? siteDomain(link) : null;
    out.push({
      ...base(e, feed, at),
      url: link ?? e.url,
      ref: `${e.url}#${nameKey(name)}`,
      company_hint: name,
      kind: "company",
      ...(domain ? { domain, domain_from: "post" as const } : {}),
    });
  }
  return out;
}

const feeds: Source = {
  key: KEY,
  name: "Feeds",
  schedule: "every_6h",
  off: true,
  connected: () => feedUrls().length > 0,
  status: () => (feedUrls().length ? undefined : "no feed added"),
  fetch: async (_since, now = new Date()) => {
    const state = readSourceState<{ seen: Record<string, string[]> }>(KEY, { seen: {} });
    const at = now.toISOString();
    const model = canUseSmallModel();
    const leads: Lead[] = [];
    let read = 0;
    let modelRead = 0;
    let waiting = 0;
    for (const feed of feedUrls()) {
      const first = !state.seen[feed];
      const seen = new Set(state.seen[feed] ?? []);
      const page = await politeGet(feed, { accept: ACCEPT });
      const all = parseFeed(page.text, feed);
      // A new feed's entries older than two weeks count as read.
      const old = (e: Entry) => first && !!e.at && now.getTime() - Date.parse(e.at) > FIRST_DAYS * 86_400_000;
      for (const e of all) if (old(e)) seen.add(e.id);
      const fresh = all.filter((e) => !seen.has(e.id));
      read += fresh.length;
      for (const e of fresh) {
        if (model && modelRead >= MODEL_ENTRIES) {
          waiting++; // the rest are read at the next run
          continue;
        }
        if (model) {
          modelRead++;
          try {
            leads.push(...(await modelLeads(e, feed, at)));
          } catch (err) {
            if (!(err instanceof NoModelKey || err instanceof OverCap)) throw err;
            waiting++;
            continue;
          }
        } else leads.push(...linkLeads(e, feed, at));
        seen.add(e.id);
      }
      state.seen[feed] = [...seen].slice(-500);
    }
    writeSourceState(KEY, state);
    feeds.read = read;
    feeds.note = waiting ? `${waiting} entries wait for the next run` : undefined;
    return leads;
  },
};

export default feeds;

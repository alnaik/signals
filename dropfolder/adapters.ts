// Drop folder formats, recognised by shape. Known formats need no model; an unknown JSON
// shape gets a recipe (which field is the link, author, date, text), learned once and reused.
import type { Lead } from "../intake/types.ts";

export type Item = Omit<Lead, "source" | "source_tag"> & { source?: string; source_tag?: string };
export type Recipe = { records: string; url: string; author?: string; date?: string; text?: string };

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const TAGS: Record<string, string> = {
  instagram: "Instagram",
  "hiring.cafe": "hiring.cafe",
  muse: "Muse",
  x: "X bookmark",
  twitter: "X bookmark",
  linkedin: "LinkedIn alert",
  notebook: "past application",
  past: "past application",
};

export function tagFor(source: string | undefined): string {
  return (source && TAGS[source.toLowerCase()]) || "drop folder";
}

function isoFrom(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function get(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// --- format detectors ---------------------------------------------------------

type Adapter = { name: string; parse: (text: string, file: string) => Item[] | null };

const nativeJsonl: Adapter = {
  name: "native jsonl",
  parse: (text, file) => {
    if (!/\.jsonl$/i.test(file) && !text.trimStart().startsWith("{")) return null;
    const lines = text.split("\n").filter((l) => l.trim());
    const items: Item[] = [];
    for (const line of lines) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line);
      } catch {
        return null;
      }
      if (typeof o.url !== "string") return null;
      items.push({
        url: o.url,
        kind: (o.kind as Item["kind"]) ?? "post",
        source: typeof o.source === "string" ? o.source : undefined,
        seen_at: isoFrom(o.seen_at),
        note: typeof o.note === "string" ? o.note : undefined,
        ...(typeof o.title === "string" ? { title: o.title } : {}),
        ...(typeof o.company === "string" ? { company_hint: o.company } : {}),
        ...(typeof o.domain === "string" ? { domain: o.domain } : {}),
      });
    }
    return items.length ? items : null;
  },
};

// twitter-web-exporter: a JSON array of { id, created_at, full_text, screen_name, url, ... }
const twitterExporter: Adapter = {
  name: "twitter-web-exporter",
  parse: (text) => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as Record<string, unknown>;
    if (!("full_text" in first) || !("screen_name" in first)) return null;
    return data.map((t: Record<string, unknown>) => ({
      url: typeof t.url === "string" ? t.url : `https://x.com/${t.screen_name}/status/${t.id}`,
      text: typeof t.full_text === "string" ? t.full_text : undefined,
      author: typeof t.screen_name === "string" ? `@${t.screen_name}` : undefined,
      seen_at: isoFrom(t.created_at),
      kind: "post" as const,
      source: "x",
    }));
  },
};

// Instagram "Download your information": saved_posts.json. Expect links, accounts and dates.
const instagram: Adapter = {
  name: "instagram saved posts",
  parse: (text) => {
    if (!text.includes("instagram.com")) return null;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    const items: Item[] = [];
    const walk = (node: unknown, title?: string) => {
      if (Array.isArray(node)) {
        for (const n of node) walk(n, title);
        return;
      }
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const t = typeof o.title === "string" && o.title ? o.title : title;
      if (typeof o.href === "string" && o.href.includes("instagram.com")) {
        items.push({
          url: o.href,
          author: t ? `@${t}` : undefined,
          seen_at: isoFrom(o.timestamp),
          kind: "post",
          source: "instagram",
        });
      }
      for (const v of Object.values(o)) walk(v, t);
    };
    walk(data);
    return items.length ? items : null;
  },
};

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

// Any CSV with a URL column (the notebook transcription lands here too).
const csv: Adapter = {
  name: "csv",
  parse: (text, file) => {
    if (!/\.csv$/i.test(file)) return null;
    const rows = parseCsv(text);
    if (rows.length < 2) return null;
    const head = rows[0]!.map((h) => h.trim().toLowerCase());
    let urlCol = head.findIndex((h) => /^(url|link|href|posting|job url)$/.test(h));
    if (urlCol < 0) urlCol = rows[1]!.findIndex((c) => /^https?:\/\//.test(c.trim()));
    if (urlCol < 0) return null;
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const [company, date, note, author, source, status] = [
      col(/^(company|org|organisation|organization)$/),
      col(/date|seen|applied/),
      col(/note|notes|comment/),
      col(/author|who|contact/),
      col(/^source$/),
      col(/status|outcome/),
    ];
    return rows
      .slice(1)
      .filter((r) => /^https?:\/\//.test(r[urlCol]?.trim() ?? ""))
      .map((r) => ({
        url: r[urlCol]!.trim(),
        company_hint: company >= 0 ? r[company] : undefined,
        seen_at: date >= 0 ? isoFrom(r[date]) : undefined,
        note:
          [note >= 0 ? r[note] : "", status >= 0 && r[status] ? `status: ${r[status]}` : ""]
            .filter(Boolean)
            .join(" · ") || undefined,
        author: author >= 0 ? r[author] : undefined,
        source: source >= 0 ? r[source] : undefined,
        kind: "post" as const,
      }));
  },
};

// Plain text: every link in it.
const plainText: Adapter = {
  name: "text links",
  parse: (text, file) => {
    if (!/\.(txt|md|text)$/i.test(file) && /\.(json|jsonl|csv)$/i.test(file)) return null;
    if (/^\s*[[{]/.test(text)) return null;
    const urls = [...new Set(text.match(URL_RE) ?? [])];
    return urls.length
      ? urls.map((url) => ({ url: url.replace(/[.,;:]+$/, ""), kind: "post" as const }))
      : null;
  },
};

export const ADAPTERS = [twitterExporter, instagram, nativeJsonl, csv, plainText];

// --- learned recipes ------------------------------------------------------------

/** A shape signature for a JSON file: where its records are and what keys they have. */
export function signature(data: unknown): { records: string; keys: string[] } | null {
  const find = (node: unknown, at: string): { records: string; keys: string[] } | null => {
    if (Array.isArray(node) && node.length && typeof node[0] === "object" && node[0] !== null) {
      return { records: at, keys: Object.keys(node[0]).sort() };
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        const r = find(v, at ? `${at}.${k}` : k);
        if (r) return r;
      }
    }
    return null;
  };
  return find(data, "");
}

export function signatureKey(sig: { records: string; keys: string[] }): string {
  return `${sig.records}|${sig.keys.join(",")}`;
}

/** Free first: guess the recipe when exactly one field holds URLs. */
export function guessRecipe(data: unknown): Recipe | null {
  const sig = signature(data);
  if (!sig) return null;
  const recs = (sig.records ? get(data, sig.records) : data) as Record<string, unknown>[];
  const sample = recs.slice(0, 20);
  const urlKeys = sig.keys.filter((k) =>
    sample.every((r) => typeof r[k] === "string" && /^https?:\/\//.test(r[k])),
  );
  if (urlKeys.length !== 1) return null;
  const pick = (re: RegExp) => sig.keys.find((k) => re.test(k.toLowerCase()));
  return {
    records: sig.records,
    url: urlKeys[0]!,
    author: pick(/author|user|handle|screen_name|by/),
    date: pick(/date|time|created|saved|seen/),
    text: pick(/text|body|content|title|caption|note/),
  };
}

export function applyRecipe(data: unknown, r: Recipe): Item[] {
  const recs = (r.records ? get(data, r.records) : data) as unknown[];
  if (!Array.isArray(recs)) return [];
  return recs.flatMap((rec) => {
    const url = get(rec, r.url);
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return [];
    const author = r.author ? get(rec, r.author) : undefined;
    const text = r.text ? get(rec, r.text) : undefined;
    return [
      {
        url,
        author: typeof author === "string" ? author : undefined,
        text: typeof text === "string" ? text : undefined,
        seen_at: r.date ? isoFrom(get(rec, r.date)) : undefined,
        kind: "post" as const,
      },
    ];
  });
}

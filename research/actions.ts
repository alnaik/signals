// The thread's research block: search the free providers, add a result as a fact, watch a
// search nightly, add a fact by hand. Restored from the old Research space (b4a9b08^) without
// its notebook, tags, statuses or summaries. Providers go through the registry, so every
// call is in the ledger.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as index from "../core/index-db.ts";
import { append, type Entry, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { checkFact } from "../linkcheck/check.ts";
import { duplicateCheck } from "../providers/github-issues.ts";
import { call, getProvider, isAvailable, loadProviders } from "../providers/registry.ts";

export type Result = { url: string; title: string; snippet: string; provider: string; flags?: string[] };
export type Watch = {
  query: string;
  providers: string[];
  seen: string[];
  created: string;
  last_run?: string;
};

export async function searchProviders() {
  return (await loadProviders())
    .filter((p) => p.search)
    .map((p) => ({ name: p.name, label: p.label, available: isAvailable(p), cost: p.cost.search ?? 0 }));
}

export async function search(thread: string, query: string, providers: string[]) {
  if (!query) throw new Error("Type a search first");
  const results: Result[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(
    providers.map(async (name) => {
      const p = await getProvider(name);
      if (!p?.search || !isAvailable(p)) {
        errors[name] = "not connected";
        return;
      }
      try {
        const r = await call(p, "search", [query, { n: 10 }], { station: "research", thread });
        results.push(...r.map((x) => ({ ...x, provider: name })));
      } catch (err) {
        errors[name] = (err as Error).message.slice(0, 120);
      }
    }),
  );
  // The duplicate check: an issue that's assigned or already has an open PR is flagged.
  await Promise.all(
    results
      .filter((r) => /github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(r.url))
      .map(async (r) => {
        const flags = await duplicateCheck(r.url).catch(() => []);
        if (flags.length) r.flags = flags;
      }),
  );
  return { results, errors };
}

const factUrls = (log: Entry[]) =>
  new Set(log.flatMap((e) => (e.kind === "fact" && e.source?.url ? [e.source.url] : [])));

/** Add as fact: the result's snippet is the provider's record, cited as its exact quote. */
export function addAsFact(thread: string, r: Result, opts: { new?: boolean } = {}): Entry | null {
  if (!read(thread).length) throw new Error("No such thread");
  if (factUrls(read(thread)).has(r.url)) return null;
  const e = append(thread, {
    actor: r.provider,
    kind: "fact",
    data: {
      group: "found",
      text: String(r.title || r.url).slice(0, 500),
      ...(opts.new ? { new: true } : {}),
    },
    source: {
      type: "provider_record",
      provider: r.provider,
      url: r.url,
      quote: String(r.snippet ?? "").slice(0, 1000),
      fetched_at: new Date().toISOString(),
    },
  });
  index.reindex(thread);
  return e;
}

/** Add a fact by hand: claim, link and exact quote, checked by the link checker. */
export async function addFact(thread: string, b: { text?: string; url?: string; quote?: string }) {
  const text = String(b.text ?? "").trim();
  const url = String(b.url ?? "").trim();
  const quote = String(b.quote ?? "").trim();
  if (!read(thread).length) throw new Error("No such thread");
  if (!text || !url || !quote) throw new Error("A fact needs the claim, the link and the exact quote");
  if (!/^https?:\/\//.test(url)) throw new Error("The link must start with http:// or https://");
  if (quote.length < 3) throw new Error("The quote must be at least 3 characters, copied from the page");
  const fact = append(thread, {
    actor: "you",
    kind: "fact",
    data: { group: "found", text: text.slice(0, 500) },
    source: { type: "page", url, quote: quote.slice(0, 2000), fetched_at: new Date().toISOString() },
  });
  const v = await checkFact(thread, fact).catch(() => ({ result: "pending", how: "unreachable" }));
  if (v.result !== "pending")
    append(thread, {
      actor: "linkcheck",
      kind: "note",
      data: { event: "linkcheck", fact: fact.id, result: v.result, how: v.how },
    });
  index.reindex(thread);
  if (v.result === "ok") return "Fact added · quote found on the page";
  if (v.result === "pending") return "Fact added · checked tonight";
  if (v.result === "unchecked")
    return "Fact added · its page can't be read by us, so the quote isn't checked";
  return "Fact added · quote not found on the page, so lines citing it are greyed";
}

// Watched searches live in the thread's folder, next to its log.
const watchFile = (thread: string) => path.join(paths.thread(thread), "watches.json");

export function watches(thread: string): Watch[] {
  try {
    return JSON.parse(readFileSync(watchFile(thread), "utf8"));
  } catch {
    return [];
  }
}

export function watch(thread: string, query: string, providers: string[], on: boolean, seen: string[] = []) {
  if (!read(thread).length) throw new Error("No such thread");
  const rest = watches(thread).filter((w) => w.query !== query);
  const next = on
    ? [
        ...rest,
        {
          query,
          providers,
          seen: [...new Set([...seen, ...factUrls(read(thread))])],
          created: new Date().toISOString(),
        },
      ]
    : rest;
  writeFileSync(watchFile(thread), JSON.stringify(next, null, 1));
  return next;
}

/** Nightly: re-run each watched search; results never seen before are added as facts marked new. */
export async function runWatches(): Promise<string> {
  let fresh = 0;
  let n = 0;
  for (const s of index.all()) {
    if (!existsSync(watchFile(s.id)) || s.status === "closed") continue;
    const list = watches(s.id);
    for (const w of list) {
      n++;
      const { results } = await search(s.id, w.query, w.providers);
      const seen = new Set(w.seen);
      for (const r of results) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        if (addAsFact(s.id, r, { new: true })) fresh++;
      }
      w.seen = [...seen].slice(-2000);
      w.last_run = new Date().toISOString();
    }
    writeFileSync(watchFile(s.id), JSON.stringify(list, null, 1));
  }
  return `${fresh} new from ${n} watched searches`;
}

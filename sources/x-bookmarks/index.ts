// X bookmarks, ongoing: owned reads through the official API once a night. X bills every
// bookmark returned, so each night asks for about as many as recent nights brought, and pages
// on only while all are new. The backlog comes once through the drop folder (twitter-web-exporter).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../../core/paths.ts";
import { namesNoCompany } from "../../intake/leads.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { bookmarks, isConnected, type Post } from "../../xapi/client.ts";

const stateFile = () => path.join(dataDir(), "sources", "x-bookmarks.json");

type State = { seen: string[]; recent?: number[] };

function readState(): State {
  if (!existsSync(stateFile())) return { seen: [] };
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8"));
    return { seen: s.seen ?? [], recent: s.recent ?? [] };
  } catch {
    return { seen: [] };
  }
}

/** First page size: the busiest of the last 7 nights plus headroom, 10 to 100. */
export function firstPageSize(recent: number[]): number {
  const most = Math.max(0, ...recent.slice(-7));
  return Math.min(100, Math.max(10, Math.ceil(most * 1.5) + 5));
}

/** The first link in a post that names a company (not a post, a link host or a job board) is its site. */
export function companyLink(p: Post): string | undefined {
  return p.urls.find((u) => !namesNoCompany(u));
}

export function toLead(p: Post): Lead {
  const link = companyLink(p);
  return {
    url: `https://x.com/${p.username ?? "i"}/status/${p.id}`,
    text: p.text,
    author: p.username ? `@${p.username}` : undefined,
    seen_at: p.created_at,
    kind: "post",
    source: "x",
    source_tag: "X bookmark",
    ...(link ? { domain: new URL(link).hostname } : {}),
  };
}

const xBookmarks: Source = {
  key: "x-bookmarks",
  name: "X bookmarks",
  schedule: "nightly",
  connected: isConnected,
  fetch: async () => {
    const { seen, recent = [] } = readState();
    // First run: one full page as the baseline; the backlog comes from the exporter file.
    const posts = seen.length
      ? await bookmarks(new Set(seen), 10, firstPageSize(recent))
      : await bookmarks(new Set(), 1, 100);
    writeFileSync(
      stateFile(),
      JSON.stringify({
        seen: [...posts.map((p) => p.id), ...seen].slice(0, 2000),
        recent: [...recent, seen.length ? posts.length : 0].slice(-7),
      }),
    );
    return posts.map(toLead);
  },
};

export default xBookmarks;

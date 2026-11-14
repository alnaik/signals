// Hacker News through Algolia's public search API: launch threads, Show HN, Ask HN. Free.
import { htmlToText } from "../core/http.ts";
import { api } from "./http.ts";
import type { Provider } from "./types.ts";

type Hit = {
  objectID: string;
  title?: string;
  url?: string | null;
  points?: number;
  num_comments?: number;
  created_at: string;
  story_text?: string | null;
};

const hn: Provider = {
  name: "hn",
  label: "Hacker News",
  cost: { search: 0 },
  search: async (query, opts) => {
    // No typo tolerance: on 2026-11-13 "foji.io" found only fobi.io and moji.io stories.
    const r = await api<{ hits: Hit[] }>(
      `https://hn.algolia.com/api/v1/search?${new URLSearchParams({ query, tags: "story", hitsPerPage: String(opts.n ?? 10), typoTolerance: "false" })}`,
      { headers: {}, timeoutMs: 15_000 },
    );
    return r.hits.map((h) => ({
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: htmlToText(h.title ?? ""),
      snippet: [
        `${h.points ?? 0} points`,
        `${h.num_comments ?? 0} comments`,
        h.url ?? "",
        htmlToText(h.story_text ?? "")
          .replace(/\s+/g, " ")
          .slice(0, 200),
      ]
        .filter(Boolean)
        .join(" · "),
      publishedDate: h.created_at,
    }));
  },
};

export default hn;

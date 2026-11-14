// The free provider: read a public page (or a few pages of a site) with polite fetching.
import { htmlToText, politeGet } from "../core/http.ts";
import type { Provider, ReadResult } from "./types.ts";

let pagesLast = 0;

async function readOne(url: string): Promise<{ url: string; text: string; title?: string; html: string }> {
  const r = await politeGet(url, { accept: "text/html,text/plain;q=0.9,*/*;q=0.5", maxBytes: 3_000_000 });
  const title = r.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  return { url: r.url, text: htmlToText(r.text), html: r.text, ...(title ? { title } : {}) };
}

const publicProvider: Provider = {
  name: "public",
  label: "Public web",
  cost: { read: 0 },
  read: async (url, opts): Promise<ReadResult> => {
    const first = await readOne(url);
    pagesLast = 1;
    const fetched_at = new Date().toISOString();
    if (!opts.site) return { url: first.url, text: first.text, title: first.title, fetched_at };
    // A small same-site crawl, breadth-first from the start page, up to the page cap.
    const origin = new URL(first.url).origin;
    const max = opts.max_pages ?? 10;
    const pages = [{ url: first.url, text: first.text }];
    const queue = [...first.html.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]!);
    const seen = new Set([first.url]);
    while (queue.length && pages.length < max) {
      let next: URL;
      try {
        next = new URL(queue.shift()!, origin);
      } catch {
        continue;
      }
      if (
        next.origin !== origin ||
        seen.has(next.href) ||
        /\.(png|jpe?g|gif|svg|pdf|zip|css|js)$/i.test(next.pathname)
      )
        continue;
      seen.add(next.href);
      try {
        const p = await readOne(next.href);
        pages.push({ url: p.url, text: p.text });
        pagesLast++;
      } catch {}
    }
    return {
      url: first.url,
      text: pages.map((p) => p.text).join("\n\n"),
      title: first.title,
      fetched_at,
      pages,
    };
  },
  lastCost: () => 0 * pagesLast,
};

export default publicProvider;

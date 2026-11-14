// Running a provider against a thread: results land in the thread log tagged by the tool,
// even on finished threads, and show as new evidence ("+2 from Firecrawl").
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import { call } from "./registry.ts";
import type { Provider } from "./types.ts";

function companyOf(id: string): string {
  return read(id).find((e) => e.kind === "signal" && e.data.company)?.data.company ?? id;
}

export async function runOnThread(id: string, p: Provider): Promise<number> {
  const ctx = { station: "provider-run", thread: id };
  const company = companyOf(id);
  const fetched_at = new Date().toISOString();
  let added = 0;
  if (p.search) {
    const results = await call(
      p,
      "search",
      [`${company} (${id}) product, hiring, engineering`, { n: 5, includeDomains: [] }],
      ctx,
    );
    for (const r of results.slice(0, 5)) {
      append(id, {
        actor: p.name,
        kind: "fact",
        data: { group: "found", text: r.title || r.url },
        source: {
          type: "provider_record",
          provider: p.name,
          url: r.url,
          quote: r.snippet.slice(0, 1000),
          fetched_at,
        },
      });
      added++;
    }
  } else if (p.read) {
    const r = await call(p, "read", [`https://${id}`, {}], ctx);
    append(id, {
      actor: p.name,
      kind: "fact",
      data: { group: "found", text: r.title ? `Site: ${r.title}` : `Site read by ${p.label}` },
      source: {
        type: "provider_record",
        provider: p.name,
        url: r.url,
        quote: r.text.slice(0, 1000),
        fetched_at,
      },
    });
    added++;
  }
  if (added) index.reindex(id);
  return added;
}

export function openThreadIds(): string[] {
  return index
    .all()
    .filter((s) => s.status !== null && s.status !== "closed")
    .map((s) => s.id);
}

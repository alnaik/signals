// Company name → domain, by rules only, for a company a source named only by name (Add, a Form
// D issuer, a past application): a name that is a domain, or a company the app already knows by
// that exact name (a watched one, a thread). Nothing is looked up: discovery proves a domain
// from the company's own posts, its board or its homepage (intake/domain.ts).
import { bare } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { threadId } from "../core/log.ts";

/** One domain whose name is exactly this one; null when two or more are, undefined when none. */
function exact(name: string, candidates: [domain: string, name: string][]): string | null | undefined {
  const want = bare(name);
  if (!want) return undefined;
  const hits = new Set(candidates.filter(([, n]) => bare(n) === want).map(([d]) => d));
  if (hits.size > 1) return null;
  return hits.size ? [...hits][0] : undefined;
}

/** A watched company or a thread with this exact name. */
function known(name: string): string | null | undefined {
  const watched = open()
    .query("SELECT domain, name FROM companies WHERE watched_at IS NOT NULL AND domain IS NOT NULL")
    .all() as { domain: string; name: string }[];
  return exact(name, [
    ...watched.map((w): [string, string] => [w.domain, w.name]),
    ...index.all().map((t): [string, string] => [t.id, t.company]),
  ]);
}

/** null: unresolved (two of your own companies by this name are no answer). */
export async function resolveCompany(name: string): Promise<string | null> {
  try {
    if (name.includes(".")) return threadId(name);
  } catch {}
  return known(name) ?? null;
}

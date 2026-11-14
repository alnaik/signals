// Taking back signals a source should not have taken in: ones that no longer pass the person's
// filters (saving filters), and posts that turned out not to be an employer hiring (a one-time
// repair). A company goes with them only when nothing else names it and the person never acted
// on it: not watched, not dismissed, no role applied to or dismissed, no thread.
import { existsSync } from "node:fs";
import { markChanged, open, tx } from "../core/db.ts";
import { paths } from "../core/paths.ts";
import { type Company, getCompany, threadIdOf } from "./companies.ts";
import type { Source } from "./types.ts";

export type SignalRow = {
  id: number;
  source: string;
  ref: string;
  company_id: number | null;
  name: string | null;
  title: string | null;
  location: string | null;
  url: string;
  text: string | null;
};

/** The person did something with it: watched, dismissed, decided a role, or opened its thread. */
export function actedOn(c: Company): boolean {
  if (c.watched_at || c.dismissed_at || c.hidden_at) return true;
  if (open().query("SELECT 1 FROM roles WHERE company_id = ? AND state <> 'new' LIMIT 1").get(c.id))
    return true;
  try {
    return existsSync(paths.thread(threadIdOf(c)));
  } catch {
    return false;
  }
}

/** The company, its names, boards and roles. Its signals must be gone already. */
function removeCompany(id: number): void {
  const d = open();
  d.query("DELETE FROM role_text WHERE role_id IN (SELECT id FROM roles WHERE company_id = ?)").run(id);
  d.query("DELETE FROM roles WHERE company_id = ?").run(id);
  d.query("DELETE FROM boards WHERE company_id = ?").run(id);
  d.query("DELETE FROM company_names WHERE company_id = ?").run(id);
  d.query("DELETE FROM companies WHERE id = ?").run(id);
}

/**
 * Drop these signals where their company (if any) wasn't acted on, then every such company no
 * signal names any more. Returns the signals dropped and the names of the companies removed.
 */
export function dropSignals(rows: SignalRow[]): { signals: SignalRow[]; companies: string[] } {
  const dropped: SignalRow[] = [];
  const removed: string[] = [];
  tx(() => {
    const d = open();
    const touched = new Set<number>();
    for (const s of rows) {
      const c = s.company_id === null ? null : getCompany(s.company_id);
      if (c && actedOn(c)) continue;
      d.query("DELETE FROM signals WHERE id = ?").run(s.id);
      dropped.push(s);
      if (c) touched.add(c.id);
    }
    for (const id of touched) {
      if (d.query("SELECT 1 FROM signals WHERE company_id = ? LIMIT 1").get(id)) continue;
      removed.push(getCompany(id)!.name);
      removeCompany(id);
    }
    if (dropped.length) markChanged();
  });
  return { signals: dropped, companies: removed };
}

/**
 * After the filters change: each source that filters what it takes in re-checks the signals it
 * took, and those that no longer pass go (with companies only they named). The source forgets
 * them too, so a later change of filters can take them in again.
 */
export function refilter(sources: Source[]): { signals: number; companies: string[] } {
  let signals = 0;
  const companies: string[] = [];
  for (const src of sources) {
    if (!src.stillPasses) continue;
    const keys = src.keys ?? [src.key];
    const rows = open()
      .query(`SELECT * FROM signals WHERE source IN (${keys.map(() => "?").join(", ")})`)
      .all(...keys) as SignalRow[];
    const out = dropSignals(rows.filter((s) => !src.stillPasses!(s)));
    if (out.signals.length) src.forget?.(out.signals.map((s) => s.ref));
    signals += out.signals.length;
    companies.push(...out.companies);
  }
  return { signals, companies };
}

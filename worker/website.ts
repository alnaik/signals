// Work on a company whose website isn't known (its thread is a stand-in, acme.no-domain): the
// press is kept, the thread says "waiting for website", and its website is looked for now, one
// company at a time, by discovery's own lookup (intake/search.ts siteFor): free first, the website
// its own Ashby board states, then one its posts prove; then one web search. A website counts only
// when it is proven (not only looked up) and is the board's: Ashby states it, or it shares a word
// with the board or the name (Everpure's homepage is Pentair's; its board is Pure Storage's).
// Discovery looks up a boarded company's website on its own too. Found: the thread moves
// to the website's name, with everything in it, and Work starts (or waits its turn). Not found:
// the thread says "no website found".
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registrable } from "../ats/reader.ts";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { failure } from "../core/trace.ts";
import { isRunNote, isStandIn } from "../core/vocab.ts";
import { companyOfThread, getCompany, threadIdOf } from "../intake/companies.ts";
import { giveDomain } from "../intake/discover.ts";
import { siteFor } from "../intake/search.ts";

/**
 * Move a stand-in thread to its company's real one: renamed when that doesn't exist, else its log
 * lines (ids and times kept) and apply folders added to it, and the stand-in removed.
 */
export function adopt(from: string, to: string): void {
  if (from === to || !existsSync(paths.thread(from))) return;
  if (!existsSync(paths.thread(to))) renameSync(paths.thread(from), paths.thread(to));
  else {
    const lines = readFileSync(paths.log(from), "utf8").trim();
    if (lines) {
      const have = existsSync(paths.log(to)) ? readFileSync(paths.log(to), "utf8") : "";
      const sep = have && !have.endsWith("\n") ? "\n" : "";
      writeFileSync(paths.log(to), `${have}${sep}${lines}\n`);
    }
    const apply = path.join(paths.thread(from), "apply");
    if (existsSync(apply))
      for (const role of readdirSync(apply)) {
        const dest = path.join(paths.thread(to), "apply", role);
        if (existsSync(dest)) continue;
        mkdirSync(path.dirname(dest), { recursive: true });
        renameSync(path.join(apply, role), dest);
      }
    rmSync(paths.thread(from), { recursive: true, force: true });
  }
  index.reindex(from);
  index.reindex(to);
}

/** Is this stand-in waiting for its website: Work pressed, and nothing has ended it since? */
export function waiting(id: string): boolean {
  if (!isStandIn(id)) return false;
  const log = read(id);
  const work = log.findLast((e) => e.kind === "decision" && e.data.action === "work");
  if (!work) return false;
  const after = log.slice(log.indexOf(work) + 1);
  return !after.some((e) => isRunNote(e, "run_done") || isRunNote(e, "run_incomplete"));
}

let line: Promise<unknown> = Promise.resolve();

/**
 * Look for the stand-in's website, after any look already going. Resolves to the thread Work
 * should run on, or null when there's none (the thread then says why).
 */
export function findWebsite(standIn: string): Promise<string | null> {
  const next = line.then(async () => {
    if (!waiting(standIn)) return null;
    const c = companyOfThread(standIn);
    let to: string | null = null;
    let why = "no website found";
    try {
      if (c?.domain) to = threadIdOf(c);
      else if (c) {
        const found = await siteFor(c, new Date());
        if (!found) why = "no web search answered";
        else if ("proof" in found) {
          const id = giveDomain(c.id, found.proof.domain, found.proof.from);
          const now = getCompany(id);
          if (now?.domain && registrable(now.domain)) to = threadIdOf(now);
        }
      }
    } catch (err) {
      failure("worker", `website ${standIn}`, err);
      why = `run stopped: ${(err as Error).message}`.slice(0, 200);
    }
    if (to) {
      adopt(standIn, to);
      return to;
    }
    append(standIn, {
      actor: "worker",
      kind: "note",
      data: { event: "run_incomplete", final: true, text: why },
    });
    index.reindex(standIn);
    return null;
  });
  line = next.catch(() => {});
  return next;
}

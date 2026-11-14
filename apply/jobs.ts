// A week after you apply, check the posting still resolves: a role taken down or redirected
// to the board's front page within a week is a measure of the source (`jobsignal report`, measure 2).
import { existsSync, readdirSync } from "node:fs";
import { politeGet } from "../core/http.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import type { Job } from "../intake/types.ts";
import { applied } from "../report/measures.ts";
import { isLinkedIn } from "./linkedin.ts";

const PER_NIGHT = 20;
const trim = (p: string) => p.replace(/\/+$/, "");

export async function checkPostings(now = new Date()): Promise<string> {
  if (!existsSync(paths.threads())) return "nothing applied";
  let checked = 0;
  let gone = 0;
  for (const id of readdirSync(paths.threads())) {
    if (id.startsWith(".")) continue;
    const log = read(id);
    const done = new Set(
      log.filter((e) => e.kind === "note" && e.data.event === "posting_check").map((e) => e.data.url),
    );
    for (const a of applied(log)) {
      const url = String(a.data.url);
      // LinkedIn is never read: its postings aren't checked.
      if (done.has(url) || isLinkedIn(url) || now.getTime() - Date.parse(a.ts) < 7 * 86_400_000) continue;
      if (checked >= PER_NIGHT) return `${checked} postings checked · ${gone} gone · more tomorrow`;
      checked++;
      done.add(url);
      let data: Record<string, unknown>;
      try {
        const r = await politeGet(url, { accept: "text/html", maxBytes: 500_000 });
        // A closed posting often redirects to the board's front page instead of answering 404.
        const moved = trim(new URL(r.url).pathname) !== trim(new URL(url).pathname);
        data = { ok: !moved, status: r.status, ...(moved ? { moved_to: r.url } : {}) };
      } catch (err) {
        const status = (err as { status?: number }).status;
        // An answer from the site (404, 410) is gone; robots.txt or a timeout is unknown.
        data = status ? { ok: false, status } : { ok: null, error: (err as Error).message.slice(0, 120) };
      }
      if (data.ok === false) gone++;
      append(id, {
        actor: "apply",
        kind: "note",
        data: {
          event: "posting_check",
          url,
          ...data,
          text: data.ok
            ? "Posting still up a week on"
            : data.ok === false
              ? "Posting gone within a week"
              : "Posting couldn't be checked",
        },
      });
    }
  }
  return `${checked} postings checked · ${gone} gone`;
}

export const jobs: Job[] = [{ name: "posting-check", schedule: "nightly", run: () => checkPostings() }];

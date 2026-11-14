// Board poll, every tick when switched on: the Ashby boards in the boards table (ats/boards.csv)
// that aren't ours, a slice a tick (per_tick, default 40: the whole table about once a day), read by
// the same reader as refresh. A role that fits the profile, posted within postings.max_age_days and
// not already a signal is a lead, as board search makes one: named, and with the website its Ashby
// board states (domain_from "board"). A company that would be new is kept only when board search's
// employer check says the board's owner hires for its roles. A company we have is joined only on
// that website: one sharing just the name is skipped (a namesake's board would become its board).
// Ashby first: measured 2026-11-01 on 300 random boards, 8 fresh fitting roles per 100 Ashby
// boards (Greenhouse 2, Lever 2), and its board states the company's website. Free: no credits.
import { loadFilters, score } from "../../ats/filters.ts";
import { boardKey, readBoards as boardsTable, runBoards } from "../../ats/reader.ts";
import { loadConfig } from "../../core/config.ts";
import { DAY, open } from "../../core/db.ts";
import { htmlToText } from "../../core/http.ts";
import { getSecret } from "../../core/keychain.ts";
import { companyByDomain, companyByName } from "../../intake/companies.ts";
import { boardStates } from "../../intake/domain.ts";
import { normalizeUrl } from "../../intake/leads.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { readSourceState, writeSourceState } from "../../signals/state.ts";
import { checkEmployer, postingUrl, type Verdict } from "../board-search/index.ts";

const KEY = "board-poll";
const cfg = () => loadConfig().source[KEY] ?? {};
const perTick = () => Number(cfg().per_tick ?? 40);

// next: where the next slice starts; employers: the employer check's answer per board, asked once.
type State = { next?: number; employers?: Record<string, Verdict> };

// The steps that reach out, swappable in tests.
let deps = { runBoards, boardStates, checkEmployer };
export function setDeps(d: Partial<typeof deps> | null): void {
  deps = d ? { ...deps, ...d } : { runBoards, boardStates, checkEmployer };
}

/** The Ashby boards of the table that aren't ours, in the table's order. */
function list(): { key: string; root: string; slug: string }[] {
  const ours = new Set((open().query("SELECT key FROM boards").all() as { key: string }[]).map((b) => b.key));
  return Object.values(boardsTable())
    .filter((b) => b.provider === "ashby")
    .map((b) => ({ key: boardKey("ashby", b.root), root: b.root, slug: b.slug }))
    .filter((b) => !ours.has(b.key));
}

const boardPoll: Source = {
  key: KEY,
  name: "Board poll",
  schedule: "every_tick",
  // Off until switched on in config ([source.board-poll] on = true); the employer check needs the key.
  connected: () => !!cfg().on && !!getSecret("anthropic"),
  status: () => `${list().length} Ashby boards · ${perTick()} a tick`,
  fetch: async (_since, now = new Date()) => {
    const all = list();
    const state = readSourceState<State>(KEY, {});
    const start = all.length ? (state.next ?? 0) % all.length : 0;
    const slice = all.slice(start, start + perTick());
    if (slice.length < perTick()) slice.push(...all.slice(0, Math.min(start, perTick() - slice.length)));
    const filters = loadFilters();
    const maxAge = loadConfig().postings.max_age_days * DAY;
    const isSignal = open().query("SELECT 1 FROM signals WHERE ref = ?");
    const employers = state.employers ?? {};
    const leads: Lead[] = [];
    let unnamed = 0;
    let namesakes = 0;
    let others = 0; // agencies and job boards
    let unchecked = 0; // the model couldn't answer: asked again on the next round
    const results = await deps.runBoards(
      "scan",
      slice.map((b) => ({ domain: b.key, name: b.slug, ats: { provider: "ashby", careers_url: b.root } })),
    );
    const roots = new Map(slice.map((b) => [b.key, b.root]));
    for (const r of results) {
      const root = roots.get(r.domain);
      if (!r.ok || !root) continue;
      const jobs = r.jobs ?? [];
      const hits = jobs.flatMap((j) => {
        const url = postingUrl(j.url);
        const fresh = j.postedAt && now.getTime() - Date.parse(j.postedAt) <= maxAge;
        return url && fresh && score(j, filters).fits && !isSignal.get(normalizeUrl(url))
          ? [{ ...j, url }]
          : [];
      });
      if (!hits.length) continue;
      const states = await deps.boardStates(root);
      if (!states?.name) {
        unnamed++;
        continue;
      }
      const known = states.site ? companyByDomain(states.site) : null;
      if (!known && companyByName(states.name)) {
        namesakes++;
        continue;
      }
      if (!known) {
        if (!employers[root]) {
          try {
            employers[root] = await deps.checkEmployer({
              name: states.name,
              board: root,
              title: hits[0]!.title,
              location: hits[0]!.location,
              text: htmlToText(hits[0]!.description ?? "").slice(0, 1500),
              titles: [...new Set(jobs.map((j) => j.title))].slice(0, 40),
            });
          } catch {
            unchecked++;
            continue;
          }
        }
        if (employers[root]!.is !== "employer") {
          others++;
          continue;
        }
      }
      for (const j of hits)
        leads.push({
          url: j.url,
          title: j.title,
          ...(j.location ? { location: j.location } : {}),
          text: [j.title, j.location || "location unknown"].join(" · "),
          company_hint: states.name,
          ...(states.site ? { domain: states.site, domain_from: "board" as const } : {}),
          kind: "posting",
          ...(j.postedAt ? { posted_at: j.postedAt } : {}),
          seen_at: now.toISOString(),
          source: KEY,
          source_tag: "Board poll",
        });
    }
    boardPoll.read = slice.length;
    boardPoll.note =
      [
        unnamed && `${unnamed} named by nothing`,
        namesakes && `${namesakes} sharing only a name`,
        others && `${others} not by their employer`,
        unchecked && `${unchecked} waiting for the employer check`,
      ]
        .filter(Boolean)
        .join(" · ") || undefined;
    writeSourceState(KEY, {
      next: all.length ? (start + slice.length) % all.length : 0,
      employers: Object.fromEntries(Object.entries(employers).slice(-3000)),
    });
    return leads;
  },
};

export default boardPoll;

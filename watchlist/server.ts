import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { cameAt, companyRoles, sinceWatched, WEEK_DAYS } from "../inbox/query.ts";
import {
  companyOfThread,
  fundingOf,
  getCompany,
  threadIdOf,
  upsertCompany,
  watchCompany,
  watchedCompanies,
} from "../intake/companies.ts";
import { changed, emit } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { addNow, boardOf, remove, resolve } from "./add.ts";

// Adds going now, by company id: the progress line the row shows.
const adding = new Map<string, string>();
export function progress(key: string, line: string | null) {
  if (line === null) adding.delete(key);
  else adding.set(key, line);
  emit("add.progress", { domain: key, line });
}

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : Number.NaN);

/**
 * Per watched company: roles that fit (open), all open roles, new ones (first seen this week and since you watched
 * it, not chosen yet), last read. One query.
 */
function counts(now = new Date()) {
  const cutoff = new Date(now.getTime() - WEEK_DAYS * 86_400_000).toISOString();
  const rows = open()
    .query(
      `SELECT c.id,
         (SELECT count(*) FROM roles r WHERE r.company_id = c.id AND r.fits = 1 AND r.closed_at IS NULL) AS fit,
         (SELECT count(*) FROM roles r WHERE r.company_id = c.id AND r.closed_at IS NULL) AS open,
         (SELECT count(*) FROM roles r WHERE r.company_id = c.id AND r.fits = 1 AND r.closed_at IS NULL
            AND r.state = 'new' AND ${cameAt("r.")} >= $cutoff
            AND ${sinceWatched(cameAt("r."), "c.watched_at")}) AS fresh,
         (SELECT max(last_read_at) FROM boards b WHERE b.company_id = c.id) AS last_read
       FROM companies c WHERE c.watched_at IS NOT NULL`,
    )
    .all({ cutoff }) as { id: number; fit: number; open: number; fresh: number; last_read: string | null }[];
  return new Map(rows.map((r) => [r.id, r]));
}

function company(id: number, n = counts().get(id)) {
  const c = getCompany(id);
  if (!c?.watched_at) return null;
  const thread = threadIdOf(c);
  const t = index.get(thread);
  const f = fundingOf(c);
  return {
    id: c.id,
    domain: c.domain,
    thread,
    name: c.name,
    board: boardOf(c),
    fit: n?.fit ?? 0,
    open: n?.open ?? 0, // every open role, fitting or not
    lastRead: n?.last_read ?? null,
    threadState: t
      ? {
          status: t.status,
          statusSince: t.statusSince,
          closeReason: t.closeReason,
          tonight: t.tonight,
          ran: t.ran,
          id: t.id,
        }
      : null,
    adding: adding.get(String(c.id)) ?? null,
    // New roles that fit, first seen this week and since you watched it, not chosen yet.
    fresh: n?.fresh ?? 0,
    funding: f ? { form: f.form, date: f.date, url: f.url } : null,
  };
}

const json = (b: unknown, status = 200) => Response.json(b, { status });

export const feature: ServerFeature = {
  name: "watchlist",
  routes: {
    "/api/watchlist": {
      GET: () => {
        const n = counts();
        return json({ companies: watchedCompanies().map((c) => company(c.id, n.get(c.id))) });
      },
    },
    "/api/watchlist/add": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as {
          input?: string;
          name?: string;
          board?: string; // a board URL pasted on the company page
          confirm?: boolean;
        };
        if (b.board && !/^https?:\/\/\S+$/.test(b.board.trim()))
          return json({ toast: "Paste the board's full URL" }, 400);
        let r: Awaited<ReturnType<typeof resolve>>;
        try {
          r = await resolve(String(b.board?.trim() || b.input || ""), b.name);
        } catch (err) {
          return json({ toast: (err as Error).message }, 400);
        }
        if (r.ask && !b.confirm) return json({ ask: r.ask, domain: r.domain, name: r.name });
        // The company exists as soon as Add starts: the answer carries its id so its page can open.
        const id = upsertCompany({ name: r.name, domain: r.domain });
        const key = String(id);
        progress(key, "adding · starting");
        void addNow(r, (line) => progress(key, `adding · ${line}`)).finally(() => {
          progress(key, null);
          emit("inbox.changed", {});
          emit("watchlist.changed", { company: id });
          const t = getCompany(id);
          if (t && index.get(threadIdOf(t))) changed(threadIdOf(t));
        });
        emit("watchlist.changed", { company: id });
        return json({ toast: `Adding ${r.name}${r.domain ? ` · ${r.domain}` : ""}`, company: id });
      },
    },
    "/api/watchlist/:cid": {
      GET: (req) => {
        const c = company(num(req.params.cid));
        if (!c) return json({ toast: "Not on the watchlist" }, 404);
        const url = new URL(req.url);
        return json({ ...c, ...companyRoles(c.id, { view: "fit", cursor: url.searchParams.get("cursor") }) });
      },
    },
    // Watch from a company's page, whatever was done there already (applied, worked on), and
    // with or without a website: the company is watched by its row.
    "/api/threads/:id/watch": {
      GET: (req) => {
        const c = companyOfThread(req.params.id);
        return json({ known: !!c, watched: !!c?.watched_at });
      },
      POST: (req) => {
        const c = companyOfThread(req.params.id);
        if (!c) return json({ toast: "This company isn't known yet" }, 404);
        watchCompany(c.id, "thread");
        emit("watchlist.changed", { company: c.id });
        emit("inbox.changed", {});
        return json({ toast: `Watching ${c.name}`, watched: true });
      },
    },
    // The thread's company and its board, for the drawer's Change its board.
    "/api/threads/:id/board": {
      GET: (req) => {
        const c = companyOfThread(req.params.id);
        return json(c ? { company: c.id, name: c.name, board: boardOf(c) } : { company: null });
      },
    },
    "/api/watchlist/:cid/remove": {
      POST: (req) => {
        const id = num(req.params.cid);
        if (!remove(id)) return json({ toast: "Not on the watchlist" }, 404);
        emit("watchlist.changed", { company: id });
        emit("inbox.changed", {});
        return json({ toast: `Removed ${getCompany(id)?.name ?? "it"} from the watchlist` });
      },
    },
  },
};

import { roleText } from "../ats/detail.ts";
import { open } from "../core/db.ts";
import { failure } from "../core/trace.ts";
import { getCompany } from "../intake/companies.ts";
import { discover, waiting } from "../intake/discover.ts";
import { ensureScored, type ReadOutcome, refreshAll, refreshCompany } from "../intake/refresh.ts";
import { changed, emit, toast } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { saveProfile } from "../setup/state.ts";
import { plainProblem } from "../watchlist/add.ts";
import { progress } from "../watchlist/server.ts";
import { type CompanyAction, chooseCompany, chooseRole, type RoleAction } from "./choose.ts";
import {
  companyRoles,
  inboxCompany,
  inboxCount,
  inboxMetros,
  inboxPage,
  inboxSources,
  inCity,
  knownMetro,
  otherCompany,
  othersPage,
} from "./query.ts";
import { searchHits } from "./search.ts";
import { reviewCount, reviewTitles, skipTitle, withTitle } from "./titles.ts";

const json = (b: unknown, status = 200) => Response.json(b, { status });
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : Number.NaN);
const flags = (req: Request, lists = true) => {
  const u = new URL(req.url);
  const view = u.searchParams.get("view") as "inbox" | "fit" | "all" | null;
  const remote = u.searchParams.get("remote") === "1";
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 80);
  const metro = knownMetro(u.searchParams.get("metro"));
  return {
    cursor: u.searchParams.get("cursor"),
    source: u.searchParams.get("source") || null,
    remote,
    // The search box's words, found once per request (every query of the request uses them).
    hits: q ? searchHits(q, { remote }) : null,
    metro,
    // The city's companies, likewise: each open role's location read once a request, not once a
    // query; not for a company's roles (`lists` false), which the city doesn't narrow.
    city: metro && lists ? inCity(metro) : null,
    view: view === "fit" || view === "all" ? view : ("inbox" as const),
  };
};

const said = (outs: ReadOutcome[]) => {
  const added = outs.reduce((n, o) => n + o.added, 0);
  const closed = outs.reduce((n, o) => n + o.closed, 0);
  const failed = outs.filter((o) => o.status === "failed");
  if (failed.length) return `read failed: ${failed[0]!.error ?? "unknown"}`;
  if (!added && !closed) return "nothing new";
  return [added && `${added} new`, closed && `${closed} closed`].filter(Boolean).join(" · ");
};

// One Refresh all at a time; a company's Refresh waits on nothing (its boards' leases keep reads apart).
let refreshing: Promise<unknown> | null = null;
const refreshingCompany = new Set<number>(); // a company's Refresh going now

/** A company's Refresh: its boards read now, or with none, a board looked for first. Says what changed. */
async function refreshOne(id: number): Promise<{ text: string; company: number }> {
  const c = getCompany(id)!;
  const hasBoard = open().query("SELECT 1 FROM boards WHERE company_id = ? AND status = 'ok'").get(id);
  let company = id;
  if (!hasBoard) {
    progress(String(id), "looking for a board");
    const found = await discover([c]);
    company = found[0]?.companyId ?? id;
    if (!found[0]?.board)
      return {
        text: `${c.name}: no job board yet: ${plainProblem(found[0]?.how ?? "no board found")}`,
        company,
      };
  }
  progress(String(id), "refreshing");
  const outs = await refreshCompany(company);
  return { text: `${c.name}: ${outs.length ? said(outs) : "already being read"}`, company };
}

/**
 * What an empty Inbox or Threads screen says is going on: companies still waiting for their board,
 * the companies you added (they're on the Watchlist, with the roles that fit), what the Inbox holds.
 */
function emptyHint() {
  const w = open()
    .query(
      `SELECT c.name, (SELECT count(*) FROM roles r WHERE r.company_id = c.id AND r.fits = 1
         AND r.closed_at IS NULL) AS fit
       FROM companies c WHERE c.watched_at IS NOT NULL ORDER BY c.watched_at DESC`,
    )
    .all() as { name: string; fit: number }[];
  return {
    waiting: waiting(),
    watched: w.length,
    watchedNames: w.slice(0, 3).map((c) => c.name),
    watchedFit: w.reduce((n, c) => n + c.fit, 0),
    inbox: inboxCount(),
  };
}

export const feature: ServerFeature = {
  name: "inbox",
  routes: {
    "/api/inbox/empty": { GET: () => json(emptyHint()) },
    // The top bar's count alone: what a change in the Inbox needs, not the whole board.
    "/api/inbox/count": { GET: () => json({ inbox: inboxCount() }) },
    "/api/inbox": {
      GET: (req) => {
        const f = flags(req);
        // `count` comes with the first page only.
        return json({ ...inboxPage(f), sources: inboxSources(), metros: inboxMetros() });
      },
    },
    "/api/inbox/companies/:cid": {
      GET: (req) => {
        const f = flags(req);
        return json({ company: inboxCompany(num(req.params.cid), f) });
      },
    },
    "/api/others": {
      GET: (req) => {
        const f = flags(req);
        return json(othersPage(f));
      },
    },
    "/api/others/companies/:cid": {
      GET: (req) => json({ company: otherCompany(num(req.params.cid), flags(req)) }),
    },
    // Review titles: the Inbox's line, and the page.
    "/api/review-titles/count": { GET: () => json(reviewCount()) },
    "/api/review-titles": {
      GET: () => json({ groups: reviewTitles({ seen: true }) }),
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { action?: string; key?: string; phrase?: string };
        const key = String(b.key ?? "").trim();
        const phrase = String(b.phrase ?? "").trim();
        if (b.action === "skip" && key) {
          skipTitle(key);
          return json({ toast: "Not offered again" });
        }
        if (b.action !== "add" || !phrase) return json({ toast: "Nothing to add" }, 400);
        const list = withTitle(phrase);
        if (!list) return json({ toast: `“${phrase}” is already one of your title words` }, 409);
        const fits = () =>
          (
            open().query("SELECT count(*) AS n FROM roles WHERE closed_at IS NULL AND fits = 1").get() as {
              n: number;
            }
          ).n;
        const before = fits();
        await saveProfile({ filters: { title_include: list } });
        ensureScored();
        const n = fits() - before;
        emit("inbox.changed", {});
        return json({
          toast: `Added “${phrase}” to your title words · ${n} more role${n === 1 ? "" : "s"} fit`,
        });
      },
    },
    "/api/companies/:cid/roles": {
      GET: (req) => json(companyRoles(num(req.params.cid), flags(req, false))),
    },
    "/api/roles/:rid/text": {
      GET: async (req) => {
        const text = await roleText(num(req.params.rid)).catch((err) => {
          failure("board", "role text", err);
          return null;
        });
        return json({ text });
      },
    },
    "/api/roles/:rid": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { action?: string };
        const r = chooseRole(num(req.params.rid), b.action as RoleAction);
        if (!r.ok) return json({ toast: r.toast }, r.status);
        if (r.thread) changed(r.thread);
        emit("rail.changed", {});
        return json(r);
      },
    },
    "/api/companies/:cid": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { action?: string };
        const r = chooseCompany(num(req.params.cid), b.action as CompanyAction);
        if (!r.ok) return json({ toast: r.toast }, r.status);
        if (r.thread) changed(r.thread);
        emit("watchlist.changed", { company: r.company });
        emit("rail.changed", {});
        return json(r);
      },
    },
    // Read one company's boards now; with none, look for one first. A read can take a minute
    // (a big board through its search), longer than a request stays open: the answer comes at
    // once, the progress line and the result over the live stream, as Refresh all's do.
    "/api/companies/:cid/refresh": {
      POST: (req) => {
        const id = num(req.params.cid);
        const c = getCompany(id);
        if (!c) return json({ toast: "That company isn't known" }, 404);
        if (refreshingCompany.has(id))
          return json({ toast: `${c.name} is already being refreshed`, company: id }, 409);
        refreshingCompany.add(id);
        progress(String(id), "refreshing");
        void refreshOne(id)
          .then(({ text, company }) => {
            toast(text);
            emit("watchlist.changed", { company });
          })
          .catch((err) => {
            failure("board", "refresh company", err);
            toast(`${c.name}: refresh failed: it's in the bug report`);
          })
          .finally(() => {
            refreshingCompany.delete(id);
            progress(String(id), null);
            emit("inbox.changed", {});
          });
        return json({ company: id }); // the row says "refreshing"; the result comes as a toast
      },
    },
    // Every active board due now, then read, with progress on the live stream.
    "/api/refresh": {
      POST: () => {
        if (refreshing) return json({ toast: "Refresh all is already running" }, 409);
        emit("refresh.progress", { done: 0, total: null, line: "starting" });
        refreshing = refreshAll(new Date(), (o) =>
          emit("refresh.progress", {
            done: o.done,
            total: o.total,
            line: `${o.name}: ${o.status === "failed" ? "failed" : o.added ? `${o.added} new` : o.status}`,
          }),
        )
          .then((outs) =>
            emit("refresh.progress", { done: outs.length, total: outs.length, line: null, said: said(outs) }),
          )
          .catch((err) => {
            failure("board", "refresh all", err);
            emit("refresh.progress", { line: null, said: "Refresh all failed: it's in the bug report" });
          })
          .finally(() => {
            refreshing = null;
            emit("inbox.changed", {});
            emit("rail.changed", {});
          });
        return json({ toast: "Refreshing every board" });
      },
    },
  },
};

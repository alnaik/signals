// The Signals screen's server half: each list a page at a time, the counts the folds show, and Hide.
// Dismiss, Watch, Work and Apply are the Inbox's own routes (inbox/server.ts, worker/server.ts).

import type { ServerFeature } from "../server/types.ts";
import { canStart, workCost } from "../worker/run.ts";
import {
  hideCompany,
  restage,
  signalsCompany,
  signalsPage,
  signalsSummary,
  VIEWS,
  type View,
} from "./query.ts";

const json = (b: unknown, status = 200) => Response.json(b, { status });
const filters = (req: Request) => {
  const u = new URL(req.url);
  return {
    source: u.searchParams.get("source") || null,
    q: (u.searchParams.get("q") ?? "").trim().slice(0, 80) || null,
    cursor: u.searchParams.get("cursor"),
  };
};
const view = (v: string): View | null => ((VIEWS as readonly string[]).includes(v) ? (v as View) : null);

export const feature: ServerFeature = {
  name: "signals",
  routes: {
    "/api/signals/summary": {
      GET: (req) => {
        restage();
        const f = filters(req);
        // What Work costs, said before it is pressed; or why it can't start.
        return json({ ...signalsSummary(f), work: workCost(), workBlocked: canStart() });
      },
    },
    "/api/signals/hide": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { id?: unknown; hide?: unknown };
        const id = Number(b.id);
        if (!Number.isInteger(id)) return json({ toast: "That company isn't known" }, 400);
        const hide = b.hide !== false;
        hideCompany(id, hide);
        return json({
          toast: hide ? "Hidden from Signals · a role that fits still reaches your Inbox" : "Back on Signals",
          company: id,
        });
      },
    },
    "/api/signals/:view": {
      GET: (req) => {
        const v = view(req.params.view);
        if (!v) return json({ toast: "No such list" }, 404);
        return json(signalsPage({ view: v, ...filters(req) }));
      },
    },
    // One company again after a choice on it: fresh, so a company that left goes at once.
    "/api/signals/:view/companies/:cid": {
      GET: (req) => {
        const v = view(req.params.view);
        if (!v) return json({ toast: "No such list" }, 404);
        restage();
        const { cursor: _, ...f } = filters(req);
        return json({ company: signalsCompany(Number(req.params.cid), { view: v, ...f }) });
      },
    },
  },
};

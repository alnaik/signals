import { changed, emit } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { decide } from "./decide.ts";

export const feature: ServerFeature = {
  name: "decisions",
  routes: {
    "/api/threads/:id/decision": {
      POST: async (req) => {
        const id: string = req.params.id;
        const body = await req.json().catch(() => ({}));
        const r = decide(id, body);
        if (!r.ok) return Response.json({ toast: r.toast }, { status: r.status });
        changed(id); // reindex now so the response and the next fetch agree
        if (r.company) emit("watchlist.changed", { company: r.company });
        return Response.json({ toast: r.toast, entry: r.entry });
      },
    },
  },
};

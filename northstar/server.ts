// The north star's routes: read it, keep it. The board's guard (server/guard.ts) checks the host
// and origin of the write, as for the profile.
import type { ServerFeature } from "../server/types.ts";
import { readStar, saveStar } from "./store.ts";

export const feature: ServerFeature = {
  name: "northstar",
  routes: {
    "/api/northstar": {
      GET: () => Response.json(readStar()),
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { text?: unknown };
        return Response.json(saveStar(b.text));
      },
    },
  },
};

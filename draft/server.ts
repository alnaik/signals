// The thread's message: one route, one press at a time per thread.
import { OverCap } from "../core/model.ts";
import { failure } from "../core/trace.ts";
import { changed } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { press } from "./write.ts";

const busy = new Set<string>();

export const feature: ServerFeature = {
  name: "draft",
  routes: {
    "/api/draft/:id": {
      POST: async (req) => {
        const id: string = req.params.id;
        if (busy.has(id)) return Response.json({ toast: "Already writing" }, { status: 409 });
        const b = await req.json().catch(() => ({}));
        busy.add(id);
        try {
          const toast = await press(id, {
            ...(Number.isInteger(b.pick) ? { pick: b.pick } : {}),
            ...(b.again ? { again: true } : {}),
            ...(b.followup ? { followup: true } : {}),
          });
          changed(id);
          return Response.json({ toast });
        } catch (err) {
          if (!(err instanceof OverCap)) failure("draft", id, err);
          const toast =
            err instanceof OverCap
              ? "This month's spend cap is reached: no draft written"
              : (err as Error).message;
          return Response.json({ toast }, { status: 400 });
        } finally {
          busy.delete(id);
        }
      },
    },
  },
};

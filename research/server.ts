import { failure } from "../core/trace.ts";
import { changed } from "../server/hub.ts";
import type { Handler, ServerFeature } from "../server/types.ts";
import { addAsFact, addFact, search, searchProviders, watch, watches } from "./actions.ts";

// biome-ignore lint/suspicious/noExplicitAny: request bodies are free-form JSON, checked per route
type Body = Record<string, any>;

const json =
  (h: (id: string, body: Body) => unknown): Handler =>
  async (req) => {
    try {
      return Response.json(await h(req.params.id, await req.json().catch(() => ({}))));
    } catch (err) {
      failure("research", new URL(req.url).pathname, err);
      return Response.json({ toast: (err as Error).message }, { status: 400 });
    }
  };

export const feature: ServerFeature = {
  name: "research",
  routes: {
    "/api/research/providers": { GET: async () => Response.json(await searchProviders()) },
    "/api/research/:id/watches": { GET: (req) => Response.json(watches(req.params.id)) },
    "/api/research/:id/search": {
      POST: json((id, b) => search(id, String(b.query ?? "").trim(), b.providers ?? [])),
    },
    "/api/research/:id/fact": {
      POST: json((id, b) => {
        const e = addAsFact(id, b.result);
        changed(id);
        return { toast: e ? "Added as a fact" : "Already a fact on this thread" };
      }),
    },
    "/api/research/:id/yours": {
      POST: json(async (id, b) => {
        const toast = await addFact(id, b);
        changed(id);
        return { toast };
      }),
    },
    "/api/research/:id/watch": {
      POST: json((id, b) => {
        const list = watch(id, String(b.query ?? "").trim(), b.providers ?? [], !!b.on, b.seen ?? []);
        return { watches: list, toast: b.on ? "Watching: new results come in nightly" : "Stopped watching" };
      }),
    },
  },
};

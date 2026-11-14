import { detail } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import * as log from "../core/log.ts";
import { readState } from "../core/state.ts";
import { inboxCount } from "../inbox/query.ts";
import type { Route } from "./types.ts";

export const AGENTS = [
  { key: "intake", name: "Intake" },
  { key: "worker", name: "Worker" },
  { key: "linkcheck", name: "Link checker" },
];

export function boardPayload() {
  const state = readState();
  return {
    now: new Date().toISOString(),
    threads: index.all(),
    // Companies in the Inbox, watched ones with roles new since you watched them included.
    inbox: inboxCount(),
    agents: AGENTS.map((a) => ({ ...a, ...(state.agents[a.key] ?? { status: "idle", line: "idle" }) })),
  };
}

export const coreRoutes: Record<string, Route> = {
  "/api/board": { GET: () => Response.json(boardPayload()) },
  "/api/threads/:id": {
    GET: (req) => {
      const id: string = req.params.id;
      const entries = log.read(id);
      if (entries.length === 0) return new Response("Not found", { status: 404 });
      return Response.json(detail(id, entries));
    },
  },
};

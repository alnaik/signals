import { failure } from "../core/trace.ts";
import { changed, emit, toast } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import {
  type Events,
  findEmail,
  type Inputs,
  type Mode,
  markSeen,
  quote,
  recent,
  saveFound,
  startLookup,
  stopInterrupted,
  unseen,
} from "./lookup.ts";

const json = (b: unknown, status = 200) => Response.json(b, { status });
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : Number.NaN);
const modeOf = (m: unknown): Mode => (m === "people" ? "people" : "person");

// Every change goes to the board as "lookup.changed" (the panel and the button reload); the end of
// each press as a toast, so a lookup that finishes with the panel closed still says so.
const events: Events = {
  progress: (id, line) => emit("lookup.changed", { id, line }),
  done: (text) => {
    emit("lookup.changed", {});
    toast(text);
  },
};
const settle = (done: Promise<void>) =>
  void done.catch((err) => failure("board", "look up", err)).finally(() => emit("lookup.changed", {}));

export const feature: ServerFeature = {
  name: "lookup",
  routes: {
    "/api/lookups": {
      GET: () => json(recent()),
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { mode?: string } & Partial<Inputs>;
        try {
          const { id, done } = startLookup(modeOf(b.mode), b, events);
          settle(done);
          emit("lookup.changed", { id });
          return json({ id });
        } catch (err) {
          return json({ toast: (err as Error).message }, 400);
        }
      },
    },
    "/api/lookups/unseen": { GET: () => json({ unseen: unseen() }) },
    "/api/lookups/seen": {
      POST: () => {
        markSeen();
        emit("lookup.changed", {});
        return json({ ok: true });
      },
    },
    // What one press could cost: GET ?mode=person&company=…&name=…&role=… or mode=people&titles=a,b.
    "/api/lookups/quote": {
      GET: async (req) => {
        const u = new URL(req.url).searchParams;
        const titles = (u.get("titles") ?? "").split(",").filter(Boolean);
        return json(
          await quote(modeOf(u.get("mode")), {
            company: u.get("company") ?? "",
            name: u.get("name") ?? "",
            role: u.get("role") ?? "",
            titles,
          }),
        );
      },
    },
    "/api/lookups/:lid/email": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { n?: number; confirm?: boolean };
        try {
          const r = findEmail(num(req.params.lid), Number(b.n), !!b.confirm, events);
          if ("ask" in r) return json(r);
          settle(r.done);
          emit("lookup.changed", { id: num(req.params.lid) });
          return json({ ok: true });
        } catch (err) {
          return json({ toast: (err as Error).message }, 409);
        }
      },
    },
    "/api/lookups/:lid/save": {
      POST: async (req) => {
        const b = (await req.json().catch(() => ({}))) as { n?: number };
        const r = saveFound(num(req.params.lid), Number(b.n));
        if (!r.ok) return json({ toast: r.toast }, r.status);
        changed(r.thread);
        emit("rail.changed", {});
        emit("lookup.changed", {});
        return json(r);
      },
    },
  },
  // A lookup going when the server stopped is said so, never left running.
  start: () => {
    stopInterrupted();
    return undefined;
  },
};

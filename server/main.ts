// One Bun program serves the board and its API, bound to localhost only.
import { importAll } from "../core/features.ts";
import * as index from "../core/index-db.ts";
import { checkSignedIn } from "../core/model.ts";
import { ensureLayout } from "../core/paths.ts";
import { generateSlots } from "../scripts/gen.ts";
import { coreRoutes } from "./api.ts";
import { guardRoute } from "./guard.ts";
import type { Route, ServerFeature } from "./types.ts";

export async function startServer({ port = 4317, hostname = "127.0.0.1", dev = false } = {}) {
  ensureLayout();
  index.open();
  // Whether Claude Code is signed in is looked at now, in the background: no request waits on it.
  void checkSignedIn();
  await generateSlots();
  // Imported after generating slots so the board bundle sees every feature.
  const homepage = (await import("../board/index.html")).default;

  const features = (await importAll<{ feature?: ServerFeature }>("*/server.ts"))
    .map((m) => m.mod.feature)
    .filter((f): f is ServerFeature => !!f);
  const routes: Record<string, Route> = { ...coreRoutes };
  for (const f of features) Object.assign(routes, f.routes ?? {});
  let boundPort = port;
  for (const [path, r] of Object.entries(routes)) routes[path] = guardRoute(r, () => boundPort);

  const server = Bun.serve({
    port,
    hostname,
    development: dev,
    // biome-ignore lint/suspicious/noExplicitAny: Bun's route typing doesn't model a merged map
    routes: { "/": homepage, ...(routes as any) },
    fetch: () => new Response("Not found", { status: 404 }),
  });
  boundPort = server.port ?? port;
  const stops = features.map((f) => f.start?.()).filter((s): s is () => void => typeof s === "function");
  return {
    server,
    url: server.url.toString(),
    stop: () => {
      for (const s of stops) s();
      server.stop(true);
    },
  };
}

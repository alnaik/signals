import { listen } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { startWatcher } from "./watcher.ts";

const HEARTBEAT_MS = 5_000; // Bun.serve closes connections idle for 10s by default

export const feature: ServerFeature = {
  name: "live",
  start: startWatcher,
  routes: {
    "/api/events": {
      GET: (req, server) => {
        server.timeout(req, 0);
        const enc = new TextEncoder();
        let stop = () => {};
        const stream = new ReadableStream({
          start(controller) {
            const send = (chunk: string) => {
              try {
                controller.enqueue(enc.encode(chunk));
              } catch {
                stop();
              }
            };
            send("retry: 2000\n: connected\n\n");
            const unlisten = listen((event, data) =>
              send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
            const beat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
            stop = () => {
              unlisten();
              clearInterval(beat);
            };
            req.signal?.addEventListener("abort", stop);
          },
          cancel: () => stop(),
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      },
    },
  },
};

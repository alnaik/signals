// The board is for this Mac only: it answers to no other device, whatever config.toml says. A web
// page in any browser tab can still send requests to 127.0.0.1, so every API request must name
// this Mac's own Host (stops DNS rebinding), and a write must come from the board's own origin
// (stops cross-site requests). The one exception is the Job Signal extension, on its own routes
// (/api/ext/*).
import { failure } from "../core/trace.ts";
import { EXTENSION_ORIGIN } from "../extension/id.ts";
import type { Handler, Route } from "./types.ts";

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function refuse(req: Request, port: number): string | null {
  const hosts = allowedHosts(port);
  const host = req.headers.get("host") ?? "";
  if (!hosts.includes(host)) return "unknown host";
  // The extension's posts carry its origin, which no web page can send; a GET carries none, so
  // its routes are posts only.
  if (new URL(req.url).pathname.startsWith("/api/ext/")) {
    if (req.method !== "POST" || req.headers.get("origin") !== EXTENSION_ORIGIN)
      return "not the Job Signal extension";
    return null;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers.get("sec-fetch-site") === "cross-site") return "cross-site request";
    const origin = req.headers.get("origin");
    if (origin && !hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`))
      return "foreign origin";
  }
  return null;
}

function wrap(h: Handler, port: () => number): Handler {
  return async (req, server) => {
    const why = refuse(req, port());
    if (why) return new Response(`Refused: ${why}`, { status: 403 });
    // A thread id or watchlist domain in the path is a company domain, never "..%2F..": Bun
    // decodes %2F in params, and not every route builds its path through paths.thread.
    const params = (req as Request & { params?: Record<string, string> }).params ?? {};
    for (const v of [params.id, params.domain])
      if (v !== undefined && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v))
        return Response.json({ toast: "Not a company id" }, { status: 400 });
    // Anything a handler didn't catch is traced, and the board gets a plain answer.
    try {
      return await h(req, server);
    } catch (err) {
      failure("board", `${req.method} ${new URL(req.url).pathname}`, err);
      return Response.json({ toast: "That failed; it's in the bug report" }, { status: 500 });
    }
  };
}

export function guardRoute(r: Route, port: () => number): Route {
  if (typeof r === "function") return wrap(r, port);
  return Object.fromEntries(Object.entries(r).map(([m, h]) => [m, wrap(h as Handler, port)]));
}

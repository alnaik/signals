import type { Server } from "bun";

// biome-ignore lint/suspicious/noExplicitAny: Bun route handlers take varied request types
export type Handler = (req: any, server: Server<undefined>) => Response | Promise<Response>;
export type Route = Handler | Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>;

/** A feature's server half: `<feature>/server.ts` exports `feature`. */
export type ServerFeature = {
  name: string;
  routes?: Record<string, Route>;
  start?: () => (() => void) | undefined;
};

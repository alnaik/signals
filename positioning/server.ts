import { readFileSync } from "node:fs";
import path from "node:path";
import type { ServerFeature } from "../server/types.ts";
import { parse, readMarkdown, setPublic } from "./page.ts";

export const feature: ServerFeature = {
  name: "positioning",
  routes: {
    "/api/positioning": {
      GET: () => Response.json({ ...parse(), exists: readMarkdown().length > 0 }),
    },
    // The prompt that starts the page in a Claude chat, for the offer at the first Work.
    "/api/positioning/prompt": {
      GET: () =>
        Response.json({
          prompt: readFileSync(path.join(import.meta.dir, "../setup/positioning-prompt.txt"), "utf8"),
        }),
    },
    "/api/positioning/public": {
      POST: async (req) => {
        const b = await req.json();
        setPublic(String(b.id), !!b.on);
        return Response.json({ toast: b.on ? "Public · in the portfolio export" : "Private" });
      },
    },
  },
};

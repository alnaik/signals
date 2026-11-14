import type { ServerFeature } from "../server/types.ts";
import { bugReport, problems } from "./report.ts";

const DAY = 86_400_000;

export const feature: ServerFeature = {
  name: "report",
  routes: {
    "/api/report/problems": {
      GET: () => Response.json(problems(new Date(Date.now() - DAY))),
    },
    "/api/report": {
      GET: async () => new Response(await bugReport(24), { headers: { "content-type": "text/markdown" } }),
    },
  },
};

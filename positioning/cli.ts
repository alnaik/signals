import { writeFileSync } from "node:fs";
import path from "node:path";
import { profile } from "../apply/me.ts";
import type { Command } from "../core/features.ts";
import { portfolioHtml } from "./page.ts";

export const commands: Record<string, Command> = {
  portfolio: {
    summary: "Export the public items of the positioning page as a portfolio page (portfolio [out.html])",
    run: ([out]) => {
      const file = path.resolve(out ?? "portfolio.html");
      writeFileSync(file, portfolioHtml(String(profile().full_name ?? "Portfolio")));
      console.log(`Wrote ${file} (public items only)`);
    },
  },
};

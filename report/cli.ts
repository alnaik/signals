import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "../core/features.ts";
import { dataDir } from "../core/paths.ts";
import { bugReport } from "./report.ts";

export const commands: Record<string, Command> = {
  report: {
    summary:
      "Write a report: what failed lately and why, the four measures, spend (report [hours], default 24)",
    run: async ([hours]) => {
      const text = await bugReport(Number(hours) || 24);
      const file = path.join(
        dataDir(),
        "logs",
        `bug-report-${new Date().toISOString().slice(0, 16).replace(":", "")}.md`,
      );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(text);
      console.error(`\nSaved to ${file}. Paste it into Claude Code to have it looked at.`);
    },
  },
};

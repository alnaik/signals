import type { Command } from "../core/features.ts";
import { exportBoards } from "./table.ts";

export const commands: Record<string, Command> = {
  boards: {
    summary:
      "Write the boards table that ships with the app from this install's boards (boards export [file]; default ats/boards.csv)",
    run: ([sub, file]) => {
      if (sub !== "export")
        throw new Error("Usage: jobsignal boards export [file]   (default: ats/boards.csv)");
      const r = exportBoards(undefined, file);
      const by = Object.entries(r.byProvider).sort((a, b) => b[1] - a[1]);
      console.log(`Boards table: ${r.rows} boards written`);
      console.log(`  ${by.map(([p, n]) => `${p} ${n}`).join(", ")}`);
      for (const [why, n] of Object.entries(r.left)) console.log(`  left out: ${n} · ${why}`);
    },
  },
};

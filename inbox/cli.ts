import type { Command } from "../core/features.ts";
import { type ImportResult, importOld } from "../intake/import.ts";
import { repairOnce } from "../intake/repair.ts";

function report(r: ImportResult): string {
  return [
    `${r.companies} companies (${r.watched} watched) · ${r.boards} boards · ${r.roles} roles · ${r.signals} signals (${r.pending} waiting for the classifier)`,
    ...(r.restored.length ? [`boards restored: ${r.restored.join(", ")}`] : []),
    ...(r.dismissed ? [`${r.dismissed} companies kept dismissed`] : []),
    ...(r.merged ? [`${r.merged} duplicate roles folded into one row per posting`] : []),
    ...r.skipped.map((s) => `not brought over: ${s}`),
    r.archive ? `old files archived in ${r.archive}` : "no old files left to archive",
  ].join("\n");
}

const run = (args: string[]) => {
  console.log(report(importOld({ archive: !args.includes("--keep") })));
  for (const line of repairOnce()) console.log(`repaired: ${line}`);
};

export const commands: Record<string, Command> = {
  migrate: {
    summary:
      "Fold the files from before jobsignal.db into it, then archive them (safe to run again; --keep: don't archive)",
    run,
  },
  db: {
    summary: "jobsignal.db: db import (the same as migrate)",
    run: ([sub, ...rest]) => {
      if (sub !== "import") throw new Error("Usage: jobsignal db import [--keep]");
      run(rest);
    },
  },
};

import type { Command } from "../core/features.ts";
import { dataDir } from "../core/paths.ts";
import { queue } from "./queue.ts";
import { claudeArgs, runWorker } from "./run.ts";

export const commands: Record<string, Command> = {
  work: {
    summary: "Run the worker on a thread now (work <thread> [--interactive]), or list the queue",
    run: async (args) => {
      const id = args.find((a) => !a.startsWith("--"));
      if (!id) {
        for (const q of queue()) console.log(q);
        return;
      }
      if (args.includes("--interactive")) {
        // You run the skill yourself, on your subscription, with the same locked-down tools.
        const full = claudeArgs(id);
        const printOnly = new Set([
          "--output-format",
          "--max-turns",
          "--max-budget-usd",
          "--no-session-persistence",
        ]);
        const keep: string[] = [];
        let prompt = "";
        for (let j = 0; j < full.length; j++) {
          const a = full[j]!;
          if (a === "-p") prompt = full[++j]!;
          else if (printOnly.has(a)) j += a === "--no-session-persistence" ? 0 : 1;
          else keep.push(a);
        }
        const { ANTHROPIC_API_KEY: _, ...env } = process.env;
        const p = Bun.spawn(["claude", ...keep, prompt], {
          stdio: ["inherit", "inherit", "inherit"],
          env: { ...env, JOBSIGNAL_DATA: dataDir() },
        });
        await p.exited;
        return;
      }
      console.log(JSON.stringify(await runWorker(id)));
    },
  },
};

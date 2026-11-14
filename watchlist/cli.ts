import type { Command } from "../core/features.ts";
import { addNow, fitting, resolve } from "./add.ts";

export const commands: Record<string, Command> = {
  add: {
    summary:
      "Watch a company and read its board now (add <website, board URL, posting or name> [--name X] [--yes])",
    run: async (args) => {
      const yes = args.includes("--yes");
      const n = args.indexOf("--name");
      const name = n >= 0 ? args[n + 1] : undefined;
      const input = args.filter((a, i) => a !== "--yes" && (n < 0 || (i !== n && i !== n + 1))).join(" ");
      if (!input) throw new Error("Usage: jobsignal add <website, board URL, posting or company name>");
      const r = await resolve(input, name);
      if (r.ask && !yes) {
        console.log(`${r.ask} Run again with --yes to add it.`);
        return;
      }
      const { companyId, board: b } = await addNow(r, (line) => console.log(`· ${line}`));
      console.log(
        `${r.name}${r.domain ? ` (${r.domain})` : ""}: ${b.provider ? `${b.provider} · ${b.url}` : `no board found${b.problem ? ` · ${b.problem}` : " · paste a board URL"}`}`,
      );
      for (const j of fitting(companyId))
        console.log(`  ${j.title} · ${j.location || "location unknown"}\n    ${j.url}`);
    },
  },
};

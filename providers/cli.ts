import { loadConfig } from "../core/config.ts";
import type { Command } from "../core/features.ts";
import { declaredCost, getProvider, isAvailable, loadProviders, read, search } from "./registry.ts";
import { openThreadIds, runOnThread } from "./run.ts";

export const commands: Record<string, Command> = {
  providers: {
    summary: "List providers: available or not, and per capability its price and whether it's in the order",
    run: async () => {
      const order = loadConfig().providers;
      for (const p of await loadProviders()) {
        const caps = (["search", "read", "people", "contact"] as const).filter((c) => p[c]);
        console.log(
          `${isAvailable(p) ? "●" : "○"} ${p.name.padEnd(14)} ${p.key ? `key: ${p.key}` : ""}`.trimEnd(),
        );
        for (const c of caps) {
          const usd = declaredCost(p, c);
          const price = usd === undefined ? "—" : usd === 0 ? "free" : `$${Number(usd.toFixed(4))}`;
          console.log(
            `    ${c.padEnd(8)} ${price.padEnd(8)} ${order[c]?.includes(p.name) ? "✓ in order" : ""}`,
          );
        }
      }
    },
  },
  provider: {
    summary: "Use a provider (provider search <q> | read <url> | run <name> <thread|--all-open>)",
    run: async ([sub, ...rest]) => {
      const ctx = { station: "cli" };
      if (sub === "search") console.log(JSON.stringify(await search(rest.join(" "), { n: 5 }, ctx), null, 2));
      else if (sub === "read")
        console.log(JSON.stringify(await read(rest[0]!, {}, ctx), null, 2).slice(0, 4000));
      else if (sub === "run") {
        const p = await getProvider(rest[0]!);
        if (!p) throw new Error(`No provider ${rest[0]}`);
        const ids = rest[1] === "--all-open" ? openThreadIds() : [rest[1]!];
        for (const id of ids) console.log(`${id}: +${await runOnThread(id, p)} from ${p.label}`);
      } else
        console.log(
          "Usage: jobsignal provider search <query> | read <url> | company <name> | run <name> <thread|--all-open>",
        );
    },
  },
};

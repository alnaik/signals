import type { Command } from "../core/features.ts";
import { recent } from "./lookup.ts";

export const commands: Record<string, Command> = {
  lookups: {
    summary: "The board's recent Look ups: who or what was asked, what was found, what it cost",
    run: () => {
      const { lookups } = recent();
      if (!lookups.length) console.log("No lookups yet: Look up is in the board's top bar.");
      for (const l of lookups) {
        const r = l.results;
        const asked =
          l.mode === "person"
            ? `${l.inputs.name} at ${r?.company.name ?? l.inputs.company}`
            : `${(l.inputs.titles ?? []).join(", ")} at ${r?.company.name ?? l.inputs.company}`;
        console.log(
          `${l.started_at.slice(0, 16).replace("T", " ")} · ${l.status} · $${l.usd.toFixed(3)} · ${asked}`,
        );
        if (r?.error) console.log(`  ${r.error}`);
        for (const p of r?.people ?? []) {
          const email = p.hits?.find((h) => h.channel === "email");
          console.log(
            `  ${p.name}${p.role ? `, ${p.role}` : ""}${email ? ` · ${email.value} (${email.confidence})` : ""}${p.saved ? ` · saved to ${p.saved}` : ""}`,
          );
        }
      }
    },
  },
};

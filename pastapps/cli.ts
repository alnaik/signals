import type { Command } from "../core/features.ts";
import { importAll } from "./drop.ts";
import { mailToPast } from "./formats.ts";

export const commands: Record<string, Command> = {
  past: {
    summary: "Import past applications from the Gmail job label (past gmail [days])",
    run: async ([sub, days]) => {
      if (sub !== "gmail") {
        console.log(
          "Usage: jobsignal past gmail [days]   (notebook CSVs and .mbox files go in the drop folder)",
        );
        return;
      }
      const gmail = await import("../gmail/client.ts" as string).catch(() => null);
      if (!gmail?.isConnected?.()) throw new Error("Gmail isn't connected (jobsignal gmail connect)");
      const after = new Date(Date.now() - Number(days ?? 730) * 86_400_000);
      const mails = await gmail.search({ label: true, after, max: 500 });
      const list = mails.flatMap(
        (m: { from: string; fromName: string; subject: string; date: string; body: string }) => {
          const p = mailToPast(m, m.body);
          return p ? [{ ...p, source: "gmail" }] : [];
        },
      );
      console.log(JSON.stringify(await importAll(list)));
    },
  },
};

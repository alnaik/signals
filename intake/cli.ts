import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../core/config.ts";
import type { Command } from "../core/features.ts";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { entries, monthSpend } from "../core/ledger.ts";
import { lockHolder } from "../core/lock.ts";
import { dataDir } from "../core/paths.ts";
import { describeRow, spendNow } from "../report/spend.ts";
import * as launchd from "../scripts/launchd.ts";
import { runBatch, stopBatch } from "./batch.ts";
import { repairBoards, repairName } from "./cleanup.ts";
import { repairOffline } from "./offline.ts";
import { discoverSources, lock, runSource, tick } from "./run.ts";

function sum(list: { usd: number }[]) {
  return list.reduce((s, e) => s + e.usd, 0);
}
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export const commands: Record<string, Command> = {
  tick: {
    summary: "Run every due source and job once (launchd calls this); --now runs the six-hour sources now",
    run: async (args) => {
      // Before first-run setup is finished there are no filters yet: whatever was read would be
      // read for nobody (HN's whole thread into the Inbox). The installer starts the schedule first.
      if (!existsSync(path.join(dataDir(), "setup.json"))) {
        console.log("Setup isn't finished on the board yet: nothing is read until it is.");
        return;
      }
      await tick(new Date(), console.log, { now6h: args.includes("--now") });
    },
  },
  "find-boards": {
    summary:
      "Look for the job board of every company waiting, now, beside the ticks (Sources' Find their boards now); --stop ends a run after the companies in hand",
    run: async (args) => {
      if (args.includes("--stop")) return console.log(stopBatch());
      if (!existsSync(path.join(dataDir(), "setup.json"))) {
        console.log("Setup isn't finished on the board yet: nothing is read until it is.");
        return;
      }
      await runBatch();
    },
  },
  repair: {
    summary:
      "Undo what a time with no internet marked as failed (repair offline <from> <to> [--dry], times in ISO, e.g. 2026-11-13T10:55:00Z); put right the boards the boards table refuses (repair boards [--dry]); rename a company (repair name <id> <name> [--dry])",
    run: async ([what, from, to, ...rest]) => {
      if (what === "boards" || what === "name") {
        const args = [from, to, ...rest].filter((x): x is string => x !== undefined);
        const dry = args.includes("--dry");
        const words = args.filter((x) => x !== "--dry");
        if (what === "name" && !(Number.isInteger(Number(words[0])) && words.length > 1))
          throw new Error("Usage: jobsignal repair name <company id> <new name> [--dry]");
        // Never beside a read: it writes the boards a read writes.
        const release = dry ? () => {} : lock();
        if (!release || (!dry && lockHolder("batch") !== null)) {
          release?.();
          throw new Error("A read is running: try again when it's done");
        }
        try {
          const lines =
            what === "name"
              ? [repairName(Number(words[0]), words.slice(1).join(" "), { dry })]
              : await repairBoards({ dry });
          for (const l of lines) console.log(`${dry ? "Would: " : ""}${l}`);
          if (!lines.length) console.log("Nothing to put right");
        } finally {
          release();
        }
        return;
      }
      const [a, b] = [new Date(from ?? ""), new Date(to ?? "")];
      if (what !== "offline" || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a >= b)
        throw new Error(
          "Usage: jobsignal repair offline <from> <to> [--dry], the times in ISO, from before to",
        );
      const dry = rest.includes("--dry");
      // Never beside a read: it would write the same boards.
      const release = dry ? () => {} : lock();
      if (!release || (!dry && lockHolder("batch") !== null)) {
        release?.();
        throw new Error("A read is running: try again when it's done");
      }
      try {
        const r = repairOffline(a, b, { dry });
        console.log(
          `${dry ? "Would read again" : "Read again"}: ${r.boards} boards that failed for want of internet (${r.broken} marked broken), ${r.kept} of their companies keeping their board; ${r.companies} companies that found nothing back in line (with ${r.theirs} of their boards not working).${dry ? "" : " The span is remembered: its network failures leave the problems list."}`,
        );
      } finally {
        release();
      }
    },
  },
  source: {
    summary: "Run one source now and print its leads as JSON (source <key> [--intake])",
    run: async ([key, ...rest]) => {
      const src = (await discoverSources()).find((s) => s.key === key);
      if (!src) {
        console.error(`Sources: ${(await discoverSources()).map((s) => s.key).join(", ") || "none"}`);
        process.exit(1);
      }
      // A source's read writes the directory and snapshots: never beside a tick.
      const release = lock();
      if (!release) {
        console.error("A tick is running: try again when it's done.");
        process.exit(1);
      }
      try {
        if (rest.includes("--intake")) console.log(JSON.stringify(await runSource(src), null, 2));
        else console.log(JSON.stringify(await src.fetch(null), null, 2));
      } finally {
        release();
      }
    },
  },
  spend: {
    summary: "Show model and provider spend from the ledger",
    run: async () => {
      const all = entries();
      const caps = loadConfig().caps;
      const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
      console.log(`This month: ${usd(monthSpend())} of ${usd(caps.month_usd)} (real money only)`);
      console.log(`Last 7 days: ${usd(sum(all.filter((e) => e.ts >= week)))}`);
      for (const r of await spendNow()) {
        const [head, ...rest] = describeRow(r);
        console.log(`${r.label} · ${head}`);
        for (const l of rest) console.log(`  ${l}`);
      }
    },
  },
  schedule: {
    summary: "Install, remove or check the launchd agents (schedule install|uninstall|status)",
    run: ([sub]) => {
      if (sub === "install") for (const f of launchd.install()) console.log(`Installed ${f}`);
      else if (sub === "uninstall") launchd.uninstall();
      else for (const [k, v] of Object.entries(launchd.status())) console.log(`${k}: ${v}`);
    },
  },
  key: {
    summary: "Store a key in the Keychain from stdin (key set|delete <name>)",
    run: async ([sub, name]) => {
      if (!name) throw new Error("Usage: jobsignal key set|delete <name>   (value on stdin)");
      if (sub === "delete") return deleteSecret(name);
      const value = (await Bun.stdin.text()).trim();
      if (!value) throw new Error("No value on stdin. Example: pbpaste | jobsignal key set anthropic");
      setSecret(name, value);
      console.log(`Stored ${name} in the Keychain.`);
    },
  },
};

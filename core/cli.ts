import { writeStarterConfig } from "./config.ts";
import { exportData } from "./export.ts";
import type { Command } from "./features.ts";
import { close, rebuild } from "./index-db.ts";
import { dataDir, ensureLayout, isCloudSynced } from "./paths.ts";

export const commands: Record<string, Command> = {
  version: {
    summary: "Print the Job Signal version",
    run: async () => {
      const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
      console.log(pkg.version);
    },
  },
  init: {
    summary: "Create the data folder layout and a starter config.toml",
    run: () => {
      const root = ensureLayout();
      if (isCloudSynced(root)) console.warn(`Warning: ${root} looks cloud-synced; SQLite can corrupt there.`);
      writeStarterConfig();
      console.log(`Data folder ready: ${root}`);
    },
  },
  reindex: {
    summary: "Rebuild index.db from the thread folders",
    run: () => {
      ensureLayout();
      const n = rebuild();
      close();
      console.log(`Indexed ${n} threads from ${dataDir()}`);
    },
  },
  export: {
    summary: "Zip the data folder (export [dir])",
    run: async (args) => console.log(await exportData(args[0])),
  },
};

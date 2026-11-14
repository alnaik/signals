import type { Command } from "../core/features.ts";
import { failure } from "../core/trace.ts";
import { buildExtension } from "../extension/build.ts";
import { learnAll } from "../extension/server.ts";
import { startServer } from "./main.ts";

export const commands: Record<string, Command> = {
  serve: {
    summary: "Run the board on localhost (serve [--port N] [--dev])",
    run: async (args) => {
      const i = args.indexOf("--port");
      const port = i >= 0 ? Number(args[i + 1]) : 4317;
      const { url } = await startServer({ port, dev: args.includes("--dev") });
      console.log(`Signal Board on ${url}`);
      // Stopping (launchd's SIGTERM on a restart, Ctrl-C): what open forms hold is learned first.
      for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.once(signal, () => {
          learnAll();
          process.exit(0);
        });
      // The folder Chrome loads the extension from, rebuilt so an update reaches it.
      await buildExtension(port).catch((err) => failure("board", "extension build", err));
    },
  },
};

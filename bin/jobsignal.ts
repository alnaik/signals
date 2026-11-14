#!/usr/bin/env bun
// The one command. Subcommands come from features: any `<feature>/cli.ts` that
// exports `commands` is picked up, so removing a feature folder removes its commands.
import { loadCommands } from "../core/features.ts";

const [name, ...args] = process.argv.slice(2);
const commands = await loadCommands();

if (!name || name === "help" || !commands[name]) {
  if (name && name !== "help") console.error(`Unknown command: ${name}\n`);
  console.log("Usage: jobsignal <command>\n");
  for (const [cmd, c] of Object.entries(commands).sort()) console.log(`  ${cmd.padEnd(14)} ${c.summary}`);
  process.exit(name && name !== "help" ? 1 : 0);
}

// A command that fails says why in one plain sentence and exits 1; the stack is for developers
// (JOBSIGNAL_DEBUG=1) and the failure log.
try {
  await commands[name].run(args);
} catch (err) {
  if (process.env.JOBSIGNAL_DEBUG) console.error(err);
  else console.error(plain(err));
  process.exit(1);
}

function plain(err: unknown): string {
  const msg =
    (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim() || "Something went wrong";
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}

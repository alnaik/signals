// Feature discovery. Each feature lives in its own top-level folder and plugs in
// through optional files, found by glob at runtime:
//   <feature>/cli.ts      export const commands: Record<string, Command>
//   <feature>/server.ts   export const feature: ServerFeature
// Reverting a feature's commit deletes its folder; nothing else names it.

import path from "node:path";
import { Glob } from "bun";

export const ROOT = path.resolve(import.meta.dir, "..");

export type Command = { summary: string; run: (args: string[]) => Promise<void> | void };

async function importAll<T>(pattern: string): Promise<{ file: string; mod: T }[]> {
  const files = await Array.fromAsync(new Glob(pattern).scan({ cwd: ROOT }));
  const skip = (f: string) => f.startsWith("node_modules/") || f.startsWith("vendor/");
  const out: { file: string; mod: T }[] = [];
  for (const file of files.filter((f) => !skip(f)).sort()) {
    out.push({ file, mod: (await import(path.join(ROOT, file))) as T });
  }
  return out;
}

export async function loadCommands(): Promise<Record<string, Command>> {
  const all: Record<string, Command> = {};
  for (const { file, mod } of await importAll<{ commands?: Record<string, Command> }>("*/cli.ts")) {
    for (const [name, cmd] of Object.entries(mod.commands ?? {})) {
      if (all[name]) throw new Error(`Command "${name}" defined twice (${file})`);
      all[name] = cmd;
    }
  }
  return all;
}

export { importAll };

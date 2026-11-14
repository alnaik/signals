import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../core/paths.ts";

const file = (key: string) => path.join(dataDir(), "sources", `${key}.json`);

export function readSourceState<T>(key: string, fallback: T): T {
  if (!existsSync(file(key))) return fallback;
  try {
    return JSON.parse(readFileSync(file(key), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeSourceState(key: string, value: unknown): void {
  mkdirSync(path.dirname(file(key)), { recursive: true });
  writeFileSync(`${file(key)}.tmp`, JSON.stringify(value));
  renameSync(`${file(key)}.tmp`, file(key));
}

// Where the data folder lives. Personal data never sits in the repo.
// Resolution: $JOBSIGNAL_DATA, then the path saved by first-run setup, then ~/JobSignal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const POINTER = path.join(os.homedir(), ".jobsignal");

export function dataDir(): string {
  if (process.env.JOBSIGNAL_DATA) return path.resolve(process.env.JOBSIGNAL_DATA);
  if (existsSync(POINTER)) {
    const saved = readFileSync(POINTER, "utf8").trim();
    if (saved) return saved;
  }
  return path.join(os.homedir(), "JobSignal");
}

export function saveDataDir(dir: string): void {
  writeFileSync(POINTER, `${path.resolve(dir)}\n`);
}

// Cloud-synced folders can corrupt SQLite mid-write (section 3, data location).
export function isCloudSynced(dir: string): boolean {
  const d = path.resolve(dir);
  return /Mobile Documents|iCloud|CloudStorage|Dropbox|Google Drive|OneDrive/i.test(d);
}

// A thread id is a company domain. Checked here, where every thread path is built, so an id
// from a URL or request body (say "../../me") can never reach outside threads/.
function threadDir(id: string): string {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(id)) throw new Error(`Not a thread id: ${id.slice(0, 80)}`);
  return path.join(dataDir(), "threads", id);
}

export const paths = {
  threads: () => path.join(dataDir(), "threads"),
  thread: (id: string) => threadDir(id),
  log: (id: string) => path.join(threadDir(id), "log.jsonl"),
  me: (file = "") => path.join(dataDir(), "me", file),
  drop: (sub = "") => path.join(dataDir(), "drop", sub),
  snapshots: (company = "") => path.join(dataDir(), "snapshots", company), // before jobsignal.db: read by the import only
  watchlist: () => path.join(dataDir(), "watchlist.json"), // likewise
  ledger: () => path.join(dataDir(), "ledger.jsonl"),
  sourceState: () => path.join(dataDir(), "sources", "state.json"),
  config: () => path.join(dataDir(), "config.toml"),
  index: () => path.join(dataDir(), "index.db"),
};

/** Create the folder layout from section 6. Safe to run repeatedly. */
export function ensureLayout(): string {
  const root = dataDir();
  for (const d of ["threads", "me", "drop/done", "drop/unreadable", "sources"]) {
    mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}

// SQLite index the board reads. A cache: delete index.db and it rebuilds from the folders.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { type Summary, summarize } from "./derive.ts";
import * as log from "./log.ts";
import { paths } from "./paths.ts";

let db: Database | null = null;
let dbPath = "";

// Bump VERSION when the table or a summary's fields change: an older index.db is dropped and rebuilt.
const VERSION = 6;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  status TEXT,
  last_ts TEXT NOT NULL,
  summary TEXT NOT NULL
);
`;

export function open(): Database {
  const file = paths.index();
  if (db && dbPath === file) return db;
  db?.close();
  let fresh = !existsSync(file);
  db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (user_version !== VERSION) {
    db.exec(`DROP TABLE IF EXISTS threads; PRAGMA user_version = ${VERSION};`);
    fresh = true;
  }
  db.exec(SCHEMA);
  dbPath = file;
  if (fresh) rebuild();
  return db;
}

export function close(): void {
  db?.close();
  db = null;
  dbPath = "";
}

export function reindex(id: string, now = new Date()): Summary | null {
  const d = open();
  const entries = log.read(id);
  if (entries.length === 0) {
    d.query("DELETE FROM threads WHERE id = ?").run(id);
    return null;
  }
  const s = summarize(id, entries, now);
  d.query(
    `INSERT INTO threads (id, status, last_ts, summary) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, last_ts=excluded.last_ts, summary=excluded.summary`,
  ).run(id, s.status, s.lastTs, JSON.stringify(s));
  return s;
}

export function threadIds(): string[] {
  if (!existsSync(paths.threads())) return [];
  return readdirSync(paths.threads(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(paths.log(d.name)))
    .map((d) => d.name);
}

export function rebuild(now = new Date()): number {
  const d = open();
  d.exec("DELETE FROM threads");
  const ids = threadIds();
  d.transaction(() => {
    for (const id of ids) reindex(id, now);
  })();
  return ids.length;
}

export function all(): Summary[] {
  const rows = open().query("SELECT summary FROM threads").all() as { summary: string }[];
  return rows.map((r) => JSON.parse(r.summary));
}

export function get(id: string): Summary | null {
  const row = open().query("SELECT summary FROM threads WHERE id = ?").get(id) as { summary: string } | null;
  return row ? JSON.parse(row.summary) : null;
}

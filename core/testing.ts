// Test helpers: a throwaway data folder per test file.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTable } from "../ats/reader.ts";
import { close as closeDb } from "./db.ts";
import { close } from "./index-db.ts";
import { setSignedIn } from "./model.ts";
import { setOnline } from "./online.ts";
import { ensureLayout } from "./paths.ts";

export function tempData(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jobsignal-test-"));
  process.env.JOBSIGNAL_DATA = dir;
  process.env.JOBSIGNAL_KEYCHAIN = "memory"; // tests never touch the real Keychain
  closeDb(); // the next test file opens its own data folder's database
  setSignedIn({ in: false, plan: null }); // never this Mac's Claude Code login: a test signs in itself
  setOnline(true); // never this Mac's network: a test goes offline itself
  setTable([]); // never the shipped boards table: a test gives its own rows
  ensureLayout();
  return {
    dir,
    cleanup: () => {
      close();
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Backup: zip the whole data folder. Time Machine covers the rest.
import path from "node:path";
import { dataDir } from "./paths.ts";

export async function exportData(outDir = process.cwd()): Promise<string> {
  const root = dataDir();
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.resolve(outDir, `JobSignal-${stamp}.zip`);
  // ditto ships with macOS and keeps metadata; --keepParent keeps the folder name inside.
  const p = Bun.spawnSync(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", root, out]);
  if (p.exitCode !== 0) throw new Error(`Export failed: ${p.stderr.toString()}`);
  return out;
}

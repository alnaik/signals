// Past-application files in the drop folder: the notebook CSV and a Takeout .mbox.
// The drop folder asks this module first (when F23 is present).
import { readFileSync } from "node:fs";
import path from "node:path";
import { mailToPast, mbox, notebookCsv } from "./formats.ts";
import { type ImportResult, importPast, type Past } from "./import.ts";

export async function importAll(list: Past[]): Promise<Record<ImportResult, number>> {
  const counts: Record<ImportResult, number> = { imported: 0, attached: 0, duplicate: 0, unresolved: 0 };
  for (const p of list) counts[(await importPast(p)).result]++;
  return counts;
}

export async function tryPast(file: string): Promise<{ format: string; kept: number; total: number } | null> {
  const name = path.basename(file).toLowerCase();
  let list: Past[] | null = null;
  let format = "";
  if (name.endsWith(".csv")) {
    list = notebookCsv(readFileSync(file, "utf8"));
    format = "past applications (notebook)";
  } else if (name.endsWith(".mbox")) {
    list = [];
    for (const { mail, body } of mbox(readFileSync(file, "utf8"))) {
      const p = mailToPast(mail, body);
      if (p) list.push(p);
    }
    format = "past applications (email)";
  }
  if (!list) return null;
  const c = await importAll(list);
  return { format, kept: c.imported + c.attached, total: list.length };
}

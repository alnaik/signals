// Your north star: one sentence you write in the board's margin, kept in me/north-star.json with
// the date you wrote it. It is yours alone: never sent to the model, a provider or anyone, and not
// in the bug report.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.ts";

export const MAX = 90;
export type NorthStar = { text: string; at: string | null };

/**
 * Plain text on one line (anything not text is none): no control or format characters (but an
 * emoji's joiner), spaces made one, 90 characters at most.
 */
export function clean(raw: unknown): string {
  const one = (typeof raw === "string" ? raw : "")
    .normalize("NFC")
    // The joiner inside an emoji (U+200D, in a person at a laptop) stays; other format marks go.
    .replace(/(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(one).slice(0, MAX).join("").trim();
}

const file = () => paths.me("north-star.json");

export function readStar(): NorthStar {
  try {
    if (!existsSync(file())) return { text: "", at: null };
    const j = JSON.parse(readFileSync(file(), "utf8")) as Partial<NorthStar>;
    return { text: clean(j.text), at: typeof j.at === "string" ? j.at : null };
  } catch {
    return { text: "", at: null };
  }
}

/** Keep the sentence (written whole, then moved in, so a crash never leaves half a file). */
export function saveStar(raw: unknown, now = new Date()): NorthStar {
  const star = { text: clean(raw), at: now.toISOString() };
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(`${file()}.tmp`, `${JSON.stringify(star)}\n`);
  renameSync(`${file()}.tmp`, file());
  return star;
}

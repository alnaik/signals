// Provider answers kept in jobsignal.db, so a paid question asked again is answered from here.
// A key is the question as the provider was asked it, in lower case with single spaces: two ways
// of writing the same question are one key.
import { DAY, open } from "../core/db.ts";

const normal = (key: string) => key.trim().toLowerCase().replace(/\s+/g, " ");

/** The raw answer kept for this question, if it was kept less than maxAgeDays ago. */
export function get<T>(
  provider: string,
  kind: string,
  key: string,
  maxAgeDays: number,
  now = new Date(),
): T | null {
  const kept = open()
    .query("SELECT answer, at FROM provider_answers WHERE provider = ? AND kind = ? AND key = ?")
    .get(provider, kind, normal(key)) as { answer: string; at: string } | null;
  if (!kept || now.getTime() - Date.parse(kept.at) >= maxAgeDays * DAY) return null;
  return JSON.parse(kept.answer) as T;
}

/** Keep a raw answer, replacing any older one for the same question. */
export function put(provider: string, kind: string, key: string, answer: unknown, now = new Date()): void {
  open()
    .query(
      "INSERT INTO provider_answers (provider, kind, key, answer, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, kind, key) DO UPDATE SET answer = excluded.answer, at = excluded.at",
    )
    .run(provider, kind, normal(key), JSON.stringify(answer), now.toISOString());
}

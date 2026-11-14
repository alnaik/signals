// The contact waterfall (section 9): public record, then paid people search, then email
// sources, stopping once a verified email is in hand. Channels from every step are merged,
// keeping the strongest confidence for each value.
import { call, ordered } from "./registry.ts";
import type { Confidence, ContactHit, PersonRef } from "./types.ts";

const RANK: Record<Confidence, number> = { verified: 3, pattern: 2, guessed: 1 };

export function merge(hits: ContactHit[]): ContactHit[] {
  const best = new Map<string, ContactHit>();
  for (const h of hits) {
    const key = `${h.channel}:${h.value.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || RANK[h.confidence] > RANK[prev.confidence]) best.set(key, h);
  }
  // At most one guessed or pattern email once a verified one exists: no noise next to it.
  const all = [...best.values()];
  const verifiedEmail = all.some((h) => h.channel === "email" && h.confidence === "verified");
  return all
    .filter((h) => !(verifiedEmail && h.channel === "email" && h.confidence !== "verified"))
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
}

export async function findContact(
  person: PersonRef,
  ctx: { station: string; thread?: string },
): Promise<{ hits: ContactHit[]; steps: string[] }> {
  const hits: ContactHit[] = [];
  const steps: string[] = [];
  for (const p of await ordered("contact")) {
    try {
      const found = await call(p, "contact", [person], ctx);
      hits.push(...found);
      steps.push(`${p.name}: ${found.length}`);
      // GitHub may reveal a profile the next providers can use.
      const gh = found.find((h) => h.channel === "github");
      if (gh && !person.github) person = { ...person, github: gh.value };
    } catch (err) {
      steps.push(`${p.name}: ${(err as Error).message.slice(0, 80)}`);
    }
    if (hits.some((h) => h.channel === "email" && h.confidence === "verified")) break;
  }
  return { hits: merge(hits), steps };
}

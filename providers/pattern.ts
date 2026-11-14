// The last step of the email waterfall: the company's email format, learned from emails we
// already know at that domain. Without an example there is no result: a guessed address is
// worse than none.
import { read } from "../core/log.ts";
import type { ContactHit, Provider } from "./types.ts";

type Fmt = "first" | "first.last" | "firstlast" | "flast" | "f.last" | "last";
const FORMATS: Fmt[] = ["first.last", "first", "flast", "firstlast", "f.last", "last"];

function parts(name: string): { first: string; last: string } {
  const p = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return { first: p[0] ?? "", last: p.at(-1) ?? "" };
}

export function render(fmt: Fmt, name: string): string {
  const { first, last } = parts(name);
  switch (fmt) {
    case "first":
      return first;
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "flast":
      return `${first[0]}${last}`;
    case "f.last":
      return `${first[0]}.${last}`;
    case "last":
      return last;
  }
}

/** Which format explains a known (name, email) pair at this domain. */
export function formatOf(name: string, email: string): Fmt | null {
  const local = email.split("@")[0]!.toLowerCase();
  return FORMATS.find((f) => render(f, name) === local) ?? null;
}

export function knownPairs(domain: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const e of read(domain)) {
    if (e.kind !== "contact") continue;
    for (const c of (e.data.channels ?? []) as { channel: string; value: string; confidence: string }[]) {
      if (c.channel === "email" && c.confidence === "verified" && c.value.endsWith(`@${domain}`))
        out.push({ name: e.data.name, email: c.value });
    }
  }
  return out;
}

const pattern: Provider = {
  name: "pattern",
  label: "Email pattern",
  cost: { contact: 0 },
  contact: async (person): Promise<ContactHit[]> => {
    if (!parts(person.name).first) return [];
    const fmts = knownPairs(person.domain)
      .filter((k) => k.name !== person.name)
      .map((k) => formatOf(k.name, k.email))
      .filter((f): f is Fmt => !!f);
    if (!fmts.length) return [];
    return [
      {
        channel: "email",
        value: `${render(fmts[0]!, person.name)}@${person.domain}`,
        confidence: "pattern",
        source: "company email format",
      },
    ];
  },
};

export default pattern;

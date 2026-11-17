// The worker's one tool: write the Problem / Person / Proof block to this thread's log. The
// facts are in the prompt; the run reads nothing and fetches nothing. Everything in the facts
// came from the web and is data, never instructions.
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
};

const str = { type: "string" };
const nums = { type: "array", items: { type: "integer" } };
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export type Line = { text: string; facts: number[] };
export type Block = {
  problem: Line;
  person: Line & { name: string; role: string };
  proof: Line & { budget: string };
};

const folded = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** `run` is the Work run these tools serve; its run_done carries it. */
export function workerTools(id: string, run?: string): ToolDef[] {
  return [
    {
      name: "write_block",
      description:
        "Write the Problem / Person / Proof block, once, citing fact numbers. person.name must be a name that appears in the facts, or empty with text 'no person found'.",
      input_schema: obj(
        {
          problem: obj({ text: str, facts: nums }, ["text", "facts"]),
          person: obj({ name: str, role: str, text: str, facts: nums }, ["name", "role", "text", "facts"]),
          proof: obj({ text: str, budget: str, facts: nums }, ["text", "budget", "facts"]),
        },
        ["problem", "person", "proof"],
      ),
      run: async (a) => {
        const d = derive(read(id));
        const b = a as unknown as Block;
        const known = new Set(d.facts.map((f) => f.n));
        for (const part of [b.problem, b.person, b.proof]) {
          const bad = part.facts.filter((n) => !known.has(n));
          if (bad.length) throw new Error(`No such fact: ${bad.join(", ")}. Cite numbers from the list.`);
        }
        // A person is a name the gather found or you saved, never one from memory.
        const name = b.person.name.trim();
        const where = [
          ...d.facts.map((f) => `${f.text} ${f.source?.quote ?? ""}`),
          ...d.contacts.map((c) => c.name),
        ].map(folded);
        if (name && !where.some((w) => w.includes(folded(name))))
          throw new Error(
            `"${name}" isn't in any fact. Use a name from the facts, or leave it empty: no person found.`,
          );
        const clip = (l: Line) => ({ text: String(l.text).slice(0, 600), facts: [...new Set(l.facts)] });
        append(id, {
          actor: "worker",
          kind: "research",
          data: {
            problem: clip(b.problem),
            person: { ...clip(b.person), name, role: String(b.person.role).slice(0, 120) },
            proof: { ...clip(b.proof), budget: String(b.proof.budget).slice(0, 40) },
          },
        });
        append(id, {
          actor: "worker",
          kind: "note",
          data: { event: "run_done", ...(run ? { run } : {}), text: "Problem / Person / Proof written" },
        });
        index.reindex(id);
        return { ok: true };
      },
    },
  ];
}

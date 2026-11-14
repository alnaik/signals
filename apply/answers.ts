// me/answers.jsonl, the answer bank: every open-ended answer you write, by question type.
// Reused automatically next time at zero tokens.
import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "../core/jsonl.ts";
import { paths } from "../core/paths.ts";

export type Answer = { ts: string; type: string; question: string; company: string; answer: string };

const TYPES: [string, RegExp][] = [
  [
    "why_company",
    /why (do you want to|are you interested in|this company|us\b|join)|what (excites|interests) you about/i,
  ],
  ["why_role", /why (this|the) role|interest(ed)? in (this|the) (role|position)/i],
  ["about_you", /tell us about yourself|introduce yourself|about you\b/i],
  ["proud_project", /proud|best (work|project)|project you('| a)re/i],
  ["salary", /salary|compensation|pay expectation/i],
  ["notice", /notice period|start date|when can you start|availability/i],
  ["sponsorship", /sponsor|visa/i],
  ["authorization", /authori[sz]ed to work|right to work|work permit/i],
  ["relocation", /relocat/i],
  ["referral", /how did you hear|\breferr/i],
  ["anything_else", /anything else|additional information/i],
];

/** A stable type for a question, so the same question in different words maps to one answer. */
export function questionType(question: string): string {
  for (const [type, re] of TYPES) if (re.test(question)) return type;
  return `q:${question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)}`;
}

export function answers(): Answer[] {
  const f = paths.me("answers.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Answer];
      } catch {
        return [];
      }
    });
}

/**
 * The latest answer of this type: from the same company if there is one, else any that doesn't
 * name the company it was written for.
 */
export function findAnswer(question: string, company: string): Answer | null {
  const type = questionType(question);
  const same = answers().filter((a) => a.type === type);
  return (
    same.filter((a) => a.company === company).at(-1) ??
    (type.startsWith("why_company") ? null : (same.filter((a) => !names(a)).at(-1) ?? null))
  );
}

const names = (a: Answer) =>
  !!a.company?.trim() &&
  new RegExp(`\\b${a.company.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(a.answer);

export function saveAnswer(question: string, company: string, answer: string): Answer {
  const a: Answer = { ts: new Date().toISOString(), type: questionType(question), question, company, answer };
  appendLine(paths.me("answers.jsonl"), a);
  return a;
}

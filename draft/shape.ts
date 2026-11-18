// The message shape (docs/how-it-works.md): what a draft may hold, checked in code. The model
// writes sentences; this file decides which of them enter the draft, in what order, and what the
// thread says is missing. Browser-safe: the board reads a thread's draft with it too.
import type { Detail, Fact } from "../core/derive.ts";
import type { Entry } from "../core/log.ts";

export const MAX_WORDS = 80;
export const MAX_FOLLOWUP_WORDS = 40;
export const MAX_SUBJECT_WORDS = 8;
export const BANNED = ["passionate", "I came across", "great fit", "I hope this finds you well", "excited"];
// The ask is one of two, written here: the model only picks which.
export const ASKS = {
  call: "Could I have fifteen minutes this week?",
  who: "Could you tell me who the right person for this is?",
} as const;
export type Ask = keyof typeof ASKS;

export type Evidence = { claim: string; url: string };
export type Part = "made" | "problem" | "done_before" | "ask";
export const PART_LABEL: Record<Part, string> = {
  made: "made",
  problem: "their problem",
  done_before: "done before",
  ask: "ask",
};
export type Sentence = { part: Part; text: string; facts: number[]; evidence: Evidence[] };
export type To = { name: string; address?: string; source?: string };
/** What sentence 1 offers: a proof built for them, or an item of your evidence list you picked. */
export type Made = { built: boolean; url: string; claim: string; fact?: string };

export type DraftData = {
  step: "draft";
  order: "proof" | "evidence";
  to: To;
  subject: string;
  greeting: string;
  sentences: Sentence[];
  signoff: string;
  missing: string[];
  words: number;
  made: Made;
};
export type FollowupData = {
  step: "followup";
  greeting: string;
  sentences: Sentence[];
  signoff: string;
  missing: string[];
  words: number;
};

/** Words as a reader counts them: anything with a letter or digit in it. A link is one word. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+(\.[a-z0-9-]+)+\/\S/i;
export const hasLink = (text: string) => LINK.test(text);
/** Links in a text, the sign-off's excluded by the caller. */
export function countLinks(text: string): number {
  return text.split(/\s+/).filter((t) => hasLink(t)).length;
}

export function bannedIn(text: string): string | null {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  return BANNED.find((b) => new RegExp(`\\b${b.toLowerCase()}\\b`).test(t)) ?? null;
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An item that existed before is never worded as made for this company. */
export function madeForThem(text: string, company: string): boolean {
  const names = [company, company.split(/\s+/)[0] ?? ""].filter((n) => n.length > 2).map(literal);
  const them = new RegExp(`\\b(for|to help) (you|your|${names.join("|")})\\b`, "i");
  return them.test(text) || /\b(with you in mind|specifically for|tailored|custom-built for)\b/i.test(text);
}

/** A link as written in the message: no https://, no www., no trailing slash. */
export const bare = (url: string) =>
  url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const endStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Shared mailboxes are never the address: careers@, jobs@, hello@ and the like. */
const SHARED =
  /^(careers?|jobs?|hello|hi|info|contact|team|hr|people|recruit(ing|ment|er)?|talent|hiring|apply|applications?|support|sales|press|admin|office|founders|general|enquiries|inquiries|no-?reply)$/i;
export const sharedMailbox = (address: string) => SHARED.test(address.split("@")[0] ?? "");

/** The person Work found, and an address only when it is verified and theirs alone. */
export function toLine(d: Detail): To | null {
  const name = (d.research?.person.name || d.contact?.name || "").trim();
  if (!name) return null;
  const fold = (x: string) => x.trim().toLowerCase();
  const c = d.contacts.find((x) => fold(x.name) === fold(name));
  const email = c?.channels.find(
    (ch) => ch.channel.toLowerCase() === "email" && ch.confidence === "verified" && !sharedMailbox(ch.value),
  );
  return email ? { name, address: email.value, source: email.source ?? email.url ?? "" } : { name };
}

/** A role is posted (open on its board), or the company was just funded: something to point at. */
export function hasTarget(d: Detail): boolean {
  return (
    d.roles.some((r) => r.status === "apply" || r.status === "applied") ||
    d.facts.some((f) => f.group === "money" && !f.failed)
  );
}

export const NO_PERSON = "No draft: Work named no one to write to.";
export const NO_TARGET = "No draft: no posted role or announced plan to point at.";
export const NO_EVIDENCE =
  "No draft: no evidence item fits and no proof is built. Build evidence first: add what you've made to your evidence list, or build the proof and mark it built.";
export const NO_DONE_BEFORE =
  "No draft: nothing in your evidence list shows where you've done this kind of work before. Build evidence first.";

/** Why no draft can be written before any model call, or null. */
export function blocker(d: Detail, evidence: Evidence[], proofBuilt: boolean): string | null {
  if (!toLine(d)) return NO_PERSON;
  if (!hasTarget(d)) return NO_TARGET;
  if (!proofBuilt && !evidence.some((e) => e.url)) return NO_EVIDENCE;
  if (evidence.length === 0) return NO_DONE_BEFORE;
  return null;
}

/** The model's draft, as its schema allows it. */
export type DraftAnswer = {
  subject: string;
  made: { text: string };
  problem: { text: string; facts: number[] };
  done_before: { text: string; evidence: number[] };
  ask: Ask;
};

export type Context = {
  company: string;
  to: To;
  made: Made;
  facts: Fact[];
  evidence: Evidence[]; // numbered from 1 in the prompt
  you: { name: string; link: string };
};

/** The sign-off: your name and one link. */
export function signoff(you: { name: string; link: string }): { text: string; missing: string[] } {
  const missing: string[] = [];
  if (!you.name) missing.push("missing: your name for the sign-off (Settings > About you)");
  if (!you.link)
    missing.push("missing: a link for the sign-off (your website or GitHub, in Settings > About you)");
  return { text: [you.name, you.link && bare(you.link)].filter(Boolean).join(" · "), missing };
}

/**
 * The checks, in code: which sentences enter the draft and in what order, what is missing, the
 * subject, the word count. Returns null when nothing in the evidence list backs "done before":
 * then there is no draft.
 */
export function assemble(a: DraftAnswer, c: Context): DraftData | null {
  const byN = new Map(c.facts.map((f) => [f.n, f]));
  const missing: string[] = [];
  const kept: Sentence[] = [];
  const keep = (s: Sentence, check: string | null) => {
    if (check) missing.push(`missing: ${PART_LABEL[s.part]} (${check})`);
    else kept.push(s);
  };
  const common = (text: string): string | null => {
    if (!text) return "nothing written";
    const b = bannedIn(text);
    if (b) return `it said "${b}"`;
    if (hasLink(text)) return "it had a link of its own; the body holds one";
    return null;
  };

  // Done before: an item of your evidence list, or no draft.
  const doneRefs = [...new Set(a.done_before.evidence)].filter((i) => c.evidence[i - 1]);
  const doneText = clean(a.done_before.text);
  if (!doneRefs.length || !doneText) return null;

  // Made: the built proof or the item you picked; its link added here, the only one in the body.
  const madeText = clean(a.made.text)
    .split(c.made.url)
    .join("")
    .split(bare(c.made.url))
    .join("")
    .replace(/[\s:,-]+$/, "")
    .replace(/[.]$/, "");
  const made: Sentence = {
    part: "made",
    text: madeText ? `${madeText}: ${bare(c.made.url)}.` : "",
    facts: [],
    evidence: c.made.built ? [] : [{ claim: c.made.claim, url: c.made.url }],
  };
  const madeCheck =
    common(madeText) ??
    (!c.made.built && madeForThem(madeText, c.company)
      ? `your item is worded as if made for ${c.company}`
      : null);

  // Their problem: resting on a fact Work holds whose source still says it.
  const probFacts = [...new Set(a.problem.facts)].filter((n) => byN.has(n));
  const problem: Sentence = {
    part: "problem",
    text: endStop(clean(a.problem.text)),
    facts: probFacts,
    evidence: [],
  };
  const probCheck =
    common(clean(a.problem.text)) ??
    (!probFacts.length || probFacts.some((n) => byN.get(n)!.failed)
      ? `no fact about ${c.company} backs it`
      : null);

  const done: Sentence = {
    part: "done_before",
    text: endStop(doneText),
    facts: [],
    evidence: doneRefs.map((i) => c.evidence[i - 1]!),
  };
  const doneCheck =
    common(doneText) ??
    (madeForThem(doneText, c.company) ? `your item is worded as if made for ${c.company}` : null);

  const ask: Sentence = { part: "ask", text: ASKS[a.ask] ?? ASKS.call, facts: [], evidence: [] };

  const order: DraftData["order"] = c.made.built ? "proof" : "evidence";
  const parts: [Sentence, string | null][] =
    order === "proof"
      ? [
          [made, madeCheck],
          [problem, probCheck],
          [done, doneCheck],
          [ask, null],
        ]
      : [
          [problem, probCheck],
          [made, madeCheck],
          [done, doneCheck],
          [ask, null],
        ];
  for (const [s, check] of parts) keep(s, check);

  // Subject: lowercase, eight words at most, the thing about you in brackets.
  let subject = clean(a.subject).toLowerCase();
  const subjectCheck =
    common(subject) ??
    (countWords(subject) > MAX_SUBJECT_WORDS
      ? "over eight words"
      : !/\(.+\)\s*$/.test(subject)
        ? "no thing about you in brackets"
        : null);
  if (subjectCheck) {
    missing.unshift(`missing: subject (${subjectCheck})`);
    subject = "";
  }

  const greeting = `${firstName(c.to.name)},`;
  const sign = signoff(c.you);
  missing.push(...sign.missing);
  return {
    step: "draft",
    order,
    to: c.to,
    subject,
    greeting,
    sentences: kept,
    signoff: sign.text,
    missing,
    words: countWords([greeting, ...kept.map((s) => s.text)].join(" ")),
    made: c.made,
  };
}

export type FollowupAnswer = { sentences: { text: string; facts: number[]; made: boolean }[] };

/** A follow-up: only what is new since the draft was copied, each sentence resting on it. */
export function assembleFollowup(
  a: FollowupAnswer,
  c: { to: To; newFacts: Fact[]; madeSince: string | null; you: { name: string; link: string } },
): FollowupData {
  const fresh = new Map(c.newFacts.map((f) => [f.n, f]));
  const kept: Sentence[] = [];
  const missing: string[] = [];
  let linked = false;
  for (const s of a.sentences.slice(0, 3)) {
    let text = clean(s.text);
    const facts = [...new Set(s.facts)].filter((n) => fresh.has(n) && !fresh.get(n)!.failed);
    const made = !!s.made && !!c.madeSince;
    const what = made ? "what you made since" : "a new fact";
    const b = bannedIn(text);
    let why: string | null = !text
      ? "nothing written"
      : b
        ? `it said "${b}"`
        : hasLink(text)
          ? "it had a link of its own"
          : !facts.length && !made
            ? "nothing new backs it"
            : null;
    if (!why && made && !linked) {
      text = `${text.replace(/[.\s:,-]+$/, "")}: ${bare(c.madeSince!)}.`;
      linked = true;
    } else if (!why && made) why = "a second link";
    if (why) missing.push(`missing: ${what} (${why})`);
    else kept.push({ part: made ? "made" : "problem", text: endStop(text), facts, evidence: [] });
  }
  const greeting = `${firstName(c.to.name)},`;
  const sign = signoff(c.you);
  return {
    step: "followup",
    greeting,
    sentences: kept,
    signoff: sign.text,
    missing: [...missing, ...sign.missing],
    words: countWords([greeting, ...kept.map((s) => s.text)].join(" ")),
  };
}

/** What Copy copies: supported sentences only, never a missing line. */
export function messageText(m: DraftData | FollowupData): string {
  const body = m.sentences.map((s) => s.text).join(" ");
  return [
    ...(m.step === "draft" && m.subject ? [`Subject: ${m.subject}`, ""] : []),
    m.greeting,
    "",
    body,
    "",
    m.signoff,
  ].join("\n");
}

/** A thread's message state, from its log. */
export type State = {
  proof: { url: string; ts: string } | null; // the proof marked built, latest
  last: Entry | null; // the latest draft, candidates or no-draft entry
  draft: Entry | null; // the latest draft written
  pick: Entry | null; // the latest evidence you picked
  candidates: Entry | null; // the latest evidence offered
  copied: string | null; // when a draft was first copied
  followup: Entry | null; // the latest follow-up or no-follow-up
  followupCopied: string | null;
};

export function draftState(entries: Entry[]): State {
  const s: State = {
    proof: null,
    last: null,
    draft: null,
    pick: null,
    candidates: null,
    copied: null,
    followup: null,
    followupCopied: null,
  };
  for (const e of entries) {
    const d = e.data ?? {};
    if (e.kind === "decision" && d.action === "proof_built" && d.url) s.proof = { url: d.url, ts: e.ts };
    if (e.kind === "decision" && d.action === "copy" && d.what === "draft") s.copied ??= e.ts;
    if (e.kind === "decision" && d.action === "copy" && d.what === "followup") s.followupCopied ??= e.ts;
    if (e.kind !== "draft") continue;
    if (d.step === "pick") s.pick = e;
    if (d.step === "candidates") s.candidates = e;
    if (d.step === "draft") s.draft = e;
    if (d.step === "draft" || d.step === "none" || d.step === "candidates") s.last = e;
    if (d.step === "followup" || d.step === "followup_none") s.followup = e;
  }
  return s;
}

/** What is new since the first draft was copied: facts, and a proof built since. */
export function sinceCopied(d: Detail, s: State): { facts: Fact[]; made: string | null } {
  if (!s.copied) return { facts: [], made: null };
  const at = s.copied;
  return {
    facts: d.facts.filter((f) => f.ts > at && !f.failed),
    made: s.proof && s.proof.ts > at ? s.proof.url : null,
  };
}

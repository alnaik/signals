import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { describe as describeEntry } from "../board/Drawer.tsx";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { appendLine } from "../core/jsonl.ts";
import { setSecret } from "../core/keychain.ts";
import { backgroundToday, entries } from "../core/ledger.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { decide } from "../decisions/decide.ts";
import {
  ASKS,
  assemble,
  assembleFollowup,
  blocker,
  type Context,
  clip,
  countLinks,
  type DraftAnswer,
  type DraftData,
  draftState,
  type FollowupData,
  messageText,
  NO_DONE_BEFORE,
  NO_EVIDENCE,
  NO_PERSON,
  NO_TARGET,
  quoteCheck,
  toLine,
} from "./shape.ts";
import { press } from "./write.ts";

// Invented company and people only. The model is mocked: no real model or network call.
const data = tempData();
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  setSecret("anthropic", "sk-test");
  writeFileSync(paths.config(), '[runner]\nmode = "claude-code-api-key"\n[caps]\nmonth_usd = 100\n');
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ full_name: "Sam Example", website: "https://example.com" }),
  );
  writeFileSync(
    paths.me("evidence.jsonl"),
    [
      {
        claim: "Built a claim checker that ties each line of an AI answer to its source",
        url: "https://example.com/claim",
      },
      { claim: "At Woodgrove, cut wrong answers reaching support by a third", url: "" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
});

let n = 0;
type Opts = { role?: boolean; person?: boolean; email?: "verified" | "pattern" | "guessed" | "shared" };
function thread(o: Opts = {}): string {
  const id = `fabrikam${++n}.dev`;
  const { role = true, person = true, email = "verified" } = o;
  append(id, {
    actor: "ats",
    kind: "signal",
    data: role
      ? { company: "Fabrikam", kind: "posting", title: "Software Engineer", source_tag: "greenhouse" }
      : { company: "Fabrikam", source_tag: "hn" },
    ...(role ? { source: { type: "page" as const, url: `https://${id}/jobs/1` } } : {}),
  });
  append(id, { actor: "board", kind: "decision", data: { action: "work" } });
  append(id, {
    actor: "gather",
    kind: "fact",
    data: { group: "hiring", text: "Posting: Software Engineer" },
    source: {
      type: "page",
      url: `https://${id}/jobs/1`,
      quote: "Trust in the reasons our agents give is the hard part.",
    },
  });
  if (person)
    append(id, {
      actor: "gather",
      kind: "contact",
      data: {
        name: "Priya Example",
        role: "Head of Engineering",
        confidence: "verified",
        channels: [
          {
            channel: "email",
            value: email === "shared" ? `careers@${id}` : `priya@${id}`,
            confidence: email === "shared" ? "verified" : email,
            source: "the team page",
          },
        ],
      },
    });
  append(id, {
    actor: "worker",
    kind: "research",
    data: {
      problem: { text: "Recruiters don't trust the agents' reasons", facts: [1] },
      person: person
        ? { name: "Priya Example", role: "Head of Engineering", text: "owns the agents", facts: [1] }
        : { name: "", role: "", text: "no person found", facts: [] },
      proof: { text: "a claim checker for their shortlists", budget: "a weekend", facts: [1] },
    },
  });
  append(id, { actor: "worker", kind: "note", data: { event: "run_done" } });
  index.reindex(id);
  return id;
}

const EXAMPLE: DraftAnswer = {
  subject: "Fabrikam agent evals (built a claim checker)",
  made: { text: "I built a small checker that ties each line of an AI answer to the source text behind it" },
  problem: {
    text: "Fabrikam’s agents hand recruiters shortlists with reasons, and your post on the Software Engineer role says trust in those reasons is the hard part",
    facts: [1],
  },
  done_before: {
    text: "I did the same kind of work at Woodgrove, where it cut wrong answers reaching support by a third",
    evidence: [2],
  },
  ask: "call",
};

function ctx(id: string, built: boolean): Context {
  const d = derive(read(id));
  return {
    company: "Fabrikam",
    to: toLine(d)!,
    made: built
      ? { built: true, url: "https://example.com/claim", claim: "a claim checker" }
      : {
          built: false,
          url: "https://example.com/claim",
          claim: "Built a claim checker",
          fact: d.facts[0]!.id,
        },
    facts: d.facts,
    evidence: [
      { claim: "Built a claim checker", url: "https://example.com/claim" },
      { claim: "At Woodgrove, cut wrong answers by a third", url: "" },
    ],
    you: { name: "Sam Example", link: "https://example.com" },
  };
}

test("the spec's example: made first when a proof is built, 71 / 80, one link, the ask added in code", () => {
  const m = assemble(EXAMPLE, ctx(thread(), true))!;
  expect(m.order).toBe("proof");
  expect(m.sentences.map((s) => s.part)).toEqual(["made", "problem", "done_before", "ask"]);
  expect(m.sentences[0]!.text).toEndWith("behind it: example.com/claim.");
  expect(m.sentences[3]!.text).toBe(ASKS.call);
  expect(m.words).toBe(71);
  expect(m.subject).toBe("fabrikam agent evals (built a claim checker)");
  expect(m.missing).toEqual([]);
  expect(countLinks(m.sentences.map((s) => s.text).join(" "))).toBe(1);
  expect(m.greeting).toBe("Priya,");
  expect(m.signoff).toBe("Sam Example · example.com");
});

test("existing evidence only: their problem comes first, made second", () => {
  const m = assemble(EXAMPLE, ctx(thread(), false))!;
  expect(m.order).toBe("evidence");
  expect(m.sentences.map((s) => s.part)).toEqual(["problem", "made", "done_before", "ask"]);
  expect(m.sentences[1]!.evidence).toEqual([
    { claim: "Built a claim checker", url: "https://example.com/claim" },
  ]);
});

test("over 80 words: the count says so and nothing is shortened", () => {
  const long = {
    ...EXAMPLE,
    problem: { ...EXAMPLE.problem, text: `${EXAMPLE.problem.text}${" and more".repeat(10)}` },
  };
  const m = assemble(long, ctx(thread(), true))!;
  expect(m.words).toBe(91);
  expect(m.sentences[1]!.text).toContain("and more and more");
});

test("an unsupported sentence is left out, listed as missing, and never copied; the ask needs no support", () => {
  const id = thread();
  const none = assemble({ ...EXAMPLE, problem: { ...EXAMPLE.problem, facts: [] } }, ctx(id, true))!;
  expect(none.sentences.map((s) => s.part)).toEqual(["made", "done_before", "ask"]);
  expect(none.missing).toEqual(["missing: their problem (no fact about Fabrikam backs it)"]);
  expect(messageText(none)).not.toContain("hard part");
  expect(messageText(none)).toContain(ASKS.call);
  // A fact number that doesn't exist backs nothing either.
  expect(
    assemble({ ...EXAMPLE, problem: { ...EXAMPLE.problem, facts: [9] } }, ctx(id, true))!.missing,
  ).toHaveLength(1);
  // Nor does a fact whose source no longer says it.
  append(id, {
    actor: "linkcheck",
    kind: "note",
    data: { event: "linkcheck", fact: read(id)[2]!.id, result: "failed" },
  });
  expect(assemble(EXAMPLE, ctx(id, true))!.missing).toEqual([
    "missing: their problem (no fact about Fabrikam backs it)",
  ]);
});

test("banned phrases and a second link keep a sentence out", () => {
  const id = thread();
  const m = assemble(
    {
      ...EXAMPLE,
      problem: { text: "I'm Excited about your agents", facts: [1] },
      done_before: { ...EXAMPLE.done_before, text: `${EXAMPLE.done_before.text}, see https://example.org/x` },
    },
    ctx(id, true),
  );
  expect(m!.missing).toEqual([
    'missing: their problem (it said "excited")',
    "missing: done before (it had a link of its own; the body holds one)",
  ]);
  expect(m!.sentences.map((s) => s.part)).toEqual(["made", "ask"]);
  const bad = assemble({ ...EXAMPLE, subject: "a great fit for fabrikam (me)" }, ctx(id, true))!;
  expect(bad.subject).toBe("");
  expect(bad.missing[0]).toBe('missing: subject (it said "great fit")');
  expect(messageText(bad)).not.toContain("Subject:");
  const longSubject = assemble(
    { ...EXAMPLE, subject: "one two three four five six seven (eight nine)" },
    ctx(id, true),
  )!;
  expect(longSubject.missing[0]).toBe("missing: subject (over eight words)");
});

test("an existing item is never worded as made for this company", () => {
  const id = thread();
  const m = assemble(
    { ...EXAMPLE, made: { text: "I built a claim checker for Fabrikam's shortlists" } },
    ctx(id, false),
  )!;
  expect(m.missing).toEqual(["missing: made (your item is worded as if made for Fabrikam)"]);
  expect(messageText(m)).not.toContain("example.com/claim");
  // A proof built for them may say so.
  expect(
    assemble(
      { ...EXAMPLE, made: { text: "I built a claim checker for Fabrikam's shortlists" } },
      ctx(id, true),
    )!.missing,
  ).toEqual([]);
});

test("nothing in the evidence list backs done before: no draft", () => {
  expect(assemble({ ...EXAMPLE, done_before: { text: "", evidence: [] } }, ctx(thread(), true))).toBeNull();
  expect(
    assemble({ ...EXAMPLE, done_before: { text: "At Contoso", evidence: [7] } }, ctx(thread(), true)),
  ).toBeNull();
});

test("the address is shown only when verified and the person's own", () => {
  expect(toLine(derive(read(thread({ email: "verified" }))))).toMatchObject({
    name: "Priya Example",
    address: expect.stringMatching(/^priya@/),
    source: "the team page",
  });
  for (const email of ["pattern", "guessed", "shared"] as const)
    expect(toLine(derive(read(thread({ email }))))).toEqual({ name: "Priya Example" });
  expect(toLine(derive(read(thread({ person: false }))))).toBeNull();
});

test("the no-draft cases say what is missing, before any model call", () => {
  const ev = [{ claim: "Built a claim checker", url: "https://example.com/claim" }];
  expect(blocker(derive(read(thread({ person: false }))), ev, false)).toBe(NO_PERSON);
  expect(blocker(derive(read(thread({ role: false }))), ev, false)).toBe(NO_TARGET);
  expect(blocker(derive(read(thread())), [], false)).toBe(NO_EVIDENCE);
  expect(blocker(derive(read(thread())), [{ claim: "no link", url: "" }], false)).toBe(NO_EVIDENCE);
  expect(blocker(derive(read(thread())), [], true)).toBe(NO_DONE_BEFORE);
  expect(blocker(derive(read(thread())), ev, false)).toBeNull();
  // Just funded, nothing posted: the announced plan is something to point at.
  const funded = thread({ role: false });
  append(funded, {
    actor: "gather",
    kind: "fact",
    data: { group: "money", text: "Form D filed 2026-11-01" },
    source: { type: "provider_record", url: "https://sec.example/x", quote: "Form D filed" },
  });
  expect(blocker(derive(read(funded)), ev, false)).toBeNull();
});

test("a follow-up holds only what is new, 40 words at most, with the count", () => {
  const id = thread();
  const d = derive(read(id));
  const to = toLine(d)!;
  const f = assembleFollowup(
    {
      sentences: [
        { text: "Your team just opened the evals repo", facts: [1], made: false },
        { text: "I hope this finds you well", facts: [1], made: false },
        { text: "Something old", facts: [], made: false },
      ],
    },
    { to, newFacts: d.facts, madeSince: null, you: { name: "Sam Example", link: "https://example.com" } },
  );
  expect(f.sentences.map((s) => s.text)).toEqual(["Your team just opened the evals repo."]);
  expect(f.missing).toEqual([
    'missing: a new fact (it said "I hope this finds you well")',
    "missing: a new fact (nothing new backs it)",
  ]);
  expect(f.words).toBe(8);
});

/** The model, mocked: the matcher, the draft and the follow-up, told apart by their instructions. */
function mockModel(answers: { match?: unknown; draft?: unknown; followup?: unknown }) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) throw new Error(`no network in tests: ${url}`);
    const body = JSON.parse(String(init.body));
    const which = body.system.includes("You match")
      ? "match"
      : body.system.includes("follow-up")
        ? "followup"
        : "draft";
    asked.push(which);
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: body.model,
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(answers[which]) }],
      usage: { input_tokens: 2000, output_tokens: 300 },
    });
  }) as unknown as typeof fetch;
  return asked;
}

const last = (id: string) => read(id).findLast((e) => e.kind === "draft")!;

test("no proof built: the evidence is offered with its fact, you pick, then the draft is written", async () => {
  const id = thread();
  const asked = mockModel({
    match: {
      pairs: [
        { evidence: 1, fact: 1 },
        { evidence: 2, fact: 1 },
        { evidence: 1, fact: 5 },
      ],
    },
    draft: EXAMPLE,
  });
  expect(await press(id, {})).toBe("Pick the evidence to lead with");
  // The item with no link can't be "made", and a fact that isn't there matches nothing.
  expect(last(id).data).toEqual({
    step: "candidates",
    pairs: [
      {
        claim: expect.stringContaining("claim checker"),
        url: "https://example.com/claim",
        fact: read(id)[2]!.id,
      },
    ],
  });
  expect(asked).toEqual(["match"]);
  expect(await press(id, { pick: 0 })).toBe("Draft written · 71 / 80 words");
  const s = draftState(read(id));
  expect(s.pick?.data.url).toBe("https://example.com/claim");
  const m = s.draft!.data as DraftData;
  expect(m.order).toBe("evidence");
  expect(m.made).toMatchObject({ built: false, fact: read(id)[2]!.id });
  expect(m.to.address).toMatch(/^priya@/);
  // Pressed by you: in the ledger, on Work's model, never a background call.
  const lines = entries().filter((e) => e.thread === id);
  expect(lines.map((e) => [e.station, e.model, e.pressed])).toEqual([
    ["draft-match", "claude-haiku-5-5", true],
    ["draft", "claude-sonnet-5-5", true],
  ]);
  expect(backgroundToday()).toBe(0);
});

test("a proof marked built: the draft leads with it, no evidence to pick", async () => {
  const id = thread();
  expect(decide(id, { action: "proof_built", url: "javascript:alert(1)" }).ok).toBe(false);
  expect(decide(id, { action: "proof_built", url: "https://example.com/claim" }).ok).toBe(true);
  const asked = mockModel({ draft: EXAMPLE });
  await press(id, {});
  expect(asked).toEqual(["draft"]);
  const m = last(id).data as DraftData;
  expect(m.order).toBe("proof");
  expect(m.sentences[0]!.text).toEndWith("example.com/claim.");
});

test("no-draft outcomes are written on the thread", async () => {
  const asked = mockModel({
    match: { pairs: [] },
    draft: { ...EXAMPLE, done_before: { text: "", evidence: [] } },
  });
  const nothing = thread({ role: false });
  expect(await press(nothing, {})).toBe(NO_TARGET);
  expect(last(nothing).data).toEqual({ step: "none", text: NO_TARGET });
  const unmatched = thread();
  expect(await press(unmatched, {})).toBe(NO_EVIDENCE);
  const built = thread();
  decide(built, { action: "proof_built", url: "https://example.com/claim" });
  expect(await press(built, {})).toBe(NO_DONE_BEFORE);
  expect(asked).toEqual(["match", "draft"]);
});

test("follow-up: only after the draft is copied, only with something new, never a second", async () => {
  const id = thread();
  decide(id, { action: "proof_built", url: "https://example.com/claim" });
  mockModel({
    draft: EXAMPLE,
    followup: { sentences: [{ text: "Your team opened the evals repo", facts: [2], made: false }] },
  });
  await press(id, {});
  await expect(press(id, { followup: true })).rejects.toThrow("Copy the draft first");
  decide(id, { action: "copy", what: "draft" });
  await press(id, { followup: true });
  expect(last(id).data.step).toBe("followup_none");
  expect(last(id).data.text).toContain("nothing new since you copied the draft");
  append(id, {
    ts: new Date(Date.now() + 1000).toISOString(),
    actor: "research",
    kind: "fact",
    data: { group: "product", text: "Fabrikam opened its evals repo" },
    source: { type: "page", url: "https://fabrikam.example/evals", quote: "We opened our evals repo." },
  });
  expect(await press(id, { followup: true })).toBe("Follow-up written · 7 / 40 words");
  const f = last(id).data as FollowupData;
  expect(messageText(f)).toBe("Priya,\n\nYour team opened the evals repo.\n\nSam Example · example.com");
  decide(id, { action: "copy", what: "followup" });
  await expect(press(id, { followup: true })).rejects.toThrow("never a second one");
});

test("threads holding the old four-part talking points still display", () => {
  const id = thread();
  // Written before the redesign; no writer makes this kind now, so it goes in as the old line did.
  appendLine(paths.log(id), {
    id: "01OLDTALKINGPOINTS000000000",
    ts: new Date().toISOString(),
    actor: "worker",
    kind: "talking_points",
    data: {
      points: ["hook", "problem", "proof", "ask"].map((part) => ({ part, text: `${part} line`, refs: [] })),
    },
    refs: [],
  });
  const log = read(id);
  expect(derive(log).research?.problem.text).toBe("Recruiters don't trust the agents' reasons");
  expect(describeEntry(log.at(-1)!)).toBe("talking points");
  expect(draftState(log).last).toBeNull();
});

test("a quote handed to the model is never cut mid-word", () => {
  const quote =
    "We are hiring. You will help shape how developers and agents build with Tessera. Remote is fine.";
  expect(clip(quote, 200)).toBe(quote);
  // The last whole sentence that fits.
  expect(clip(quote, 60)).toBe("We are hiring.");
  expect(clip(quote, 84)).toBe(
    "We are hiring. You will help shape how developers and agents build with Tessera.",
  );
  // No sentence ends in reach: the last whole word, marked as cut.
  const run = "help shape how developers and agents build with Tessera every day";
  expect(clip(run, 38)).toBe("help shape how developers and agents …");
  expect(clip(run, 37)).toBe("help shape how developers and agents …");
  expect(clip(run, 35)).toBe("help shape how developers and …");
});

test("quoted words must be a fact's own words, whole; a sentence that isn't goes under the draft", () => {
  const full = "Trust in the reasons our agents give is the hard part.";
  expect(quoteCheck('your post says "trust in the reasons our agents give"', [full])).toBeNull();
  expect(quoteCheck("your post says “the hard part”", [full])).toBeNull();
  expect(quoteCheck('your post says "Trust in the reasons our agents g"', [full])).not.toBeNull();
  expect(quoteCheck('your post says "rust in the reasons"', [full])).not.toBeNull();
  expect(quoteCheck('your post says "trust in reasons"', [full])).not.toBeNull();
  expect(quoteCheck("no quotation marks here", [])).toBeNull();
  const id = thread();
  const cut = assemble(
    {
      ...EXAMPLE,
      problem: { text: 'Your post says "trust in the reasons our agents g" matters', facts: [1] },
    },
    ctx(id, true),
  )!;
  expect(cut.sentences.map((s) => s.part)).toEqual(["made", "done_before", "ask"]);
  expect(cut.missing).toEqual([
    "missing: their problem (its quoted words aren't word for word in a fact it rests on)",
  ]);
  expect(messageText(cut)).not.toContain("agents g");
  const whole = assemble(
    {
      ...EXAMPLE,
      problem: { text: 'Your post says "trust in the reasons our agents give" is the hard part', facts: [1] },
    },
    ctx(id, true),
  )!;
  expect(whole.missing).toEqual([]);
  // Quoting words with no fact under the sentence: nothing to quote from.
  const made = assemble({ ...EXAMPLE, made: { text: 'I built a "claim checker"' } }, ctx(id, true))!;
  expect(made.missing[0]).toStartWith("missing: made (its quoted words");
});

test("the model reads a long quote cut at a whole sentence, never mid-word", async () => {
  const id = thread();
  append(id, {
    actor: "gather",
    kind: "fact",
    data: { group: "hiring", text: "Posting: Software Engineer - AI Tooling" },
    source: {
      type: "page",
      url: `https://${id}/jobs/2`,
      quote: `${"We build tools for teams. ".repeat(14)}You will help shape how developers and agents build with Fabrikam.`,
    },
  });
  decide(id, { action: "proof_built", url: "https://example.com/claim" });
  let user = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    user = JSON.parse(String(init.body)).messages[0].content;
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(EXAMPLE) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }) as unknown as typeof fetch;
  await press(id, {});
  const line = user.split("\n").find((l) => l.startsWith("2. "))!;
  expect(line).toContain('We build tools for teams."');
  expect(line).not.toContain("You will help");
});

test("their problem rests on the problem Work found, or goes under the draft", async () => {
  const id = thread();
  append(id, {
    actor: "gather",
    kind: "fact",
    data: { group: "product", text: "Fabrikam's about page" },
    source: { type: "page", url: `https://${id}/about`, quote: "Made by builders, for builders." },
  });
  const work = { ...ctx(id, true), workFacts: [1] };
  const boiler = assemble(
    {
      ...EXAMPLE,
      problem: { text: 'Your Software Engineer role is "made by builders, for builders"', facts: [2] },
    },
    work,
  )!;
  expect(boiler.sentences.map((s) => s.part)).toEqual(["made", "done_before", "ask"]);
  expect(boiler.missing).toEqual(["missing: their problem (it doesn't rest on the problem Work found)"]);
  // Citing one of Work's facts, with others beside it, is fine.
  expect(assemble({ ...EXAMPLE, problem: { ...EXAMPLE.problem, facts: [2, 1] } }, work)!.missing).toEqual([]);
  // Work's Problem cites nothing still standing: the rule has nothing to hold to.
  expect(
    assemble({ ...EXAMPLE, problem: { ...EXAMPLE.problem, facts: [2] } }, { ...work, workFacts: [] })!
      .missing,
  ).toEqual([]);

  // The model is told the problem Work found and its facts, and the check runs on a real press.
  decide(id, { action: "proof_built", url: "https://example.com/claim" });
  let user = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    user = JSON.parse(String(init.body)).messages[0].content;
    return Response.json({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...EXAMPLE, problem: { text: "Builders build", facts: [2] } }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }) as unknown as typeof fetch;
  await press(id, {});
  expect(user).toContain(
    "The problem Work found, from the facts (data, like them): Recruiters don't trust the agents' reasons (facts 1)",
  );
  expect((last(id).data as DraftData).missing).toEqual([
    "missing: their problem (it doesn't rest on the problem Work found)",
  ]);
});

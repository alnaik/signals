import { describe, expect, test } from "bun:test";
import { derive } from "./derive.ts";
import type { Entry, Kind } from "./log.ts";

let n = 0;
// biome-ignore lint/suspicious/noExplicitAny: test payloads
function e(kind: Kind, data: Record<string, any> = {}, extra: Partial<Entry> = {}): Entry {
  n++;
  return {
    id: `E${String(n).padStart(4, "0")}`,
    ts: `2026-10-${String(1 + Math.floor(n / 24)).padStart(2, "0")}T${String(n % 24).padStart(2, "0")}:00:00Z`,
    actor: "test",
    kind,
    data,
    refs: [],
    ...extra,
  };
}
const dec = (action: string, data = {}) => e("decision", { action, ...data });
const signal = () => e("signal", { company: "Tessera Labs", source_tag: "posting" });
const URL = "https://jobs.ashbyhq.com/tessera/1";
const posting = (url = URL, title = "Backend Engineer") =>
  e(
    "signal",
    { company: "Tessera Labs", source_tag: "ATS change", kind: "posting", title, location: "Denver, CO" },
    { source: { type: "page", url } },
  );
const status = (log: Entry[]) => derive(log).status;

const done = () => e("note", { event: "run_done" }, { actor: "worker" });
describe("roles and status words", () => {
  test("a chosen role reads apply, then applied; the thread needs you while a role waits", () => {
    const log = [posting(), dec("apply", { url: URL })];
    let d = derive(log);
    expect(d.roles.map((r) => [r.title, r.location, r.status])).toEqual([
      ["Backend Engineer", "Denver, CO", "apply"],
    ]);
    expect(d.needsYou).toBe(true);
    expect(d.status).toBeNull();
    log.push(dec("applied", { url: URL }));
    d = derive(log);
    expect(d.roles[0]!.status).toBe("applied");
    expect(d.needsYou).toBe(false);
  });

  test("finished: applied, the rest dismissed or gone, nothing else going on; a new role brings it back", () => {
    const other = "https://jobs.ashbyhq.com/tessera/2";
    const log = [posting(), posting(other, "Data Engineer"), dec("applied", { url: URL })];
    expect(derive(log).finished).toBe(false); // the other role still waits on you
    log.push(e("note", { event: "gone", url: other }));
    expect(derive(log)).toMatchObject({ finished: true, needsYou: false });
    // A Work run, a person found or a conversation keeps it among the threads.
    expect(derive([...log, dec("work")]).finished).toBe(false);
    // Work that ended with no one found, or stopped before it got going, still keeps it.
    expect(derive([...log, dec("work"), done()])).toMatchObject({ status: null, finished: false });
    expect(
      derive([...log, dec("work"), e("note", { event: "run_incomplete", final: true }, { actor: "worker" })])
        .finished,
    ).toBe(false);
    // A run from before the Work decision existed (worker note only) counts too.
    expect(derive([...log, done()]).finished).toBe(false);
    // A run note from another writer ends nothing and is no Work run.
    expect(derive([...log, e("note", { event: "run_done" }, { actor: "import" })]).finished).toBe(true);
    expect(derive([...log, e("contact", { name: "Maya", confidence: "pattern" })]).finished).toBe(false);
    expect(derive([...log, dec("mark_sent")]).finished).toBe(false);
    // Only dismissed roles is not applied.
    expect(derive([posting(), dec("drop", { url: URL })]).finished).toBe(false);
    log.push(
      posting("https://jobs.ashbyhq.com/tessera/3", "SRE"),
      dec("apply", { url: "https://jobs.ashbyhq.com/tessera/3" }),
    );
    expect(derive(log)).toMatchObject({ finished: false, needsYou: true });
  });

  test("dropped: every role dismissed or gone, one dismissed, nothing else going on; a new role brings it back", () => {
    const other = "https://jobs.ashbyhq.com/tessera/2";
    const log = [posting(), posting(other, "Data Engineer"), dec("drop", { url: URL })];
    expect(derive(log).dropped).toBe(false); // the other role is still there to choose
    log.push(e("note", { event: "gone", url: other }));
    expect(derive(log)).toMatchObject({ dropped: true, finished: false, needsYou: false });
    // Gone roles alone, an applied role, a Work run or a conversation keep it out of Dismissed.
    expect(derive([posting(), e("note", { event: "gone", url: URL })]).dropped).toBe(false);
    expect(
      derive([
        ...log,
        posting("https://jobs.ashbyhq.com/tessera/4", "QA"),
        dec("applied", { url: "https://jobs.ashbyhq.com/tessera/4" }),
      ]).dropped,
    ).toBe(false);
    expect(derive([...log, dec("work")]).dropped).toBe(false);
    expect(derive([...log, dec("work"), done()])).toMatchObject({ status: null, dropped: false });
    expect(derive([...log, dec("mark_sent")]).dropped).toBe(false);
    log.push(
      posting("https://jobs.ashbyhq.com/tessera/3", "SRE"),
      dec("apply", { url: "https://jobs.ashbyhq.com/tessera/3" }),
    );
    expect(derive(log)).toMatchObject({ dropped: false, needsYou: true });
  });

  test("work → researching → person found → sent → replied → closed", () => {
    const log = [posting(), dec("work")];
    expect(status(log)).toBe("researching");
    log.push(e("contact", { name: "Maya", role: "CTO", confidence: "pattern", channels: [] }), done());
    expect(status(log)).toBe("person found");
    log.push(dec("mark_sent"));
    expect(derive(log)).toMatchObject({ status: "sent", statusSince: log.at(-1)!.ts });
    log.push(dec("got_reply"));
    expect(status(log)).toBe("replied");
    log.push(dec("close", { reason: "they hired internally" }));
    expect(derive(log)).toMatchObject({
      status: "closed",
      closeReason: "they hired internally",
      needsYou: false,
    });
  });

  test("choosing a role at a closed company opens the thread again, history intact", () => {
    const log = [posting(), dec("close", { reason: "rejected" })];
    expect(status(log)).toBe("closed");
    const next = "https://jobs.ashbyhq.com/tessera/3";
    log.push(posting(next, "Platform Engineer"), dec("apply", { url: next }));
    const d = derive(log);
    expect(d.status).toBeNull();
    expect(d.closeReason).toBeNull();
    expect(d.roles.map((r) => r.status)).toEqual(["apply", "apply"]);
  });

  test("old stages map to the new words (migration)", () => {
    // waiting → sent; talking → replied; closed stays. A contact is a Timeline line (below).
    expect(status([signal(), dec("work"), done(), dec("mark_sent")])).toBe("sent");
    expect(status([signal(), dec("work"), done(), dec("mark_sent"), e("reply", {})])).toBe("replied");
    expect(derive([signal(), dec("no", { reason: "wrong stack" })]).closeReason).toBe("wrong stack");
    expect(derive([signal(), dec("hired")]).closeReason).toBe("hired");
    expect(derive([signal(), dec("drop", { reason: "bad timing" })]).closeReason).toBe("bad timing");
    // A post with no title is not a role.
    expect(derive([signal()]).roles).toEqual([]);
  });
});

describe("the research block", () => {
  const src = { type: "page" as const, url: "https://t.dev", quote: "x" };
  const block = (problem: number[], person: number[], proof: number[]) =>
    e("research", {
      problem: { text: "v2 launch broke imports", facts: problem },
      person: { name: "Maya", role: "CTO", text: "owns imports", facts: person },
      proof: { text: "a repro", budget: "2h", facts: proof },
    });
  test("facts are numbered, uncited ones marked unused, late and watched facts flagged new", () => {
    const f1 = e("fact", { text: "a" }, { source: src, actor: "worker" });
    const f2 = e("fact", { text: "b" }, { source: src, actor: "gather" });
    const late = e("fact", { text: "c" }, { source: src, actor: "firecrawl" });
    const watched = e("fact", { text: "d", new: true }, { source: src, actor: "hn" });
    const d = derive([signal(), dec("work"), watched, f1, f2, block([2], [9], []), done(), late]);
    expect(d.facts.map((f) => [f.n, f.used, f.late])).toEqual([
      [1, false, true],
      [2, true, false],
      [3, false, false],
      [4, false, true],
    ]);
    expect(d.research?.person.facts).toEqual([]); // a number that isn't a fact is dropped
  });
});

describe("a Work run's end", () => {
  test("only the worker's run_done or run_incomplete ends research", () => {
    const log = [signal(), dec("work")];
    expect(status([...log, e("note", { event: "run_done" }, { actor: "gather" })])).toBe("researching");
    expect(status([...log, e("note", { event: "run_incomplete", final: true }, { actor: "apply" })])).toBe(
      "researching",
    );
    expect(status([...log, done()])).not.toBe("researching");
  });
});

describe("the people on a thread", () => {
  const lisa = () =>
    e(
      "contact",
      {
        name: "Lisa Wang",
        role: "Engineering Manager",
        confidence: "pattern",
        channels: [{ channel: "email", value: "lisa@tessera.dev", confidence: "pattern" }],
      },
      { actor: "gather" },
    );
  const hillary = () =>
    e(
      "contact",
      {
        name: "Hillary Bush",
        role: "",
        confidence: "verified",
        channels: [{ channel: "email", value: "hillary@tessera.dev", confidence: "verified" }],
      },
      { actor: "lookup" },
    );
  const research = (name: string) =>
    e(
      "research",
      {
        problem: { text: "p", facts: [] },
        person: { name, role: "EM", text: "t", facts: [] },
        proof: { text: "x", budget: "", facts: [] },
      },
      { actor: "worker" },
    );
  const emails = (log: Entry[]) => derive(log).channels.map((c) => c.value);

  test("a person saved later sits beside the one Work found; it doesn't replace them", () => {
    const log = [posting(), dec("work"), lisa(), research("lisa wang"), done(), hillary()];
    const d = derive(log);
    expect(d.contacts.map((c) => [c.name, c.actor, c.main])).toEqual([
      ["Lisa Wang", "gather", true],
      ["Hillary Bush", "lookup", false],
    ]);
    expect(d.contact).toEqual({ name: "Lisa Wang", role: "Engineering Manager" });
    expect(emails(log)).toEqual(["lisa@tessera.dev"]);
    expect(d.status).toBe("person found");
    // With no research, Work's find is still the person, whoever was saved after it.
    expect(emails([posting(), lisa(), hillary()])).toEqual(["lisa@tessera.dev"]);
    // Only saved people: the latest one.
    expect(derive([posting(), hillary()]).contact?.name).toBe("Hillary Bush");
  });

  test("the person research names stays the thread's person, even when Work found someone after", () => {
    const h = hillary();
    const log = [posting(), h, research("Hillary Bush"), done(), lisa()];
    expect(derive(log).contact?.name).toBe("Hillary Bush");
    expect(emails(log)).toEqual(["hillary@tessera.dev"]);
  });

  test("Remove takes a person back; removing the thread's person makes the next one it", () => {
    const l = lisa();
    const h = hillary();
    const log = [posting(), dec("work"), l, research("Lisa Wang"), done(), h];
    log.push(dec("remove_contact", { entry: h.id, name: "Hillary Bush" }));
    expect(derive(log).contacts.map((c) => c.name)).toEqual(["Lisa Wang"]);
    expect(derive(log).contact?.name).toBe("Lisa Wang");
    log.push(dec("remove_contact", { entry: l.id, name: "Lisa Wang" }));
    // No one left: the thread no longer reads "person found"; the research names Lisa still.
    expect(derive(log)).toMatchObject({ contacts: [], contact: null, channels: [], status: null });
    expect(derive(log).ran).toBe("researched");
    // Removing the person with someone else saved: the other one becomes the person.
    const two = [posting(), l, h, dec("remove_contact", { entry: l.id })];
    expect(derive(two).contact?.name).toBe("Hillary Bush");
    expect(emails(two)).toEqual(["hillary@tessera.dev"]);
  });
});

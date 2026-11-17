import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { open } from "../core/db.ts";
import { derive } from "../core/derive.ts";
import { entries } from "../core/ledger.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { upsertCompany } from "../intake/companies.ts";
import { call, setProviders, withRunBudget } from "../providers/registry.ts";
import type { Provider } from "../providers/types.ts";
import { findEmail, getLookup, prune, recent, saveFound, startLookup } from "./lookup.ts";

const data = tempData();
afterAll(data.cleanup);
afterEach(() => setProviders(null));
beforeEach(() => {
  open().exec("DELETE FROM lookups");
  writeFileSync(
    paths.config(),
    '[caps]\nmonth_usd = 100\n[providers]\ncontact = ["stub"]\npeople = ["stub"]\nsearch = ["paid"]\n',
  );
});

// Invented people at an invented company; a paid stub, never a real provider.
const stub: Provider = {
  name: "stub",
  label: "Stub",
  cost: { contact: 0.045, people: 0.01 },
  contact: async (p) => [
    {
      channel: "email",
      value: `${p.name.split(" ")[0]!.toLowerCase()}@${p.domain}`,
      confidence: "verified",
      source: "stub",
    },
  ],
  people: async () => [
    { name: "Ines Varga", role: "CTO", profile_urls: [], source: "stub" },
    { name: "Tomo Reyes", role: "Head of Engineering", profile_urls: [], source: "stub" },
  ],
};

test("a lookup during a Work run spends its own budget, and its skips stay its own", async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const paid: Provider = {
    name: "paid",
    label: "Paid",
    cost: { search: 0.04 },
    search: async () => [{ url: "https://quillon.dev", title: "q", snippet: "" }],
  };
  setProviders([paid]);
  const ask = (station: string) => call(paid, "search", ["q", {}], { station });
  // Work: one call, then waits while a lookup runs, then one more: 0.08 of its 0.10.
  const work = withRunBudget(0.1, async () => {
    await ask("work");
    await gate;
    await ask("work");
  });
  // The lookup: 0.04 of its own 0.04, then a second call it can't afford.
  const lookup = await withRunBudget(0.04, async () => {
    await ask("lookup");
    await ask("lookup").catch(() => {});
  });
  release();
  const w = await work;
  expect(w.spent).toBeCloseTo(0.08);
  expect(w.skipped).toEqual([]);
  expect(lookup.spent).toBeCloseTo(0.04);
  expect(lookup.skipped).toEqual(["Paid skipped · this run's lookup budget"]);
});

test("Find a person runs in the background on station lookup; Save writes a contact and the thread becomes person found", async () => {
  setProviders([stub]);
  upsertCompany({ name: "Quillon", domain: "quillon.dev" });
  const { id, done } = startLookup("person", { name: "Ines Varga", company: "Quillon", role: "CTO" });
  expect(getLookup(id)!.status).toBe("running");
  await done;
  const l = getLookup(id)!;
  expect(l.status).toBe("done");
  expect(l.usd).toBeCloseTo(0.045);
  expect(l.results!.people[0]!.hits![0]!.value).toBe("ines@quillon.dev");
  expect(entries().at(-1)).toMatchObject({ station: "lookup", provider: "stub" });
  // Nothing on a thread until Save.
  expect(read("quillon.dev")).toEqual([]);

  const r = saveFound(id, 0);
  expect(r).toMatchObject({ ok: true, thread: "quillon.dev" });
  const contact = read("quillon.dev").find((e) => e.kind === "contact")!;
  expect(contact.data).toMatchObject({ name: "Ines Varga", role: "CTO", confidence: "verified" });
  expect(contact.data.channels[0].value).toBe("ines@quillon.dev");
  expect(derive(read("quillon.dev")).status).toBe("person found");
  expect(getLookup(id)!.results!.people[0]!.saved).toBe("quillon.dev");
});

test("Save beside a person already on the thread adds them, says so, and the same email twice adds nothing", async () => {
  setProviders([stub]);
  upsertCompany({ name: "Brindle", domain: "brindle.io" });
  // Work found Tomo first: the thread has its person.
  const work = startLookup("person", { name: "Tomo Reyes", company: "Brindle", role: "Head of Engineering" });
  await work.done;
  saveFound(work.id, 0);
  append("brindle.io", {
    actor: "gather",
    kind: "contact",
    data: {
      name: "Rui Sato",
      role: "Engineering Manager",
      confidence: "pattern",
      channels: [{ channel: "email", value: "rui@brindle.io", confidence: "pattern" }],
    },
  });
  const { id, done } = startLookup("person", { name: "Ines Varga", company: "Brindle", role: "CTO" });
  await done;
  expect(saveFound(id, 0)).toMatchObject({
    ok: true,
    toast: "Saved Ines Varga to Brindle, added beside Rui Sato",
  });
  const d = derive(read("brindle.io"));
  expect(d.contacts.map((c) => c.name)).toEqual(["Tomo Reyes", "Rui Sato", "Ines Varga"]);
  expect(d.contact?.name).toBe("Rui Sato");
  expect(d.channels.map((c) => c.value)).toEqual(["rui@brindle.io"]);
  // The same person (the same email) saved again, from this lookup or another: no new line.
  const lines = read("brindle.io").length;
  expect(saveFound(id, 0)).toMatchObject({ ok: true, toast: "Ines Varga is already on Brindle's thread" });
  const again = startLookup("person", { name: "Ines Varga", company: "Brindle", role: "CTO" });
  await again.done;
  expect(saveFound(again.id, 0)).toMatchObject({ ok: true });
  expect(getLookup(again.id)!.results!.people[0]!.saved).toBe("brindle.io");
  expect(read("brindle.io")).toHaveLength(lines);
});

test("People at a company: Find email asks first after three presses in one lookup", async () => {
  setProviders([stub]);
  const { id, done } = startLookup("people", { company: "brindle.io", titles: ["CTO"] });
  await done;
  expect(getLookup(id)!.results!.people.map((p) => p.name)).toEqual(["Ines Varga", "Tomo Reyes"]);
  for (let i = 0; i < 3; i++) {
    const r = findEmail(id, i % 2);
    if ("done" in r) await r.done;
  }
  expect(findEmail(id, 1)).toHaveProperty("ask");
  const go = findEmail(id, 1, true);
  if ("done" in go) await go.done;
  expect(getLookup(id)!.results!.presses).toBe(4);
});

test("the last 50 lookups are kept; emails found over 30 days ago go unless saved to a thread", () => {
  const add = open().query(
    "INSERT INTO lookups (mode, inputs, status, results, started_at, finished_at) VALUES ('person', '{}', 'done', ?, ?, ?)",
  );
  const found = (saved?: string) =>
    JSON.stringify({
      company: { id: null, name: "corvid.dev", domain: "corvid.dev" },
      people: [
        {
          name: "Ada Brenn",
          role: "CTO",
          profile_urls: [],
          source: "you",
          hits: [{ channel: "email", value: "ada@corvid.dev", confidence: "verified", source: "stub" }],
          ...(saved ? { saved } : {}),
        },
      ],
    });
  const old = "2026-09-01T00:00:00Z";
  add.run(found(), old, old);
  add.run(found("corvid.dev"), old, old);
  for (let i = 0; i < 52; i++) add.run(found(), "2026-11-16T00:00:00Z", "2026-11-16T00:00:00Z");
  // The two old ones are past the last 50 now: made the newest, so the 30 days are what's tested.
  open().exec("UPDATE lookups SET id = id + 1000 WHERE started_at = '2026-09-01T00:00:00Z'");
  expect(prune(new Date("2026-11-17T00:00:00Z"))).toEqual({ deleted: 4, dropped: 1 });
  const all = recent().lookups;
  expect(all.length).toBe(50);
  const olds = all.filter((l) => l.started_at.startsWith("2026-09"));
  expect(olds.map((l) => l.results!.people[0]!.hits!.length).sort()).toEqual([0, 1]);
  expect(olds.find((l) => l.results!.people[0]!.saved)!.results!.people[0]!.hits!.length).toBe(1);
});

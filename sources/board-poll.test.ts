import { afterAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { type Job, type RunnerResult, setTable } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { setSecret } from "../core/keychain.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { recordSignal, upsertCompany } from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { readSourceState, writeSourceState } from "../signals/state.ts";
import boardPoll, { setDeps } from "./board-poll/index.ts";

const data = tempData();
afterAll(() => {
  setDeps(null);
  data.cleanup();
});

const now = new Date("2026-11-02T12:00:00Z");
const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (slug: string, n: number, title: string, posted: string, location = "Denver, CO"): Job => ({
  id: uuid(n),
  title,
  url: `https://jobs.ashbyhq.com/${slug}/${uuid(n)}`,
  location,
  postedAt: posted,
  description: "<p>We build &amp; ship</p>",
});
const table = (slugs: string[]) =>
  setTable(
    slugs.map((s) => ({ name: "", website: "", provider: "ashby", url: `https://jobs.ashbyhq.com/${s}` })),
  );

let boards: Record<string, Job[]> = {};
let states: Record<string, { name: string; site: string | null }> = {};
let verdicts: Record<string, "employer" | "agency"> = {};
let checked: string[] = [];
let scanned: string[] = [];
beforeEach(() => {
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies;",
  );
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ filters: { title_include: ["Engineer"], locations: ["Denver"], remote_ok: true } }),
  );
  writeFileSync(paths.config(), "[source.board-poll]\non = true\nper_tick = 3\n");
  setSecret("anthropic", "sk-test");
  writeSourceState("board-poll", {});
  checked = [];
  scanned = [];
  setDeps({
    runBoards: (async (_mode: string, cs: { domain: string; ats?: { careers_url: string } }[]) =>
      cs.map((c): RunnerResult => {
        const slug = c.ats!.careers_url.split("/").pop()!;
        scanned.push(slug);
        return { domain: c.domain, ok: true, jobs: boards[slug] ?? [] };
      })) as never,
    boardStates: async (url: string) => {
      const s = states[url.split("/").pop()!];
      return s ? { ...s, page: null } : null;
    },
    checkEmployer: async (o) => {
      checked.push(o.board);
      return { is: verdicts[o.board.split("/").pop()!] ?? "employer", why: "test" };
    },
  });
});

test("a fresh fitting role on a board we don't have is a lead, named and with the website its Ashby board states", async () => {
  table(["newco"]);
  boards = {
    newco: [
      job("newco", 1, "Software Engineer", day(2)),
      job("newco", 2, "Software Engineer II", day(30)), // posted too long ago
      job("newco", 3, "Sales Manager", day(1)), // not a wanted title
      job("newco", 4, "Platform Engineer", day(1), "Berlin, Germany"), // not a wanted place
    ],
  };
  states = { newco: { name: "Newco", site: "newco.ai" } };
  const leads = await boardPoll.fetch(null, now);
  expect(leads).toEqual([
    expect.objectContaining({
      url: `https://jobs.ashbyhq.com/newco/${uuid(1)}`,
      title: "Software Engineer",
      company_hint: "Newco",
      domain: "newco.ai",
      domain_from: "board",
      kind: "posting",
      source: "board-poll",
      source_tag: "Board poll",
    }),
  ]);
  expect(checked).toEqual(["https://jobs.ashbyhq.com/newco"]);
  // Filed once: the next round finds it a signal already, before any call.
  recordSignal(leads[0]!, now);
  writeSourceState("board-poll", { next: 0 });
  checked = [];
  expect(await boardPoll.fetch(null, now)).toEqual([]);
});

test("a company we have is joined on the website its board states; one sharing only the name is skipped; an agency is dropped", async () => {
  table(["ours", "namesake", "agency", "mine"]);
  const mineId = upsertCompany({ name: "Mine", domain: "mine.dev" });
  addBoard(mineId, "ashby", "https://jobs.ashbyhq.com/mine", "test", now); // already ours: never polled
  upsertCompany({ name: "Oursco", domain: "oursco.com" });
  upsertCompany({ name: "Axiom", domain: "axiom.co" });
  boards = {
    ours: [job("ours", 1, "Software Engineer", day(1))],
    namesake: [job("namesake", 2, "Software Engineer", day(1))],
    agency: [job("agency", 3, "Software Engineer", day(1))],
    mine: [job("mine", 4, "Software Engineer", day(1))],
  };
  states = {
    ours: { name: "Ours Inc", site: "oursco.com" },
    namesake: { name: "Axiom", site: "axiombio.com" },
    agency: { name: "True Talent", site: null },
  };
  verdicts = { agency: "agency" };
  const leads = await boardPoll.fetch(null, now);
  expect(scanned).toEqual(["ours", "namesake", "agency"]);
  expect(leads.map((l) => [l.company_hint, l.domain])).toEqual([["Ours Inc", "oursco.com"]]);
  expect(checked).toEqual(["https://jobs.ashbyhq.com/agency"]); // a company we have needs no check
  expect(boardPoll.note).toBe("1 sharing only a name · 1 not by their employer");
});

test("each tick reads the next slice, round the table", async () => {
  table(["a", "b", "c", "d", "e"]);
  boards = {};
  await boardPoll.fetch(null, now);
  await boardPoll.fetch(null, now);
  expect(scanned).toEqual(["a", "b", "c", "d", "e", "a"]);
  expect(readSourceState<{ next: number }>("board-poll", { next: 0 }).next).toBe(1);
});

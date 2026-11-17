import { afterAll, expect, test } from "bun:test";
import { type RunnerCompany, runRunner, setRunner } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { tempData } from "../core/testing.ts";
import { mergeCompanies, upsertCompany, wake } from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { applyRead, type Board } from "../intake/refresh.ts";
import { isReading, items, notACompany, reasons, retryAll, setByHand, stopAll, undoNot } from "./pipeline.ts";

const { cleanup } = tempData();
afterAll(() => {
  setRunner(runRunner);
  cleanup();
});

test("Stop on a retry leaves alone a new company given the number of one the retry lined up", () => {
  const keep = upsertCompany({ name: "Keep Co" });
  const gone = upsertCompany({ name: "Gone Co" });
  open().query("UPDATE companies SET discovery = 'none' WHERE id IN (?, ?)").run(keep, gone);
  retryAll("website", null);
  // The newest row goes in a merge, and SQLite gives its number to the next company.
  mergeCompanies(keep, gone, "the same company");
  const next = upsertCompany({ name: "Next Co" });
  expect(next).toBe(gone);
  wake(next);
  stopAll("website");
  const discovery = (id: number) =>
    (open().query("SELECT discovery FROM companies WHERE id = ?").get(id) as { discovery: string }).discovery;
  expect([discovery(keep), discovery(next)]).toEqual(["none", "queued"]);
});

test("a stuck list pages whole, and Not a company takes a post out of every reason until Undo", () => {
  const d = open();
  const add = d.query(
    "INSERT INTO signals (source, source_tag, ref, url, text, author, received_at, classify_tries) VALUES ('x', 'X bookmark', ?, ?, ?, '@poster', ?, ?)",
  );
  // 25 posts, some at the same moment: the pages still neither repeat nor skip one.
  for (let i = 0; i < 25; i++)
    add.run(
      `r${i}`,
      `https://x.com/p/status/${i}`,
      `post ${i}`,
      `2026-11-0${1 + (i % 5)}T00:00:00.000Z`,
      i % 2 ? 9 : 20,
    );
  const seen: number[] = [];
  let after: string | undefined;
  for (;;) {
    const page = items("named", { after });
    if (!page.length) break;
    seen.push(...page.map((p) => p.id));
    after = page.at(-1)!.cursor;
  }
  expect(seen.length).toBe(25);
  expect(new Set(seen).size).toBe(25);
  const first = items("named")[0]!;
  expect(first.post).toMatchObject({ author: "@poster", url: expect.stringContaining("https://x.com/") });

  const total = () => reasons("named").reduce((a, r) => a + r.n, 0);
  const { prev } = notACompany("named", first.id);
  expect(total()).toBe(24);
  expect(items("named", { limit: 500 }).some((i) => i.id === first.id)).toBe(false);
  undoNot("named", first.id, prev);
  expect(total()).toBe(25);
  expect(items("named")[0]!.reason).toBe(first.reason);
});

test("a board given by hand that is no link, or LinkedIn's, is refused at once and nothing is read", async () => {
  const id = upsertCompany({ name: "Pastedco", domain: "pastedco.dev" });
  await expect(setByHand("board", id, "not a link")).rejects.toThrow("isn't a web address");
  await expect(setByHand("board", id, "linkedin.com/company/pastedco/jobs")).rejects.toThrow("never read");
  expect(isReading(id)).toBe(false);
});

test("Change its board: a pasted Ashby link, filtered, is its board; its first roles retire the empty careers page", async () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const id = upsertCompany({ name: "Quillo", domain: "quillo.dev" });
  const board = (url: string) => open().query("SELECT * FROM boards WHERE url = ?").get(url) as Board;
  const job = (n: string, url: string) => ({
    id: n,
    title: "Backend Engineer",
    url,
    location: "Remote",
    postedAt: null,
  });
  // Its careers page reads empty; a Lever board it also has lists a role, and stays.
  addBoard(id, "careers-page", "https://quillo.dev/careers", "careers page", now);
  applyRead(board("https://quillo.dev/careers"), { ok: true, jobs: [] }, now);
  addBoard(id, "lever", "https://jobs.lever.co/quillo", "lead", now);
  applyRead(
    board("https://jobs.lever.co/quillo"),
    { ok: true, jobs: [job("l1", "https://jobs.lever.co/quillo/l1")] },
    now,
  );
  const asked: RunnerCompany[] = [];
  setRunner(async (_mode, cs) => {
    asked.push(...cs);
    return cs.map((c) => ({
      domain: c.domain,
      ok: true,
      detect: { provider: "ashby", careers_url: c.hint, method: "lead" },
    }));
  });
  expect(await setByHand("board", id, "jobs.ashbyhq.com/quillo?departmentId=eng")).toContain(
    "Reading it now",
  );
  while (isReading(id)) await Bun.sleep(5);
  expect(asked.map((c) => c.hint)).toEqual(["https://jobs.ashbyhq.com/quillo"]);
  const ashby = board("https://jobs.ashbyhq.com/quillo");
  expect([ashby.company_id, ashby.found_by]).toEqual([id, "by hand"]);
  const status = () =>
    open().query("SELECT provider, status FROM boards WHERE company_id = ? ORDER BY id").all(id);
  expect(status()).toEqual([
    { provider: "careers-page", status: "ok" },
    { provider: "lever", status: "ok" },
    { provider: "ashby", status: "ok" },
  ]);
  // Its first read lists roles: the careers page that found none is retired, not deleted.
  applyRead(ashby, { ok: true, jobs: [job("a1", "https://jobs.ashbyhq.com/quillo/a1")] }, now);
  expect(status()).toEqual([
    { provider: "careers-page", status: "retired" },
    { provider: "lever", status: "ok" },
    { provider: "ashby", status: "ok" },
  ]);
});

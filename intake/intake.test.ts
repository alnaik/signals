import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { close, dbFile, open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { canSpend, capLeft, monthSpend, record } from "../core/ledger.ts";
import { paths } from "../core/paths.ts";
import { modelCost } from "../core/prices.ts";
import { readState } from "../core/state.ts";
import { tempData } from "../core/testing.ts";
import { plists } from "../scripts/launchd.ts";
import { signalsPage } from "../signals/query.ts";
import { getCompany, upsertCompany, watchCompany, watchedCompanies } from "./companies.ts";
import { isDue, lastNightStart, lastWeekdayStart } from "./due.ts";
import { companyDomain, intakeLead, normalizeUrl } from "./leads.ts";
import { refilter } from "./prune.ts";
import { repairOnce } from "./repair.ts";
import { runSource } from "./run.ts";
import type { Lead, Source } from "./types.ts";

const data = tempData();
afterAll(data.cleanup);
beforeEach(() => {
  index.close();
  rmSync(paths.threads(), { recursive: true, force: true });
  rmSync(paths.index(), { force: true });
  rmSync(paths.ledger(), { force: true });
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies; DELETE FROM meta;",
  );
});

const lead = (over: Partial<Lead> = {}): Lead => ({
  url: "https://tessera.dev/blog/hiring",
  source: "drop",
  source_tag: "drop folder",
  company_hint: "Tessera Labs",
  ...over,
});

test("company domain comes from the lead, the hint or a non-platform URL", () => {
  expect(companyDomain(lead({ domain: "tessera.dev", url: "https://x.com/a/status/1" }))).toBe("tessera.dev");
  expect(companyDomain(lead({ company_hint: "https://www.quarry.so" }))).toBe("quarry.so");
  expect(companyDomain(lead({ company_hint: "Quarry", url: "https://x.com/a/status/1" }))).toBeNull();
  expect(normalizeUrl("https://twitter.com/a/status/1?utm_source=x&s=20#frag")).toBe(
    "https://x.com/a/status/1",
  );
});

test("intake keeps each signal, dedupes and keeps the unplaceable for the classifier; no thread opens", () => {
  expect(intakeLead(lead()).result).toBe("added");
  expect(intakeLead(lead()).result).toBe("duplicate");
  expect(intakeLead(lead({ url: "https://tessera.dev/changelog" })).result).toBe("added");
  expect(intakeLead(lead({ url: "https://x.com/someone/status/9", company_hint: "?" })).result).toBe(
    "pending",
  );
  expect(intakeLead(lead({ url: "https://x.com/someone/status/9", company_hint: "?" })).result).toBe(
    "duplicate",
  );
  // Two signals, one company, one row on Signals (nothing that fits yet); the unplaceable one waits
  // with no company.
  expect(signalsPage({ view: "posted" }).companies.map((c) => [c.name, c.signals])).toEqual([
    ["Tessera Labs", 2],
  ]);
  expect(open().query("SELECT count(*) AS n FROM signals WHERE company_id IS NULL").get()).toEqual({ n: 1 });
  expect(index.threadIds()).toEqual([]);
  // Sources never watch a company.
  expect(watchedCompanies()).toEqual([]);
});

test("a source failing three times in a row turns red with its reason", async () => {
  const bad: Source = {
    key: "dead",
    name: "Dead source",
    schedule: "daily",
    connected: () => true,
    fetch: async () => {
      throw new Error("dead.example: 404");
    },
  };
  for (let i = 0; i < 3; i++) await runSource(bad);
  const s = readState().sources.dead!;
  expect(s.failures).toBe(3);
  expect(s.reason).toBe("dead.example: 404");
  const good: Source = { ...bad, fetch: async () => [lead()] };
  const r = await runSource(good);
  expect(r.ok).toBe(true);
  expect(readState().sources.dead?.failures).toBe(0);
  expect(readState().sources.dead?.stat).toBe("1 / 1 kept");
});

test("schedules catch up after sleep", () => {
  const now = new Date(2026, 9, 22, 8, 0); // 08:00 local, after a night asleep
  expect(lastNightStart(now).getHours()).toBe(1);
  expect(isDue("nightly", new Date(2026, 9, 21, 1, 5).toISOString(), now)).toBe(true);
  expect(isDue("nightly", new Date(2026, 9, 22, 1, 5).toISOString(), now)).toBe(false);
  expect(isDue("every_6h", new Date(2026, 9, 22, 3, 0).toISOString(), now)).toBe(false);
  expect(isDue("every_6h", new Date(2026, 9, 22, 2, 0).toISOString(), now)).toBe(true);
  expect(isDue("manual", undefined, now)).toBe(false);
  // every_hours from config.toml replaces the source's schedule
  expect(isDue("daily", new Date(2026, 9, 22, 5, 0).toISOString(), now, 6)).toBe(false);
  expect(isDue("daily", new Date(2026, 9, 22, 2, 0).toISOString(), now, 6)).toBe(true);
  // day from config.toml: weekly, from that weekday's night window (2026-10-19 and 26 are Mondays)
  const thu = new Date(2026, 9, 22, 8, 0);
  expect(lastWeekdayStart(1, thu)).toEqual(new Date(2026, 9, 19, 1, 0));
  expect(isDue("nightly", new Date(2026, 9, 19, 0, 30).toISOString(), thu, 168, 1)).toBe(true);
  expect(isDue("nightly", new Date(2026, 9, 19, 1, 5).toISOString(), thu, 168, 1)).toBe(false);
  const mon = new Date(2026, 9, 26, 0, 59); // before Monday's window: still last week's run
  expect(isDue("nightly", new Date(2026, 9, 19, 1, 5).toISOString(), mon, 168, 1)).toBe(false);
  expect(
    isDue("nightly", new Date(2026, 9, 19, 1, 5).toISOString(), new Date(2026, 9, 26, 1, 15), 168, 1),
  ).toBe(true);
});

test("ledger costs, this month's real spend and the monthly cap", () => {
  expect(modelCost("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(3);
  writeFileSync(paths.config(), "[caps]\nmonth_usd = 1\n");
  record({ kind: "model", station: "worker", model: "claude-sonnet-5-5", usd: 0, notional_usd: 0.4 });
  record({ kind: "provider", station: "people", provider: "exa", usd: 0.7 });
  // Last month's spend and notional subscription dollars don't count.
  record({ kind: "provider", station: "people", provider: "exa", usd: 5, ts: "2020-01-01T00:00:00Z" });
  // A line from before 2026-10-27 kept a subscription run's notional cost in usd.
  record({ kind: "model", station: "classify", usd: 0.03, note: "claude-code-subscription" });
  expect(monthSpend()).toBeCloseTo(0.7);
  expect(capLeft()).toBeCloseTo(0.3);
  expect(canSpend(0.25)).toBe(true);
  expect(canSpend(0.35)).toBe(false);
});

// plutil is macOS-only; CI runs on Linux, the app on a Mac.
test.skipIf(process.platform !== "darwin")("launchd plists are valid", () => {
  for (const [label, xml] of Object.entries(plists())) {
    const file = path.join(os.tmpdir(), `${label}.plist`);
    writeFileSync(file, xml);
    expect(Bun.spawnSync(["plutil", "-lint", file]).exitCode).toBe(0);
  }
});

test("a posting's own age limit wins", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const lead = (domain: string, max?: number | null) => ({
    url: `https://news.ycombinator.com/item?id=${domain}`,
    domain,
    company_hint: "Hiring Co",
    kind: "posting" as const,
    posted_at: "2026-10-02T12:00:00Z",
    source: "hn",
    source_tag: "HN",
    ...(max !== undefined ? { max_age_days: max } : {}),
  });
  expect(intakeLead(lead("old.dev"), now).result).toBe("stale");
  expect(intakeLead(lead("month.dev", 35), now).result).toBe("added");
  expect(intakeLead(lead("open.dev", null), now).result).toBe("added");
});

test("a company found without a board rejoins discovery once per job board a new signal links", () => {
  const at = (discovery: string | null, id: number) =>
    open().query("UPDATE companies SET discovery = ? WHERE id = ?").run(discovery, id);
  const board = (url: string) =>
    lead({
      url,
      source: "board-search",
      source_tag: "board search",
      domain: "acme.com",
      company_hint: "Acme",
    });
  const acme = upsertCompany({ name: "Acme", domain: "acme.com" });
  at("none", acme);
  // A post links no board: it stays as it was.
  intakeLead(lead({ url: "https://acme.com/blog/hiring", domain: "acme.com", company_hint: "Acme" }));
  expect(getCompany(acme)?.discovery).toBe("none");
  // The first posting on a board: back in the queue (its signal is discovery's hint).
  intakeLead(board("https://job-boards.greenhouse.io/acme/jobs/1"));
  expect(getCompany(acme)?.discovery).toBe("queued");
  // Looked at again and refused (robots.txt): a second posting on that board leaves it.
  at("blocked", acme);
  intakeLead(board("https://job-boards.greenhouse.io/acme/jobs/2"));
  expect(getCompany(acme)?.discovery).toBe("blocked");
  // Another board is new.
  intakeLead(board("https://jobs.lever.co/acme/5f1c"));
  expect(getCompany(acme)?.discovery).toBe("queued");
  at("unreadable", acme);
  intakeLead(board("https://jobs.lever.co/acme/7a2d"));
  expect(getCompany(acme)?.discovery).toBe("unreadable");
  // Never looked at, or found with its board gone: any signal queues it, as before.
  const fresh = upsertCompany({ name: "Vela", domain: "vela.dev" });
  intakeLead(lead({ url: "https://vela.dev/jobs", domain: "vela.dev", company_hint: "Vela" }));
  expect(getCompany(fresh)?.discovery).toBe("queued");
  at("found", fresh);
  intakeLead(lead({ url: "https://vela.dev/jobs/2", domain: "vela.dev", company_hint: "Vela" }));
  expect(getCompany(fresh)?.discovery).toBe("queued");
});

test("a name resolves only on an exact match; two exact matches are no answer", async () => {
  const { resolveCompany } = await import("./resolve.ts");
  expect(await resolveCompany("Vela")).toBeNull();
  watchCompany(upsertCompany({ name: "Acme", domain: "acme.com" }), "manual");
  watchCompany(upsertCompany({ name: "Acme Inc.", domain: "acme.io" }), "manual");
  expect(await resolveCompany("Acme")).toBeNull();
});

test("new filters drop what a filtering source took in under the old ones, unless you acted on it", () => {
  const passing = new Set(["keep"]);
  const forgot: string[] = [];
  const src = {
    key: "hn",
    stillPasses: (s: { text: string | null }) => passing.has(s.text ?? ""),
    forget: (refs: string[]) => forgot.push(...refs),
  } as unknown as Source;
  const hn = (id: number, name: string, text: string) =>
    intakeLead(
      lead({ url: `https://news.ycombinator.com/item?id=${id}`, source: "hn", company_hint: name, text }),
    );
  hn(1, "Gone Co", "old filters");
  hn(2, "Kept Co", "keep");
  hn(3, "Watched Co", "old filters");
  hn(4, "Both Co", "old filters");
  intakeLead(lead({ url: "https://both.dev/jobs", company_hint: "Both Co" }));
  watchCompany(
    (open().query("SELECT id FROM companies WHERE name = 'Watched Co'").get() as { id: number }).id,
    "inbox",
  );
  const out = refilter([src]);
  expect(out.companies).toEqual(["Gone Co"]);
  expect(forgot).toEqual([
    "https://news.ycombinator.com/item?id=1",
    "https://news.ycombinator.com/item?id=4",
  ]);
  const names = (open().query("SELECT name FROM companies ORDER BY name").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(names).toEqual(["Both Co", "Kept Co", "Watched Co"]);
});

test("a database made new skips the one-time repair: a fund lead's looked-up website stays unproven", () => {
  close();
  rmSync(dbFile(), { force: true });
  const id = upsertCompany({ name: "Larkspur Freight", domain: "larkspurfreight.com", from: "looked up" });
  expect(repairOnce()).toEqual([]);
  expect(getCompany(id)?.domain_from).toBe("looked up");
});

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { derive } from "../core/derive.ts";
import { read } from "../core/log.ts";
import { tempData } from "../core/testing.ts";
import { intakeLead } from "../intake/leads.ts";
import { signalsPage } from "../signals/query.ts";
import { mailToPast, mbox, notebookCsv } from "./formats.ts";
import { importPast } from "./import.ts";

const data = tempData();
afterAll(data.cleanup);
const FIX = path.join(import.meta.dir, "..", "fixtures");

test("the notebook CSV becomes past applications; a lead CSV doesn't", () => {
  const rows = notebookCsv(readFileSync(path.join(FIX, "drop", "notebook.csv"), "utf8"))!;
  expect(rows).toEqual([
    {
      company: "Ember",
      role: "Frontend Engineer",
      url: "https://ember.co/jobs/fe",
      date: "2025-03-02",
      status: "rejected",
      notes: "no reply after 3 weeks",
      source: "notebook",
    },
    {
      company: "Pylon",
      role: "Product Engineer",
      url: "https://pylon.dev/careers/pe",
      date: "2025-04-11",
      status: "interview",
      source: "notebook",
    },
  ]);
  expect(notebookCsv("url,note\nhttps://x.dev,hi\n")).toBeNull();
});

test("email history: confirmations and rejections, never other mail", () => {
  const found = [...mbox(readFileSync(path.join(FIX, "past", "takeout.mbox"), "utf8"))].flatMap(
    ({ mail, body }) => mailToPast(mail, body) ?? [],
  );
  expect(found.map((p) => [p.company, p.role ?? null, p.status, p.domain ?? null])).toEqual([
    ["Quarry", null, "applied", null],
    ["Marlin", "Senior Engineer", "rejected", "marlin.ai"],
  ]);
});

test("a past application is a closed thread with history; a new role from the company goes to the Inbox", async () => {
  const r = await importPast({
    company: "Ember",
    role: "Frontend Engineer",
    url: "https://ember.co/jobs/fe",
    date: "2025-03-02",
    status: "rejected",
    source: "notebook",
  });
  expect(r).toEqual({ result: "imported", id: "ember.co" });
  expect(
    await importPast({
      company: "Ember",
      role: "Frontend Engineer",
      url: "https://ember.co/jobs/fe",
      date: "2025-03-02",
      status: "rejected",
      source: "notebook",
    }),
  ).toEqual({ result: "duplicate" });
  const d = derive(read("ember.co"));
  expect(d.status).toBe("closed");
  expect(d.closeReason).toBe("rejected");
  expect(d.roles.map((r) => r.status)).toEqual(["applied"]);
  expect(read("ember.co")[0]!.ts.slice(0, 10)).toBe("2025-03-02");

  intakeLead({
    url: "https://ember.co/jobs/new-role",
    domain: "ember.co",
    source: "ats",
    source_tag: "ATS change",
    kind: "posting",
  });
  // Named again after the thread's last word: back on Signals; the closed thread keeps its history
  // until you choose.
  expect(signalsPage({ view: "posted" }).companies.map((c) => c.domain)).toEqual(["ember.co"]);
  expect(derive(read("ember.co")).status).toBe("closed");
});

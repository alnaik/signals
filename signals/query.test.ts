import { afterAll, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { chooseCompany } from "../inbox/choose.ts";
import { inboxCompany } from "../inbox/query.ts";
import { recordSignal, upsertCompany } from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { applyRead, type Board } from "../intake/refresh.ts";
import {
  hideCompany,
  restage,
  type SignalsCompany,
  signalsPage,
  signalsSummary,
  type View,
} from "./query.ts";

const data = tempData();
afterAll(data.cleanup);
beforeEach(() => {
  index.close();
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies;",
  );
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ filters: { title_include: ["Engineer"], locations: ["Denver, CO"], remote_ok: false } }),
  );
  restage();
});

const now = new Date("2026-11-13T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
let n = 0;
/** A company a signal named `days` ago, with a board listing `jobs` when given. */
function named(
  name: string,
  domain: string | null,
  o: { days?: number; jobs?: [string, string][]; x?: boolean } = {},
) {
  const id = recordSignal(
    {
      url: `https://news.ycombinator.com/item?id=${++n}`,
      company_hint: name,
      ...(domain ? { domain } : {}),
      title: `${name} is hiring`,
      ...(o.x ? { source: "x", source_tag: "X bookmark" } : { source: "hn", source_tag: "HN" }),
    },
    ago(o.days ?? 1),
  ).companyId!;
  if (o.jobs) {
    const board = addBoard(id, "lever", `https://jobs.lever.co/${name.toLowerCase()}`, "test", now).board!;
    applyRead(
      board as Board,
      {
        ok: true,
        jobs: o.jobs.map(([title, location], i) => ({
          id: `${name}${i}`,
          title,
          location,
          url: `https://jobs.lever.co/${name.toLowerCase()}/${i}`,
          postedAt: null,
        })),
      },
      now,
    );
  }
  return id;
}
const names = (view: View) => signalsPage({ view }, now).companies.map((c) => c.name);
const one = (view: View, name: string) =>
  signalsPage({ view }, now).companies.find((c) => c.name === name) as SignalsCompany;

test("Signals lists what a signal named with nothing that fits, by why; noise is folded, not lost", () => {
  named("Nearco", "nearco.dev", {
    jobs: [
      ["Backend Engineer", "Dallas, TX"],
      ["Recruiter", "Denver, CO"],
    ],
  });
  named("Uline", "uline.com", { jobs: [["Customer Service Rep", "Denver, CO"]] });
  named("Fitco", "fitco.dev", { jobs: [["Backend Engineer", "Denver, CO"]] }); // fits: the Inbox's
  named("Quietco", "quietco.dev");
  named("Readless", "readless.dev");
  open().query("UPDATE companies SET discovery = 'unreadable' WHERE name = 'Readless'").run();
  named("Oldco", "oldco.dev", { days: 120 });
  // A bookmark of a post from 2019, filed two days ago: recent, by when it reached you.
  named("Bookmarkco", "bookmarkco.dev", { days: 2, x: true });
  open()
    .query("UPDATE signals SET received_at = '2019-05-01T00:00:00.000Z' WHERE title = 'Bookmarkco is hiring'")
    .run();
  named("Nosite", null, { x: true });
  named("Hnco", null); // no website, but HN's hiring thread named it: Work looks for it
  named("Acme Ventures", "acme.vc");
  named("Confidential AI Co", null, { x: true });
  named("Deadco", "deadco.dev");
  open()
    .query(
      "UPDATE companies SET discovery = 'none', discovery_note = 'certificate expired' WHERE name = 'Deadco'",
    )
    .run();
  upsertCompany({ name: "Listco", domain: "listco.dev" }); // no signal on record
  chooseCompany(named("Gone", "gone.dev"), "dismiss", now);
  chooseCompany(named("Seen", "seen.dev"), "watch", now);
  restage();

  expect(names("hiring")).toEqual(["Nearco"]);
  const near = one("hiring", "Nearco");
  expect(near.why).toBe("2 open roles, none fit you · 1 near miss");
  expect(near.nearRole).toEqual({ title: "Backend Engineer", why: "Dallas, TX: outside your places" });
  expect(names("other")).toEqual(["Uline"]);
  expect(one("other", "Uline").why).toBe("1 open role, none with your title words");
  expect(names("posted").sort()).toEqual(["Bookmarkco", "Hnco", "Quietco"]);
  expect(one("posted", "Bookmarkco").signal?.at).toBe("2019-05-01T00:00:00.000Z");
  expect(one("posted", "Quietco").why).toBe("looking for its board now");
  expect(one("posted", "Hnco").why).toBe("no website known yet: Work looks for it first");
  expect(names("unread")).toEqual(["Readless"]);
  expect(names("older")).toEqual(["Oldco"]);
  expect(
    signalsPage({ view: "noise" }, now)
      .companies.map((c) => [c.name, c.noise])
      .sort(),
  ).toEqual([
    ["Acme Ventures", "fund"],
    ["Confidential AI Co", "noname"],
    ["Deadco", "dead"],
    ["Listco", "nosignal"],
    ["Nosite", "nosite"],
  ]);
  const all = (["hiring", "other", "posted", "unread", "older", "noise"] as View[]).flatMap(names);
  for (const out of ["Fitco", "Gone", "Seen"]) expect(all).not.toContain(out);
  expect(signalsSummary({}, now).counts).toMatchObject({
    hiring: 1,
    other: 1,
    posted: 3,
    unread: 1,
    noise: 5,
  });
});

test("Hide takes a company off Signals only; Dismiss keeps it and what it posts later out everywhere", () => {
  const hidden = named("Hidco", "hidco.dev", { jobs: [["Backend Engineer", "Dallas, TX"]] });
  const dismissed = named("Disco", "disco.dev", { jobs: [["Backend Engineer", "Dallas, TX"]] });
  restage();
  expect(names("hiring").sort()).toEqual(["Disco", "Hidco"]);
  hideCompany(hidden, true, now);
  chooseCompany(dismissed, "dismiss", now);
  expect(names("hiring")).toEqual([]);
  expect(names("hidden")).toEqual(["Hidco"]); // its own fold, where Unhide is
  // A role that fits, later: the hidden company reaches the Inbox; the dismissed one doesn't.
  for (const [id, name] of [
    [hidden, "hidco"],
    [dismissed, "disco"],
  ] as const) {
    const board = open().query("SELECT * FROM boards WHERE company_id = ?").get(id) as Board;
    applyRead(
      board,
      {
        ok: true,
        jobs: [
          {
            id: "x",
            title: "Backend Engineer",
            location: "Denver, CO",
            url: `https://jobs.lever.co/${name}/x`,
            postedAt: null,
          },
        ],
      },
      now,
    );
  }
  expect(inboxCompany(hidden, {}, now)?.roles).toBe(1);
  expect(inboxCompany(dismissed, {}, now)).toBeNull();
  hideCompany(hidden, false, now);
  expect(names("hidden")).toEqual([]);
});

test("Work on a company with no role: a thread with what named it, and the company leaves Signals", () => {
  const id = named("Quietco", "quietco.dev");
  restage();
  expect(names("posted")).toEqual(["Quietco"]);
  expect(chooseCompany(id, "work", now)).toMatchObject({ ok: true, thread: "quietco.dev" });
  expect(index.get("quietco.dev")).toMatchObject({ company: "Quietco", roles: [], status: null });
  restage();
  expect(names("posted")).toEqual([]);
  // Named again later: back, with the thread kept.
  named("Quietco", "quietco.dev", { days: -1 });
  restage();
  expect(
    signalsPage({ view: "posted" }, new Date(now.getTime() + 2 * 86_400_000)).companies.map((c) => c.name),
  ).toEqual(["Quietco"]);
});

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { setPageReader } from "../ats/reader.ts";
import { derive } from "../core/derive.ts";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { getCompany, threadIdOf, upsertCompany } from "../intake/companies.ts";
import { addBoard, giveDomain } from "../intake/discover.ts";
import { adoptStandIns } from "../live/watcher.ts";
import { queue } from "./queue.ts";
import { adopt, findWebsite } from "./website.ts";

const data = tempData();
afterAll(() => data.cleanup());

const pages: Record<string, string> = {
  // Ashby's embed view, which states the board's company and website.
  "https://jobs.ashbyhq.com/tallowly?embed=js":
    '<script>{"organization":{"organizationId":"x","name":"Tallowly","publicWebsite":"https://tallowly.com/","hostedJobsPageSlug":"tallowly"}}</script>',
};
setPageReader(async (url) => {
  if (!(url in pages)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
  return { text: pages[url]!, url } as { text: string };
});

/** A company known by name with a board, its stand-in thread with an applied role, Work pressed. */
function standIn(name: string, board: string) {
  const id = upsertCompany({ name });
  addBoard(id, "ashby", board, "lead");
  const thread = threadIdOf(getCompany(id)!);
  append(thread, {
    actor: "ats",
    kind: "signal",
    data: { company: name, kind: "posting", title: "Engineer" },
  });
  append(thread, { actor: "board", kind: "decision", data: { action: "applied", url: "engineer" } });
  append(thread, { actor: "board", kind: "decision", data: { action: "work" } });
  index.reindex(thread);
  return { id, thread };
}

test("its board states its website: the thread moves there with everything in it, ready for Work", async () => {
  const { id, thread } = standIn("Tallowly", "https://jobs.ashbyhq.com/tallowly");
  expect(await findWebsite(thread)).toBe("tallowly.com");
  expect(getCompany(id)).toMatchObject({ domain: "tallowly.com", domain_from: "board" });
  expect(existsSync(paths.thread(thread))).toBe(false);
  expect(derive(read("tallowly.com"))).toMatchObject({ company: "Tallowly", status: "researching" });
  expect(queue()).toContain("tallowly.com");
});

test("a stand-in joining a thread that exists already adds its log and keeps both", () => {
  append("joined.dev", { actor: "board", kind: "note", data: { text: "already here" } });
  append("joined.no-domain", { actor: "board", kind: "note", data: { text: "from the stand-in" } });
  adopt("joined.no-domain", "joined.dev");
  expect(read("joined.dev").map((e) => e.data.text)).toEqual(["already here", "from the stand-in"]);
  expect(existsSync(paths.thread("joined.no-domain"))).toBe(false);
  expect(index.get("joined.no-domain")).toBeNull();
});

test("discovery gives a stand-in's company its website: the next Inbox change moves the thread there, unless it waits for Work's look", () => {
  const id = upsertCompany({ name: "Quietly" });
  const thread = threadIdOf(getCompany(id)!);
  append(thread, {
    actor: "ats",
    kind: "signal",
    data: { company: "Quietly", kind: "posting", title: "Engineer" },
  });
  index.reindex(thread);
  const held = standIn("Held", "https://jobs.ashbyhq.com/held");
  giveDomain(id, "quietly.dev", "board");
  giveDomain(held.id, "held.dev", "board");
  adoptStandIns();
  expect(existsSync(paths.thread(thread))).toBe(false);
  expect(derive(read("quietly.dev"))).toMatchObject({ company: "Quietly" });
  expect(existsSync(paths.thread(held.thread))).toBe(true);
  expect(existsSync(paths.thread("held.dev"))).toBe(false);
});

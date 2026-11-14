import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { setRunner } from "../ats/reader.ts";
import { exists } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { inboxPage } from "../inbox/query.ts";
import { companyByDomain } from "../intake/companies.ts";
import { setProviders } from "../providers/registry.ts";
import { addNow, fitting, resolve } from "./add.ts";

const data = tempData();
afterAll(() => {
  setProviders(null);
  data.cleanup();
});
// No brand directory, no paid search: a name resolves only by the rules.
setProviders([]);

const job = (slug: string, id: string, location: string) => ({
  id,
  title: `Engineer ${id}`,
  url: `https://jobs.lever.co/${slug}/${id}`,
  location,
  postedAt: new Date().toISOString(), // posted today: a role arrives new only when it's news
});
function board(slug: string) {
  setRunner(async (mode, companies) =>
    companies.map((c) =>
      mode === "detect"
        ? {
            domain: c.domain,
            ok: true,
            detect: {
              provider: "lever",
              careers_url: `https://jobs.lever.co/${slug}`,
              method: c.hint ? "lead" : "page",
            },
          }
        : {
            domain: c.domain,
            ok: true,
            jobs: [job(slug, "1", "Boulder, CO"), job(slug, "2", "Remote - US"), job(slug, "3", "New York")],
          },
    ),
  );
}

test("Add watches the company and reads its board now; its roles that fit are on its page and, new to you, in the Inbox", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ filters: { locations: ["Boulder"], remote_ok: true } }),
  );
  board("newco");
  const lines: string[] = [];
  const { companyId, board: b } = await addNow(await resolve("https://www.newco.dev/careers"), (l) =>
    lines.push(l),
  );
  expect(b).toMatchObject({ provider: "lever", url: "https://jobs.lever.co/newco" });
  expect(lines.slice(0, 2)).toEqual(["looking for Newco's board", "reading lever"]);
  expect(lines[2]).toStartWith("2 roles fit · 1 boards read");
  expect(
    fitting(companyId)
      .map((j) => j.title)
      .sort(),
  ).toEqual(["Engineer 1", "Engineer 2"]);
  expect(companyByDomain("newco.dev")?.watched_at).toBeTruthy();
  // Watched as its board was read: its roles are new to you, so it's in the Inbox, marked.
  expect(inboxPage().companies.find((c) => c.domain === "newco.dev")).toMatchObject({
    watched: true,
    roles: 2,
  });
  expect(exists("newco.dev")).toBe(false);
});

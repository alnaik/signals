import { afterAll, expect, test } from "bun:test";
import { open } from "../core/db.ts";
import { tempData } from "../core/testing.ts";
import { repairBoards, repairName } from "./cleanup.ts";
import { getCompany, upsertCompany } from "./companies.ts";

const data = tempData();
afterAll(data.cleanup);

/** A board as discovery stored it, with one role on it. */
function board(company: number, provider: string, url: string, key: string) {
  const d = open();
  const b = d
    .query(
      `INSERT INTO boards (company_id, provider, url, key, found_by, created_at) VALUES (?, ?, ?, ?, 'test', '2026-11-01')
       RETURNING id`,
    )
    .get(company, provider, url, key) as { id: number };
  d.query(
    `INSERT INTO roles (board_id, company_id, url, title, first_seen, last_seen, state) VALUES (?, ?, ?, 'Engineer', '2026-11-01', '2026-11-01', 'archived')`,
  ).run(b.id, company, `${url}#role`);
  return b.id;
}
const boardUrl = (id: number) =>
  (open().query("SELECT url FROM boards WHERE id = ?").get(id) as { url: string } | null)?.url ?? null;

test("repair boards: a link in a name, one posting held as a board, another company's or website's board", async () => {
  const baserow = upsertCompany({ name: "Baserow ( https://baserow.io )", domain: "baserow.io" });
  const gauntlet = upsertCompany({ name: "Gauntlet AI", domain: "gauntletai.com" });
  const page = board(
    gauntlet,
    "careers-page",
    "https://gauntletai.com/careers/storyteller",
    "careers-page:gauntletai.com",
  );
  const pierre = upsertCompany({ name: "Pierre", domain: "pierre.computer" });
  const gone = board(
    pierre,
    "careers-page",
    "https://pierre.computer/careers/systems",
    "careers-page:pierre.computer",
  );
  const umh = upsertCompany({ name: "UMH", domain: "umh.app" });
  const own = board(
    umh,
    "personio",
    "https://umh-systems-gmbh.jobs.personio.de/job/1?apply",
    "personio:umh-systems-gmbh.jobs.personio.de",
  );
  const eniac = upsertCompany({ name: "Eniac Ventures", domain: "eniac.vc" });
  const joby = board(
    eniac,
    "icims",
    "https://careers-jobyaviation.icims.com/jobs/5508/x/job",
    "icims:careers-jobyaviation",
  );
  const amdocs = upsertCompany({ name: "Amdocs", domain: "amdocs.com" });
  const volk = board(
    amdocs,
    "eightfold",
    "https://app.eightfold.ai/careers?domain=volkscience.com",
    "eightfold:app.eightfold.ai/volkscience.com",
  );
  const live = async (url: string) => !url.includes("pierre.computer");

  // A dry run says it all and changes nothing.
  const said = await repairBoards({ dry: true, answers: live });
  expect(said).toHaveLength(6);
  expect(getCompany(baserow)?.name).toBe("Baserow ( https://baserow.io )");
  expect(boardUrl(page)).toBe("https://gauntletai.com/careers/storyteller");

  expect(await repairBoards({ answers: live })).toEqual(said);
  expect(getCompany(baserow)?.name).toBe("Baserow");
  // The company's own: moved to the listing, its roles kept (what you set aside stays so).
  expect(boardUrl(page)).toBe("https://gauntletai.com/careers");
  expect(boardUrl(own)).toBe("https://umh-systems-gmbh.jobs.personio.de/");
  expect(open().query("SELECT count(*) AS n FROM roles WHERE board_id = ?").get(page)).toEqual({ n: 1 });
  // No listing that answers, another company's posting, another website's board: gone, looked for again.
  for (const [b, c] of [
    [gone, pierre],
    [joby, eniac],
    [volk, amdocs],
  ]) {
    expect(boardUrl(b!)).toBeNull();
    expect(getCompany(c!)?.discovery).toBe("queued");
  }
  expect(await repairBoards({ answers: live })).toEqual([]);
});

test("repair name: renames, and refuses a name another company has", () => {
  const id = upsertCompany({ name: "Cologne, Germany", domain: "umh-systems.dev" });
  upsertCompany({ name: "Taken", domain: "taken.dev" });
  expect(repairName(id, "UMH Systems", { dry: true })).toBe(`Cologne, Germany (${id}) → UMH Systems`);
  expect(getCompany(id)?.name).toBe("Cologne, Germany");
  repairName(id, "UMH Systems");
  expect(getCompany(id)?.name).toBe("UMH Systems");
  expect(() => repairName(id, "Taken")).toThrow("has that name already");
});

test("repair boards: a job board's posting moves to that board, never the job site's home; doubt leaves it", async () => {
  const acme = upsertCompany({ name: "Acme Robotics", domain: "acmerobotics.dev" });
  const gh = board(
    acme,
    "greenhouse",
    "https://job-boards.greenhouse.io/acmerobotics/jobs/4567",
    "greenhouse:acmerobotics",
  );
  const hp = upsertCompany({ name: "HP", domain: "hp.com" });
  const short = board(
    hp,
    "greenhouse",
    "https://job-boards.greenhouse.io/hewlett/jobs/99",
    "greenhouse:hewlett",
  );
  const slow = upsertCompany({ name: "Slowco", domain: "slowco.dev" });
  const page = board(
    slow,
    "careers-page",
    "https://slowco.dev/careers/storyteller",
    "careers-page:slowco.dev",
  );
  const said = await repairBoards({ answers: async (u) => (u.includes("slowco") ? null : true) });
  expect(boardUrl(gh)).toBe("https://job-boards.greenhouse.io/acmerobotics");
  expect(boardUrl(short)).toBe("https://job-boards.greenhouse.io/hewlett/jobs/99");
  expect(boardUrl(page)).toBe("https://slowco.dev/careers/storyteller");
  expect(said.filter((l) => l.startsWith("left:"))).toHaveLength(2);
});

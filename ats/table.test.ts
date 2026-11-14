import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dbFile, open } from "../core/db.ts";
import { tempData } from "../core/testing.ts";
import {
  bare,
  fromTable,
  type Job,
  type RunnerCompany,
  runRunner,
  setRunner,
  setTable,
  type TableRow,
  tableLookup,
} from "./reader.ts";
import { exportBoards } from "./table.ts";

const data = tempData();
afterAll(data.cleanup);

const gh = (name: string, slug: string, website = ""): TableRow => ({
  name,
  website,
  provider: "greenhouse",
  url: `https://job-boards.greenhouse.io/${slug}`,
});

test("the table is written from the boards that read, with nothing but name, website, provider and link", () => {
  const at = "2026-11-13T00:00:00Z";
  const company = (name: string, domain: string | null, from: string | null) =>
    (
      open()
        .query(
          "INSERT INTO companies (name, domain, domain_from, created_at) VALUES (?, ?, ?, ?) RETURNING id",
        )
        .get(name, domain, from, at) as { id: number }
    ).id;
  const board = (id: number, provider: string, url: string, key: string, status = "ok") =>
    open()
      .query(
        "INSERT INTO boards (company_id, provider, url, key, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, provider, url, key, status, at);
  board(
    company("Zeta, Inc.", "zeta.dev", "stated"),
    "gem",
    "https://jobs.gem.com/zeta?utm_source=x",
    "gem:jobs.gem.com/zeta",
  );
  board(company("Acme", "acme.io", "looked up"), "ashby", "https://jobs.ashbyhq.com/acme", "ashby:acme");
  board(company("Gone", "gone.dev", "stated"), "lever", "https://jobs.lever.co/gone", "lever:gone", "broken");
  board(
    company("Toka", "toka.io", "stated"),
    "comeet",
    "https://www.comeet.co/careers-api/2.0/company/1/positions?token=AB12",
    "comeet:www.comeet.co/1",
  );
  board(company("Unknown", "unknown.dev", "stated"), "ashby", "https://jobs.ashbyhq.com/unk", "ashby:unk");
  board(
    company("Seed", "seed.co", "stated"),
    "yc",
    "https://www.ycombinator.com/companies/seed/jobs",
    "yc:seed",
  );
  const page = company("Pyd", "pyd.dev", "looked up");
  board(page, "careers-page", "https://pyd.dev/jobs", "careers-page:pyd.dev");
  board(
    company("Thatch", "thatch.ai", "stated"),
    "careers-page",
    "https://thatch.com/jobs",
    "careers-page:thatch.com",
  );
  board(
    company("Bonn, Germany", "kelpie.app", "stated"),
    "personio",
    "https://kelpie.jobs.personio.de/job/2500001",
    "personio:kelpie.jobs.personio.de",
  );
  board(
    company("Ovid", "ovid.com", "stated"),
    "eightfold",
    "https://app.eightfold.ai/careers?domain=elsewhere.com",
    "eightfold:app.eightfold.ai/elsewhere.com",
  );
  // One posting under a careers page, beside a careers page's listing that stays.
  board(
    company("Murmur", "murmur.dev", "stated"),
    "careers-page",
    "https://murmur.dev/careers/3f2a9c10-7b4e-4d21-9a6f-0c5e8d1b2a47/senior-engineer",
    "careers-page:murmur.dev",
  );
  board(
    company("Quillmark", "quillmark.io", "stated"),
    "careers-page",
    "https://quillmark.io/careers/open-roles",
    "careers-page:quillmark.io",
  );
  // A link written into the name; a slug ending in a space.
  board(
    company("Brindle ( https://brindle.io )", "brindle.io", "stated"),
    "ashby",
    "https://jobs.ashbyhq.com/brindle",
    "ashby:brindle",
  );
  board(
    company("Larkspur", "larkspur.co", "stated"),
    "lever",
    "https://jobs.lever.co/Larkspur%20",
    "lever:larkspur%20",
  );
  const file = path.join(data.dir, "boards.csv");
  const r = exportBoards(dbFile(), file);
  // Sorted by name; tracking dropped; a looked-up website kept only for a careers page on it.
  expect(readFileSync(file, "utf8")).toBe(
    [
      "name,website,provider,url",
      "Acme,,ashby,https://jobs.ashbyhq.com/acme",
      "Pyd,pyd.dev,careers-page,https://pyd.dev/jobs",
      "Quillmark,quillmark.io,careers-page,https://quillmark.io/careers/open-roles",
      '"Zeta, Inc.",zeta.dev,gem,https://jobs.gem.com/zeta',
      "",
    ].join("\n"),
  );
  expect(r.left).toEqual({
    "a link with a key or token in it": 1,
    "no company name": 1,
    "Y Combinator's page for the company, not its own board": 1,
    "careers page off its company's website": 1,
    "a link to one posting, not a board": 2,
    "its board states another website": 1,
    "a name with a link or a stray character in it": 1,
    "a link with a stray space or character in it": 1,
  });
});

const role = (board: string, n: number, title: string, description = ""): Job => ({
  id: `${board}-${n}`,
  title,
  url: `https://job-boards.greenhouse.io/${board}/jobs/${n}`,
  location: "Remote",
  postedAt: null,
  description,
});

test("a company's board from the table: found by name, slug or site, kept only when one read says it's theirs", async () => {
  const ashby = (name: string, slug: string): TableRow => ({
    name,
    website: "",
    provider: "ashby",
    url: `https://jobs.ashbyhq.com/${slug}`,
  });
  setTable([
    gh("Ferrow", "ferrow56"),
    gh("Ferrow (Private)", "ferrow30"),
    gh("Ferrow Mills", "ferrow"),
    ashby("Brakken", "brakkenalliance"),
    gh("Brakken Group", "brakken"),
    gh("Q", "q9", "q.company"),
    ashby("Corvexa", "corvexa"),
    ashby("corvexa.ai", "corvexa-ai"),
  ]);
  const find = tableLookup();
  const keys = (name: string, domain: string) => find(name, domain).map((b) => `${b.provider}:${b.slug}`);
  // Trailing digits dropped, a parenthesis dropped; its site's first, then its name's.
  expect(keys("Ferrow", "ferrow.com")).toEqual([
    "greenhouse:ferrow56",
    "greenhouse:ferrow30",
    "greenhouse:ferrow",
  ]);
  expect(bare("Tallow Freight Services (TFS)")).toBe("tallowfreightservices");
  expect(keys("Brakken", "brakkengroup.io")).toEqual(["ashby:brakkenalliance", "greenhouse:brakken"]);
  // q9 by its listed site.
  expect(keys("Q, The Daylight Works", "q.company")).toEqual(["greenhouse:q9"]);
  expect(keys("corvexa.ai", "corvexa.ai")).toEqual(["ashby:corvexa-ai", "ashby:corvexa"]);
  expect(keys("Tessera Labs", "tessera.dev")).toEqual([]);

  // The roles each company was seen with (its signals' titles).
  const seen: Record<string, string> = {
    "ferrow.com": "Software Engineer, Channels and Experiences",
    "brakkengroup.io": "Entry Level -Software Developer - Web Development",
    "corvexa.ai": "Software Engineer II",
  };
  const boards: Record<string, Job[]> = {
    "greenhouse:ferrow56": [role("ferrow56", 1, "Software Engineer, Channels and Experiences")],
    "greenhouse:ferrow30": [
      role("ferrow30", 1, "Analyst", "Ferrow, ferrow.com, is hiring"),
      role("ferrow30", 2, "Ops"),
    ],
    "greenhouse:ferrow": [role("ferrow", 1, "Veterinary Technician")],
    "ashby:brakkenalliance": [role("brakkenalliance", 1, "Account Executive", "brakkenalliance.com")],
    "greenhouse:brakken": [],
    "ashby:corvexa": [role("corvexa", 1, "Designer", "see corvexa.ai")],
    "ashby:corvexa-ai": [1, 2, 3].map((n) => role("corvexa-ai", n, `Role ${n}`, "corvexa.ai builds")),
  };
  const asked: RunnerCompany[] = [];
  setRunner(async (_mode, cs) => {
    asked.push(...cs);
    return cs.map((c) => ({ domain: c.domain, ok: true, jobs: boards[c.domain] ?? [], boardCount: 9 }));
  });
  try {
    const got = await fromTable(
      ["ferrow.com", "brakkengroup.io", "corvexa.ai"].map((domain) => ({
        key: domain,
        domain,
        name: { "ferrow.com": "Ferrow", "brakkengroup.io": "Brakken", "corvexa.ai": "corvexa.ai" }[domain]!,
        seen: [{ title: seen[domain]! }],
      })),
    );
    // One read per board.
    expect(asked.map((c) => c.domain).sort()).toEqual(Object.keys(boards).sort());
    expect(asked.find((c) => c.domain === "greenhouse:ferrow56")?.ats).toEqual({
      provider: "greenhouse",
      careers_url: "https://job-boards.greenhouse.io/ferrow56",
    });
    // Ferrow: ferrow30 names ferrow.com, but ferrow56 lists the alert's role.
    expect(got.get("ferrow.com")?.board.slug).toBe("ferrow56");
    expect(got.get("ferrow.com")?.jobs).toHaveLength(1);
    // Brakken: one board is empty, the other neither lists the role nor names brakkengroup.io.
    expect(got.has("brakkengroup.io")).toBe(false);
    // corvexa.ai: both name the domain, neither lists the role: the one with more roles.
    expect(got.get("corvexa.ai")?.board.slug).toBe("corvexa-ai");
  } finally {
    setRunner(runRunner);
  }
});

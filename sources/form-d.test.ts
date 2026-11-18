import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runRunner, setRunner } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { append } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { companyByDomain, fundingOf, watchCompany } from "../intake/companies.ts";
import { intakeLead } from "../intake/leads.ts";
import { setProviders } from "../providers/registry.ts";
import { readSourceState } from "../signals/state.ts";
import formD, { setGetter } from "./form-d/index.ts";

const data = tempData();
afterAll(() => {
  setGetter(null);
  setProviders(null);
  setRunner(runRunner);
  data.cleanup();
});
const fx = (f: string) => readFileSync(path.join(import.meta.dir, "..", "fixtures", "form-d", f), "utf8");
const ok = (url: string, text: string) => ({ status: 200, url, text, notModified: false });
const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });

writeFileSync(paths.config(), '[source.form-d]\nuser_agent = "Job Signal test@example.com"\n');
// No providers: an issuer's domain comes only from a name the app knows.
setProviders([]);

test("Form D by state: local issuers that raised become signals; a name you don't know goes as a name, for discovery to find its site", async () => {
  writeFileSync(paths.me("profile.json"), JSON.stringify({ filters: { locations: ["Denver", "CO"] } }));
  // Names the app knows (its threads): the only way an issuer's name gives a domain.
  append("brindlelearning.com", {
    actor: "board",
    kind: "signal",
    data: { company: "Brindle Learning, Inc." },
  });
  append("ridgeline.dev", { actor: "board", kind: "signal", data: { company: "Ridgeline Robotics Inc" } });
  index.rebuild();
  const asked: string[] = [];
  setGetter(async (url) => {
    asked.push(url);
    const doc = url.match(/data\/(\d+)\/\d+\/primary_doc\.xml$/)?.[1];
    if (url.endsWith("form.20261020.idx")) return ok(url, fx("form.20261020.idx"));
    if (doc) return ok(url, fx(`primary_doc-${doc}.xml`));
    if (url === "https://brindlelearning.com/")
      return ok(url, "<footer>Brindle Learning · Denver, Colorado</footer>");
    throw notFound();
  });
  let detected = 0;
  setRunner(async () => {
    detected++;
    return [];
  });
  const now = new Date("2026-10-21T08:00:00Z");
  const leads = await formD.fetch(null, now);
  expect(leads.map((l) => [l.domain, l.kind, l.source, l.source_tag, l.title, l.text])).toEqual([
    [
      "brindlelearning.com",
      "company",
      "form-d",
      "funding",
      undefined,
      "Raised $52M · Form D filed 2026-10-20 · Denver, CO",
    ],
    [
      "ridgeline.dev",
      "company",
      "form-d",
      "funding",
      undefined,
      "Raised $4.2M · Form D filed 2026-10-20 · Boulder, CO",
    ],
    [
      undefined,
      "company",
      "form-d",
      "funding",
      undefined,
      "Raised $2.5M · Form D filed 2026-10-20 · Golden, CO",
    ],
  ]);
  expect(leads[2]?.company_hint).toBe("Mesa Unknown Systems, Inc.");
  // The fund was skipped by name, the amendment never read.
  expect(asked.some((u) => u.includes("/1900303/"))).toBe(false);
  expect(asked.some((u) => u.includes("000190020226000009"))).toBe(false);
  const state = readSourceState<{ done: string[]; issuers: Record<string, { domain: string | null }> }>(
    "form-d",
    { done: [], issuers: {} },
  );
  expect(state.done).toContain("20261020");
  expect(Object.keys(state.issuers).sort()).toEqual(["1900101", "1900202", "1900707"]);
  expect(state.issuers["1900707"]?.domain).toBeNull(); // Mesa: no match, no guess here
  // Fetching looks for no board: the signals queue their companies for discovery.
  expect(detected).toBe(0);

  for (const l of leads) intakeLead(l, now);
  expect(
    open()
      .query("SELECT DISTINCT c.domain FROM signals s JOIN companies c ON c.id = s.company_id ORDER BY 1")
      .all(),
  ).toEqual([{ domain: null }, { domain: "brindlelearning.com" }, { domain: "ridgeline.dev" }]);
  // Mesa: a company by name only, queued for discovery, the filing on it.
  const mesa = open()
    .query("SELECT id, discovery, funding FROM companies WHERE name = ?")
    .get("Mesa Unknown Systems, Inc.") as {
    discovery: string;
    funding: string;
  };
  expect(mesa.discovery).toBe("queued");
  expect(JSON.parse(mesa.funding)).toMatchObject({ form: "D", date: "2026-10-20", cik: "1900707" });
  // The filing is a fact on the company the signal made.
  const brindle = companyByDomain("brindlelearning.com")!;
  expect(brindle.discovery).toBe("queued");
  expect(fundingOf(brindle)).toMatchObject({ form: "D", date: "2026-10-20", cik: "1900101" });

  // The next night: the day is done, nothing is read again, nothing shown twice.
  asked.length = 0;
  expect(await formD.fetch(null, new Date("2026-10-21T20:00:00Z"))).toEqual([]);
  expect(asked.filter((u) => u.includes("primary_doc"))).toEqual([]);
  // Watch: the filing stays with the company.
  watchCompany(brindle.id, "inbox");
  expect(fundingOf(companyByDomain("brindlelearning.com")!)).toMatchObject({ date: "2026-10-20" });
  expect(readFileSync(path.join(data.dir, "sources", "form-d.json"), "utf8")).not.toContain("Founder");
});

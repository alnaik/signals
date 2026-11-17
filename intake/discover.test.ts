import { afterAll, beforeEach, expect, test } from "bun:test";
import { type RunnerCompany, runRunner, setPageReader, setRunner, setTable } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { tempData } from "../core/testing.ts";
import { failures } from "../core/trace.ts";
import { setProviders } from "../providers/registry.ts";
import {
  companyByDomain,
  companyByName,
  dismissCompany,
  getCompany,
  recordSignal,
  upsertCompany,
  watchCompany,
} from "./companies.ts";
import { addBoard, discover, discoveryDue } from "./discover.ts";
import { boardStates } from "./domain.ts";
import { siteDomain } from "./leads.ts";
import { searchDue } from "./search.ts";

const data = tempData();
setProviders([]); // no brand directory: a name resolves only by the rules
afterAll(() => {
  setRunner(runRunner);
  setProviders(null);
  data.cleanup();
});
beforeEach(() => {
  open().exec(
    "DELETE FROM role_text; DELETE FROM roles; DELETE FROM boards; DELETE FROM signals; DELETE FROM company_names; DELETE FROM companies;",
  );
  setTable([]);
});

const now = new Date("2026-10-28T03:00:00Z");
const count = (t: string) => (open().query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

test("one company by name: a signal with only a name, then one with its domain, are one company", () => {
  const a = recordSignal(
    {
      url: "https://linkedin.com/jobs/view/1",
      company_hint: "Tessera Labs",
      source: "linkedin",
      source_tag: "LinkedIn alert",
    },
    now,
  ).companyId!;
  expect(getCompany(a)?.domain).toBeNull();
  const b = recordSignal(
    {
      url: "https://tessera.dev/blog",
      company_hint: "Tessera Labs, Inc.",
      domain: "tessera.dev",
      source: "drop",
      source_tag: "drop",
    },
    now,
  ).companyId!;
  expect(b).toBe(a);
  expect(getCompany(a)?.domain).toBe("tessera.dev");
  // A row made by domain first, and a name-only row made before it, merge when the name meets the domain.
  const named = upsertCompany({ name: "Quarry" });
  const byDomain = upsertCompany({ name: "quarry.so", domain: "quarry.so" });
  expect(named).not.toBe(byDomain);
  expect(upsertCompany({ name: "Quarry", domain: "quarry.so" })).toBe(byDomain);
  expect(getCompany(named)).toBeNull();
  expect(companyByName("Quarry")?.id).toBe(byDomain);
  expect(count("companies")).toBe(2);
});

test("a lead whose website was only looked up (a fund's, a GitHub organisation's) never joins a name's row to that website's", () => {
  const named = upsertCompany({ name: "Tessellate" });
  const site = upsertCompany({ name: "tessellate.io", domain: "tessellate.io" });
  expect(upsertCompany({ name: "Tessellate", domain: "tessellate.io", from: "looked up" })).toBe(site);
  expect(getCompany(named)).toMatchObject({ name: "Tessellate", domain: null });
  expect(count("companies")).toBe(2);
  // The same lead with the website stated joins them.
  expect(upsertCompany({ name: "Tessellate", domain: "tessellate.io" })).toBe(site);
  expect(getCompany(named)).toBeNull();
});

test("a merge keeps your Dismiss on the row that goes, unless the company is watched", () => {
  const named = upsertCompany({ name: "Quarry" });
  dismissCompany(named, now);
  const byDomain = upsertCompany({ name: "quarry.so", domain: "quarry.so" });
  expect(upsertCompany({ name: "Quarry", domain: "quarry.so" })).toBe(byDomain);
  expect(getCompany(byDomain)?.dismissed_at).toBe(now.toISOString());
  // Watched: the Dismiss on the row that goes doesn't hide it.
  const other = upsertCompany({ name: "Slate" });
  dismissCompany(other, now);
  const watched = upsertCompany({ name: "slate.dev", domain: "slate.dev" });
  watchCompany(watched, "manual", now);
  expect(upsertCompany({ name: "Slate", domain: "slate.dev" })).toBe(watched);
  expect(getCompany(watched)).toMatchObject({ dismissed_at: null, watched_at: now.toISOString() });
});

test("a looked-up domain gives way to a stated one: the same name is one company, by its stated domain and its real name", () => {
  // Tallowly → tallowly.dev from a name lookup; its HN post states tallowly.com.
  const guessed = upsertCompany({ name: "Tallowly", domain: "tallowly.dev", from: "looked up" });
  const stated = upsertCompany({ name: "tallowly.com", domain: "tallowly.com" });
  expect(upsertCompany({ name: "Tallowly", domain: "tallowly.com" })).toBe(stated);
  expect(getCompany(guessed)).toBeNull();
  expect(getCompany(stated)).toMatchObject({
    name: "Tallowly",
    domain: "tallowly.com",
    domain_from: "stated",
  });
  expect(companyByDomain("tallowly.dev")).toBeNull(); // the guess never finds it again
  // No row has the stated domain yet: the looked-up one takes it.
  const lu = upsertCompany({ name: "Quillmark", domain: "quillmarknetwork.org", from: "looked up" });
  expect(upsertCompany({ name: "Quillmark", domain: "onequillmark.com" })).toBe(lu);
  expect(getCompany(lu)).toMatchObject({ domain: "onequillmark.com", domain_from: "stated" });
  // A stated domain is never replaced by another: two companies by one name stay two.
  const other = upsertCompany({ name: "Quillmark", domain: "quillmark.example" });
  expect(other).not.toBe(lu);
  expect(getCompany(lu)?.domain).toBe("onequillmark.com");
  // A signal stating the looked-up domain itself confirms it.
  const lf = upsertCompany({ name: "Larkspur Freight", domain: "larkspurfreight.com", from: "looked up" });
  expect(upsertCompany({ name: "Larkspur Freight", domain: "larkspurfreight.com" })).toBe(lf);
  expect(getCompany(lf)?.domain_from).toBe("stated");
});

test("a company's domain is never a job board's, nor a page on a post or link host; the host itself only its own", () => {
  for (const s of [
    "foo.substack.com",
    "https://medium.com/@x",
    "https://github.com/acme",
    "https://pyxtanlabs.notion.site/Jobs",
    "lake-lab.github.io",
    "https://substack.com/jobs",
    "jobs.ashbyhq.com/acme",
    "https://www.ycombinator.com/companies/acme/jobs",
    "linkedin.com",
  ])
    expect(siteDomain(s)).toBeNull();
  expect(siteDomain("substack.com")).toBe("substack.com");
  expect(siteDomain("https://careers.acme.co.uk/jobs")).toBe("acme.co.uk");
});

test("a domain only with proof: the posts' own domain whose homepage names the company, or a board its post links that names it", async () => {
  const pages: Record<string, string> = {
    "https://velloravc.com/": "<title>Vellora Ventures</title>",
    "https://circuitgazette.example/": "<title>CIRCUIT GAZETTE</title>",
    "https://ondrel.ai/": '<meta property="og:site_name" content="Ondrel AI"><title>Home</title>',
    "https://jobs.ashbyhq.com/marrowind?embed=js":
      '<script>{"organization":{"organizationId":"x","name":"Marrowind","publicWebsite":"https://marrowind.xyz/","hostedJobsPageSlug":"marrowind"}}</script>',
  };
  setPageReader(async (url) => {
    if (!(url in pages)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
    return { text: pages[url]!, url } as { text: string };
  });
  const post = (name: string, text: string) =>
    recordSignal(
      { url: `https://x.com/a/status/${name}`, company_hint: name, text, source: "x", source_tag: "X" },
      now,
    ).companyId!;
  const vellora = post("Vellora", "We're hiring. Say hello at mira [at] velloravc [.] com!");
  const ondrel = post(
    "Ondrel AI",
    "As seen in https://circuitgazette.example/story/ai-agents — try https://ondrel.ai",
  );
  const pyxtan = post("Pyxtan", "Open roles: https://pyxtanlabs.notion.site/Jobs-at-Pyxtan-1a2b");
  const marrowind = post("Marrowind", "Hiring: https://jobs.ashbyhq.com/marrowind/1234");
  const glimmerfold = post("Glimmerfold", "Hiring: https://jobs.ashbyhq.com/marrowind/5678");
  setRunner(async (_mode, cs) => cs.map((c) => ({ domain: c.domain, ok: true, detect: { provider: null } })));
  await discover(
    [vellora, ondrel, pyxtan, marrowind, glimmerfold].map((id) => getCompany(id)!),
    now,
  );
  expect(getCompany(vellora)).toMatchObject({ domain: "velloravc.com", domain_from: "homepage" });
  expect(getCompany(ondrel)).toMatchObject({ domain: "ondrel.ai", domain_from: "homepage" });
  expect(getCompany(pyxtan)?.domain).toBeNull(); // a Notion page is someone's page on Notion
  expect(getCompany(marrowind)).toMatchObject({ domain: "marrowind.xyz", domain_from: "board" });
  expect(getCompany(glimmerfold)?.domain).toBeNull(); // the board names Marrowind, not Glimmerfold
});

test("an Ashby board with its hosted pages off states the company's own careers page", async () => {
  setPageReader(async (url) => {
    // The embed view as Ashby sends it: the organization's fields, then its theme.
    if (url === "https://jobs.ashbyhq.com/offco?embed=js")
      return {
        text: '<script>window.__appData = {"organization":{"organizationId":"x","name":"Off \\"Co\\"","publicWebsite":"https://www.offco.dev","customJobsPageUrl":"https://offco.dev/careers","theme":{"jobPostingBackUrl":"https://elsewhere.dev"}},"jobBoard":{}};</script>',
        url,
      } as { text: string };
    // A board that's gone: no organization.
    return { text: '<script>{"organization":null,"jobBoard":null}</script>', url } as { text: string };
  });
  expect(await boardStates("https://jobs.ashbyhq.com/offco/1234")).toEqual({
    name: 'Off "Co"',
    site: "offco.dev",
    page: "https://offco.dev/careers",
  });
  expect(await boardStates("https://jobs.ashbyhq.com/goneco")).toBeNull();
});

test("two companies become one only on a proven domain: a looked-up holder keeps it, a shared board stays its owner's", async () => {
  setPageReader(async (url) => ({ text: "<title>Held</title>", url }) as { text: string });
  setRunner(async (_mode, cs) => cs.map((c) => ({ domain: c.domain, ok: true, detect: { provider: null } })));
  const guessed = upsertCompany({ name: "Holdco", domain: "held.dev", from: "looked up" });
  const held = recordSignal(
    {
      url: "https://x.com/a/status/1",
      company_hint: "Held",
      text: "jobs@held.dev",
      source: "x",
      source_tag: "X",
    },
    now,
  ).companyId!;
  await discover([getCompany(held)!], now);
  expect(getCompany(held)?.domain).toBeNull();
  expect(getCompany(guessed)?.domain).toBe("held.dev");
  // One board, two companies: the second doesn't join the first; it's told whose board it is.
  const quillmark = upsertCompany({ name: "Quillmark", domain: "quillmark.com" });
  addBoard(quillmark, "gem", "https://jobs.gem.com/quillmark", "careers page", now);
  const launchpad = upsertCompany({ name: "Halvard launchpad" });
  const kept = addBoard(launchpad, "gem", "https://jobs.gem.com/quillmark", "web search", now);
  expect(kept.companyId).toBe(launchpad);
  expect(getCompany(launchpad)).toMatchObject({ discovery: "none" });
  expect(getCompany(launchpad)?.discovery_note).toContain("is Quillmark's board");
  expect(count("companies")).toBe(4);
});

test("one company by board: two names whose boards are one board merge, and the domain that goes still finds it", () => {
  const bcs = upsertCompany({ name: "Brindle Cloud Services (BCS)", domain: "cloud.brindle.com" });
  watchCompany(bcs, "manual", now);
  addBoard(bcs, "greenhouse", "https://job-boards.greenhouse.io/brindle", "test", now);
  recordSignal(
    {
      url: "https://linkedin.com/jobs/view/2",
      company_hint: "Brindle",
      domain: "brindle.com",
      source: "linkedin",
      source_tag: "LinkedIn alert",
    },
    now,
  );
  const brindle = companyByDomain("brindle.com")!.id;
  expect(brindle).not.toBe(bcs);
  const kept = addBoard(
    brindle,
    "greenhouse",
    "https://boards.greenhouse.io/brindle/jobs/123",
    "test",
    now,
  ).companyId;
  // The watched one is kept; the other's signal, names and domain move to it.
  expect(kept).toBe(bcs);
  expect(getCompany(brindle)).toBeNull();
  expect(count("boards")).toBe(1);
  expect(open().query("SELECT company_id FROM signals").all()).toEqual([{ company_id: bcs }]);
  expect(companyByDomain("brindle.com")?.id).toBe(bcs);
  expect(companyByName("Brindle")?.id).toBe(bcs);
  // The next signal from brindle.com lands on the same company, so a second import changes nothing.
  expect(upsertCompany({ name: "Brindle", domain: "brindle.com" })).toBe(bcs);
  // The merge is traced: kept, dropped, why, and whether the one dropped was dismissed.
  expect(
    failures(now).filter((f) => f.area === "merge" && f.context?.keep === bcs && f.context?.drop === brindle),
  ).toEqual([
    expect.objectContaining({
      error: expect.stringContaining("one board, https://boards.greenhouse.io/brindle, on one site"),
      context: { keep: bcs, drop: brindle, dropDismissed: false },
    }),
  ]);
});

test("a Lever board the company has left isn't found again while that's known; a week on it is taken back", () => {
  const id = upsertCompany({ name: "Xylo", domain: "xylo.dev" });
  const b = addBoard(id, "lever", "https://jobs.lever.co/xylo", "test", now).board!;
  open()
    .query("UPDATE boards SET status = 'broken', fails = 3, own_page = 'gone', own_page_at = ? WHERE id = ?")
    .run(now.toISOString(), b.id);
  open().query("UPDATE companies SET discovery = 'queued' WHERE id = ?").run(id);
  const again = addBoard(id, "lever", "https://jobs.lever.co/xylo", "boards table", now);
  expect(again.refused).toContain("is gone");
  expect(open().query("SELECT status FROM boards").get()).toEqual({ status: "broken" });
  expect(getCompany(id)?.discovery).toBe("none");
  const later = new Date(now.getTime() + 8 * 86_400_000);
  expect(addBoard(id, "lever", "https://jobs.lever.co/xylo", "boards table", later).board?.status).toBe("ok");
});

test("discovery tries the boards table first, with one confirming read, which is the board's first read", async () => {
  setTable([
    { name: "", website: "", provider: "greenhouse", url: "https://job-boards.greenhouse.io/fernwork" },
  ]);
  const fernwork = recordSignal(
    {
      url: "https://linkedin.com/jobs/view/3",
      company_hint: "Fernwork",
      domain: "fernwork.com",
      title: "Engineer",
      source: "linkedin",
      source_tag: "LinkedIn alert",
    },
    now,
  ).companyId!;
  // A pasted posting (Add) is where to start: detection, not the table.
  const posted = upsertCompany({ name: "Posted", domain: "posted.dev" });
  const modes: string[] = [];
  const asked: RunnerCompany[] = [];
  setRunner(async (mode, cs) => {
    modes.push(mode);
    asked.push(...cs);
    return cs.map((c) =>
      mode === "scan"
        ? {
            domain: c.domain,
            ok: true,
            jobs: [
              {
                id: "1",
                title: "Engineer",
                url: "https://job-boards.greenhouse.io/fernwork/jobs/1",
                location: "",
                postedAt: null,
              },
            ],
          }
        : {
            domain: c.domain,
            ok: true,
            detect: { provider: "lever", careers_url: "https://jobs.lever.co/posted", method: "lead" },
          },
    );
  });
  await discover([getCompany(fernwork)!], now);
  await discover([getCompany(posted)!], now, "https://jobs.lever.co/posted/1");
  expect(modes).toEqual(["scan", "detect"]);
  expect(asked.map((c) => c.domain)).toEqual(["greenhouse:fernwork", String(posted)]);
  expect(asked[1]).toMatchObject({ site: "posted.dev", hint: "https://jobs.lever.co/posted/1" });
  const boards = open()
    .query("SELECT company_id, provider, url, found_by, role_count FROM boards ORDER BY id")
    .all();
  expect(boards).toEqual([
    {
      company_id: fernwork,
      provider: "greenhouse",
      url: "https://job-boards.greenhouse.io/fernwork",
      found_by: "boards table",
      role_count: 1,
    },
    {
      company_id: posted,
      provider: "lever",
      url: "https://jobs.lever.co/posted",
      found_by: "lead",
      role_count: null,
    },
  ]);
  expect(getCompany(fernwork)?.discovery).toBe("found");
  // Another company the table gives the same board: refused, so the board isn't read for it, nor
  // reported found; its note says whose board it is.
  const namesake = recordSignal(
    {
      url: "https://linkedin.com/jobs/view/4",
      company_hint: "Fernwork",
      domain: "fernwork-fans.org",
      title: "Engineer",
      source: "linkedin",
      source_tag: "LinkedIn alert",
    },
    now,
  ).companyId!;
  expect(namesake).not.toBe(fernwork);
  setRunner(async (_mode, cs) =>
    cs.map((c) => ({
      domain: c.domain,
      ok: true,
      jobs: [
        {
          id: "2",
          title: "Engineer",
          url: "https://job-boards.greenhouse.io/fernwork/jobs/2",
          location: "",
          postedAt: null,
        },
      ],
    })),
  );
  expect(await discover([getCompany(namesake)!], now)).toEqual([
    {
      companyId: namesake,
      how: "boards table: https://job-boards.greenhouse.io/fernwork is Fernwork's board",
    },
  ]);
  expect(open().query("SELECT company_id, ext_id FROM roles").all()).toEqual([
    { company_id: fernwork, ext_id: "1" },
  ]);
  expect(getCompany(namesake)).toMatchObject({
    discovery: "none",
    discovery_note: expect.stringContaining("is Fernwork's board"),
  });
});

test("the table's careers page for a company's website is read as one its site gave, once: one that has gone costs a try", async () => {
  setTable([
    { name: "Pyd", website: "pyd.dev", provider: "careers-page", url: "https://pyd.dev/jobs" },
    { name: "Gone", website: "gone.dev", provider: "careers-page", url: "https://gone.dev/careers" },
  ]);
  const pyd = upsertCompany({ name: "Pyd", domain: "pyd.dev" });
  const gone = upsertCompany({ name: "Gone", domain: "gone.dev" });
  const asked: RunnerCompany[] = [];
  setRunner(async (_mode, cs) => {
    asked.push(...cs);
    return cs.map((c) => ({
      domain: c.domain,
      ok: true,
      // Neither site gives a board; the table's pages: Pyd's lists its roles, Gone's is gone.
      detect: !c.pages
        ? { provider: null, problem: "pages fetched, no board found" }
        : c.domain === `${pyd} table`
          ? { provider: null, careers_read: "https://pyd.dev/jobs" }
          : { provider: null, tried: [], reasons: ["https://gone.dev/careers: HTTP 404"] },
    }));
  });
  await discover([getCompany(pyd)!, getCompany(gone)!], now);
  expect(asked.filter((c) => c.pages).map((c) => [c.domain, c.pages])).toEqual([
    [`${pyd} table`, ["https://pyd.dev/jobs"]],
    [`${gone} table`, ["https://gone.dev/careers"]],
  ]);
  expect(open().query("SELECT company_id, provider, url, found_by FROM boards").all()).toEqual([
    { company_id: pyd, provider: "careers-page", url: "https://pyd.dev/jobs", found_by: "boards table" },
  ]);
  // Gone goes on to the web search, its careers page not kept; at its next look the table isn't asked.
  expect(getCompany(gone)).toMatchObject({ discovery: "none", careers_url: null });
  asked.length = 0;
  await discover([getCompany(gone)!], new Date(now.getTime() + 31 * 86_400_000));
  expect(asked.some((c) => c.pages)).toBe(false);
});

test("a company never looked up stays due however old its last signal; a failed lookup is retried only while active", () => {
  const DAY = 86_400_000;
  const old = new Date(now.getTime() - 90 * DAY).toISOString();
  const longAgo = new Date(now.getTime() - 40 * DAY).toISOString();
  const make = (name: string, set: string) => {
    const id = upsertCompany({ name, domain: `${name.toLowerCase()}.dev` });
    open().query(`UPDATE companies SET last_signal_at = ?, ${set} WHERE id = ?`).run(old, id);
    return id;
  };
  make("Queued", "discovery = 'queued'");
  make("Missed", `discovery = 'none', discovery_at = '${longAgo}'`);
  make("Gone", `discovery = 'queued', dismissed_at = '${old}'`);
  expect(discoveryDue(now).map((c) => c.name)).toEqual(["Queued"]);
  // Watched: a failed lookup is retried whatever its age.
  watchCompany(companyByName("Missed")!.id, "test", now);
  expect(
    discoveryDue(now)
      .map((c) => c.name)
      .sort(),
  ).toEqual(["Missed", "Queued"]);
  // The web search: never searched is due however old; searched 40 days ago, only while active.
  make("Unsearched", `discovery = 'none', discovery_at = '${longAgo}'`);
  make("Searched", `discovery = 'none', discovery_at = '${longAgo}', search_at = '${longAgo}'`);
  make("Hidden", `discovery = 'none', discovery_at = '${longAgo}', dismissed_at = '${old}'`);
  expect(
    searchDue(now, 10)
      .map((c) => c.name)
      .sort(),
  ).toEqual(["Missed", "Unsearched"]);
});

test("a board its site links that names another company is refused; Add takes it as given", async () => {
  setPageReader(async (url) => {
    if (url === "https://boards-api.greenhouse.io/v1/boards/tamselinc")
      return { text: '{"name":"Tamsel"}', url } as { text: string };
    throw Object.assign(new Error("HTTP 404"), { status: 404 });
  });
  const firm = upsertCompany({ name: "Halvard", domain: "halvard.vc", from: "post" });
  const added = upsertCompany({ name: "Added", domain: "added.dev", from: "post" });
  setRunner(async (_mode, cs) =>
    cs.map((c) => ({
      domain: c.domain,
      ok: true,
      detect: {
        provider: "greenhouse",
        careers_url: "https://job-boards.greenhouse.io/tamselinc",
        method: "careers page",
      },
    })),
  );
  await discover([getCompany(firm)!], now);
  expect(getCompany(firm)).toMatchObject({ discovery: "none" });
  expect(getCompany(firm)?.discovery_note).toContain("Tamsel's board");
  await discover([getCompany(added)!], now, "https://job-boards.greenhouse.io/tamselinc/jobs/1");
  expect(open().query("SELECT company_id FROM boards").all()).toEqual([{ company_id: added }]);
});

import { afterAll, expect, test } from "bun:test";
import { derive } from "../core/derive.ts";
import { append, read } from "../core/log.ts";
import { tempData } from "../core/testing.ts";
import { recordSignal, upsertCompany } from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { applyRead } from "../intake/refresh.ts";
import { gather } from "./gather.ts";

const data = tempData();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  data.cleanup();
});
const NOW = new Date("2026-10-27T12:00:00Z");
const ROLE = "https://jobs.ashbyhq.com/tessera/1";

test("gather: posting, GitHub issues and their triager, the certificate log, then the person", async () => {
  const id = "tessera.dev";
  append(id, {
    actor: "ats",
    kind: "signal",
    data: { company: "Tessera", kind: "posting", title: "Backend Engineer", source_tag: "ATS change" },
    source: { type: "page", url: ROLE },
  });
  append(id, { actor: "board", kind: "decision", data: { action: "apply", url: ROLE } });
  // The board as its reads kept it: the role, with the text kept because it fits.
  const board = addBoard(
    upsertCompany({ name: "Tessera", domain: id }),
    "ashby",
    "https://jobs.ashbyhq.com/tessera",
    "test",
  ).board!;
  applyRead(
    board,
    {
      ok: true,
      jobs: [
        {
          id: "1",
          url: ROLE,
          title: "Backend Engineer",
          location: "Remote",
          postedAt: null,
          description:
            "We sync calendars for clinics. You will own the sync engine end to end. Join Maya's team and ship weekly.",
        },
      ],
    },
    new Date("2026-10-26T00:00:00Z"),
  );
  // The HN post that named it: a fact as HN delivered it, never fetched again.
  recordSignal({
    url: "https://news.ycombinator.com/item?id=41",
    company_hint: "Tessera",
    domain: id,
    text: "Tessera | Backend Engineer | Remote | We sync calendars for clinics and need help with recurring events.",
    source: "hn",
    source_tag: "HN",
  });
  const issue = {
    html_url: "https://github.com/tessera/sync/issues/7",
    title: "Recurring events drift by an hour after DST",
    comments: 9,
    reactions: { total_count: 41 },
    user: { login: "reporter" },
    comments_url: "https://api.github.com/repos/tessera/sync/issues/7/comments",
  };
  const searched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (b: unknown) => Response.json(b);
    if (url.includes("hn.algolia.com") || url.includes("/search/issues"))
      searched.push(new URL(url).searchParams.get("query") ?? new URL(url).searchParams.get("q") ?? "");
    if (url.includes("hn.algolia.com")) return new Response("down", { status: 503 }); // HN fails alone
    if (url.endsWith("/orgs/tessera")) return json({ login: "tessera", blog: "https://tessera.dev" });
    if (url.includes("/search/issues")) return json({ items: [issue] });
    if (url.includes("/issues/7/comments"))
      return json([
        { user: { login: "rhea" } },
        { user: { login: "rhea" } },
        { user: { login: "reporter" } },
      ]);
    if (url.includes("/issues/7")) return json({ ...issue, state: "open", assignees: [] });
    if (url.includes("crt.sh"))
      return json([
        { name_value: "beta.tessera.dev", not_before: "2026-10-01T00:00:00" },
        { name_value: "old.tessera.dev", not_before: "2025-01-01T00:00:00" },
      ]);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const lines: string[] = [];
  const g = await gather(id, (l) => lines.push(l), NOW);
  expect(lines).toContain("reading github.com/tessera");
  // HN is searched by the domain, so a namesake company's threads stay out.
  expect(searched).toContain("tessera.dev");
  // GitHub's issue search answers 422 to a query with neither is:issue nor is:pr.
  expect(searched).toContain('"tessera.dev" is:issue is:open');
  expect(g.skipped.filter((s) => s.startsWith("searching"))).toEqual([
    expect.stringMatching(/^searching HN: /),
  ]);
  expect(g.person).toBe("Maya");
  const d = derive(read(id));
  const texts = d.facts.map((f) => f.text);
  expect(texts).toContain("Posting: Backend Engineer");
  expect(d.facts.find((f) => f.text === "Tessera, named in a post (HN)")?.source).toMatchObject({
    type: "provider_record",
    url: "https://news.ycombinator.com/item?id=41",
  });
  expect(texts).toContain(
    "Open issue, 41 reactions, no one assigned: Recurring events drift by an hour after DST",
  );
  expect(texts).toContain("rhea replies most on these issues (2 comments)");
  expect(texts).toContain("New subdomains in the last 90 days: beta.tessera.dev (2026-10-01)");
  expect(d.facts.find((f) => f.text.startsWith("The posting says"))?.source?.quote).toContain(
    "Join Maya's team",
  );
  expect(d.facts.every((f) => f.source?.quote && f.source.url)).toBe(true);
  expect(d.contact).toEqual({ name: "Maya", role: "hiring manager" });
  expect(read(id).findLast((e) => e.kind === "contact")?.data.confidence).toBe("verified");

  // Run again: nothing already gathered is added twice.
  const before = d.facts.length;
  await gather(id, () => {}, NOW);
  expect(derive(read(id)).facts.length).toBe(before);
});

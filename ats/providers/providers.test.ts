// Job Signal's own readers for big companies' own job sites: each reads what its site's own page
// or search gives, by the saved-search titles (ats/search.mjs QUERIED).
import { afterAll, expect, test } from "bun:test";
import { tempData } from "../../core/testing.ts";
import { boardKey, boardUrl } from "../reader.ts";
// @ts-expect-error plain JS module
import apple, { appleResults } from "./apple.mjs";
// @ts-expect-error plain JS module
import google from "./google-careers.mjs";
// @ts-expect-error plain JS module
import microsoft from "./microsoft.mjs";

const data = tempData();
afterAll(data.cleanup);

test("Apple: the search page's own hydration data, one query a term, three pages at most", async () => {
  const result = (n: number) => ({
    id: `PIPE-2006917${n}`,
    positionId: `2006917${n}`,
    postingTitle: `Applied AI Engineer ${n}`,
    transformedPostingTitle: `applied-ai-engineer-${n}`,
    postDateInGMT: "2026-10-30T18:30:42.955Z",
    locations: [{ name: "Cupertino", countryName: "United States of America" }],
    team: { teamCode: "HRDWR" },
  });
  const page = (results: unknown[], total: number) =>
    `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(
      JSON.stringify({ loaderData: { search: { searchResults: results, totalRecords: total } } }),
    )});</script>`;
  expect(appleResults("<html></html>")).toBeNull();
  expect(apple.detect({ careers_url: "https://jobs.apple.com/app/en-us/profile/info" })).toBeTruthy();
  expect(apple.detect({ careers_url: "https://www.apple.com/careers/us/" })).toBeNull();
  const asked: string[] = [];
  const ctx = {
    fetchText: async (url: string) => {
      asked.push(url);
      const p = Number(new URL(url).searchParams.get("page"));
      return page(
        Array.from({ length: p < 2 ? 20 : 3 }, (_, i) => result(p * 100 + i)),
        23,
      );
    },
  };
  const jobs = await apple.fetch(
    { careers_url: "https://jobs.apple.com/en-us/search", apple: { queries: ["engineer"] } },
    ctx,
  );
  expect(asked).toEqual([
    "https://jobs.apple.com/en-us/search?search=engineer&sort=newest&page=1",
    "https://jobs.apple.com/en-us/search?search=engineer&sort=newest&page=2",
  ]);
  expect(jobs).toHaveLength(23);
  expect(jobs[0]).toEqual({
    title: "Applied AI Engineer 100",
    url: "https://jobs.apple.com/en-us/details/PIPE-2006917100/applied-ai-engineer-100?team=HRDWR",
    location: "Cupertino, United States of America",
    externalId: "2006917100",
    postedAt: Date.parse("2026-10-30T18:30:42.955Z"),
  });
  // A probe: one page of the first term.
  asked.length = 0;
  await apple.fetch(
    { careers_url: "https://jobs.apple.com/", apple: { queries: ["a", "b"] } },
    { ...ctx, maxPages: 1 },
  );
  expect(asked).toHaveLength(1);
});

test("Microsoft: the careers page's anonymous session, then its own search, newest first", async () => {
  expect(microsoft.detect({ careers_url: "https://careers.microsoft.com/" })).toBeTruthy();
  expect(microsoft.detect({ careers_url: "https://www.microsoft.com/en-us/" })).toBeNull();
  const sent: { url: string; cookie?: string }[] = [];
  const ctx = {
    fetchResponse: async (url: string) => {
      sent.push({ url });
      const h = new Headers();
      h.append("set-cookie", "_vs=abc; Path=/; Secure");
      h.append("set-cookie", "_vscid=def; Path=/");
      return new Response("<html></html>", { headers: h });
    },
    fetchJson: async (url: string, o: { headers: Record<string, string> }) => {
      sent.push({ url, cookie: o.headers.cookie });
      return {
        data: {
          count: 1,
          positions: [
            {
              id: 1970393556855901,
              name: "Senior Software Engineer",
              standardizedLocations: ["Redmond, WA, US"],
              postedTs: 1782338678,
              positionUrl: "/careers/job/1970393556855901",
            },
          ],
        },
      };
    },
  };
  const jobs = await microsoft.fetch(
    { careers_url: "https://careers.microsoft.com/", microsoft: { queries: ["software engineer"] } },
    ctx,
  );
  expect(sent).toEqual([
    { url: "https://apply.careers.microsoft.com/careers" },
    {
      url: "https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=software+engineer&location=&start=0&sort_by=timestamp",
      cookie: "_vs=abc; _vscid=def",
    },
  ]);
  expect(jobs).toEqual([
    {
      title: "Senior Software Engineer",
      url: "https://apply.careers.microsoft.com/careers/job/1970393556855901",
      location: "Redmond, WA, US",
      externalId: "1970393556855901",
      postedAt: 1782338678000,
    },
  ]);
});

test("Google Careers for one company (DeepMind): its filter kept, no place, never a page= link", async () => {
  const link =
    "https://www.google.com/about/careers/applications/jobs/results?company=DeepMind&utm_source=deepmind&src=Online";
  expect(google.detect({ careers_url: link })).toBeTruthy();
  expect(
    google.detect({ careers_url: "https://www.google.com/about/careers/applications/jobs/results/" }),
  ).toBeNull();
  const asked: string[] = [];
  const card =
    '<h3 class="QJPWVe">Research Engineer, Multi-Agent Learning</h3><p class="l103df">Google DeepMind | London, UK</p>' +
    '<a href="jobs/results/101218541104964294-research-engineer-multiagent-learning?company=DeepMind&amp;sort_by=date">Learn more</a>';
  const jobs = await google.fetch(
    { careers_url: link, "google-careers": { queries: ["research engineer"] } },
    {
      fetchText: async (url: string) => {
        asked.push(url);
        return card;
      },
    },
  );
  expect(asked).toEqual([
    "https://www.google.com/about/careers/applications/jobs/results/?company=DeepMind&q=research+engineer&sort_by=date",
  ]);
  expect(asked.some((u) => /[?&]page=/.test(u))).toBe(false);
  expect(jobs).toEqual([
    {
      title: "Research Engineer, Multi-Agent Learning",
      url: "https://www.google.com/about/careers/applications/jobs/results/101218541104964294-research-engineer-multiagent-learning",
      location: "London, UK",
      externalId: "101218541104964294",
    },
  ]);
  // One board per company, stored without the link's tracking.
  expect(boardKey("google-careers", link)).toBe("google-careers:deepmind");
  expect(boardUrl("google-careers", link)).toBe(
    "https://www.google.com/about/careers/applications/jobs/results/?company=DeepMind",
  );
  expect(boardUrl("apple", "https://jobs.apple.com/app/en-us/profile/info")).toBe(
    "https://jobs.apple.com/en-us/search",
  );
});

// Boards hosted elsewhere that no vendored provider reads: YC company jobs pages, Homerun, Polymer.
// @ts-expect-error plain JS module
import homerun from "./homerun.mjs";
// @ts-expect-error plain JS module
import polymer from "./polymer.mjs";
// @ts-expect-error plain JS module
import yc from "./yc.mjs";

const attr = (v: unknown) => JSON.stringify(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

test("YC: a company's jobs page data, from a YC or Work at a Startup link", async () => {
  const page = (component: string) =>
    `<div id="app" data-page="${attr({
      component,
      props: {
        jobPostings: [
          {
            id: 61307,
            title: "Software Engineer, AI",
            url: "/companies/tallowly/jobs/4Qm8rZk-software-engineer-ai",
            location: "IN / Remote (IN)",
          },
        ],
      },
    })}"></div>`;
  for (const link of [
    "https://www.ycombinator.com/companies/tallowly/jobs",
    "https://www.ycombinator.com/companies/tallowly/jobs/4Qm8rZk-software-engineer-ai",
    "https://www.workatastartup.com/companies/tallowly",
    "https://www.workatastartup.com/embed/tallowly/jobs",
  ]) {
    expect(yc.detect({ careers_url: link })).toEqual({
      url: "https://www.ycombinator.com/companies/tallowly/jobs",
    });
    expect(boardKey("yc", link)).toBe("yc:tallowly");
  }
  // YC's own pages are not a company's jobs page.
  for (const link of [
    "https://www.ycombinator.com/careers",
    "https://www.ycombinator.com/companies/tallowly",
  ])
    expect(yc.detect({ careers_url: link })).toBeNull();
  expect(boardUrl("yc", "https://www.workatastartup.com/companies/tallowly")).toBe(
    "https://www.ycombinator.com/companies/tallowly/jobs",
  );
  const asked: string[] = [];
  const ctx = (html: string) => ({
    fetchText: async (url: string) => {
      asked.push(url);
      return html;
    },
  });
  expect(
    await yc.fetch(
      { careers_url: "https://www.workatastartup.com/companies/tallowly" },
      ctx(page("WaasShowJobsPage")),
    ),
  ).toEqual([
    {
      title: "Software Engineer, AI",
      url: "https://www.ycombinator.com/companies/tallowly/jobs/4Qm8rZk-software-engineer-ai",
      location: "IN / Remote (IN)",
      externalId: "61307",
      postedAt: null,
    },
  ]);
  expect(asked).toEqual(["https://www.ycombinator.com/companies/tallowly/jobs"]);
  await expect(
    yc.fetch({ careers_url: "https://www.ycombinator.com/companies/x/jobs" }, ctx(page("CompanyPage"))),
  ).rejects.toThrow("no company jobs page");
});

test("Homerun: the job list in the career site's own page", async () => {
  const html = `<section id="job-list"><job-list v-bind="${attr({
    content: {
      vacancies: [
        {
          id: 527104,
          title: "Technical Staff",
          location_id: 20931,
          url: "https://quillmark.homerun.co/technical-staff/en",
        },
      ],
      locations: [{ id: 20931, name: "Paris", locality: "Paris", country: "FR" }],
    },
  })}"></job-list></section>`;
  expect(homerun.detect({ careers_url: "https://quillmark.homerun.co/technical-staff/en" })).toEqual({
    url: "https://quillmark.homerun.co/",
  });
  expect(homerun.detect({ careers_url: "https://www.homerun.co/" })).toBeNull();
  expect(boardKey("homerun", "https://quillmark.homerun.co/")).toBe("homerun:quillmark");
  expect(
    await homerun.fetch({ careers_url: "https://quillmark.homerun.co/" }, { fetchText: async () => html }),
  ).toEqual([
    {
      title: "Technical Staff",
      url: "https://quillmark.homerun.co/technical-staff/en",
      location: "Paris, FR",
      externalId: "527104",
      postedAt: null,
    },
  ]);
});

test("Polymer: its public API, a page at a time", async () => {
  const item = (id: number) => ({
    id,
    title: `Agent Engineer ${id}`,
    display_location: "New York City, NY",
    remoteness_pretty: "No remote",
    published_at: "2026-10-28T21:01:34.082Z",
    job_post_url: `https://jobs.larkspur.example/${id}`,
  });
  const asked: string[] = [];
  const ctx = {
    fetchJson: async (url: string) => {
      asked.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return { items: [item(page)], meta: { total: 2, page } };
    },
  };
  expect(polymer.detect({ careers_url: "https://jobs.polymer.co/larkspur/58213" })).toEqual({
    url: "https://api.polymer.co/v1/hire/organizations/larkspur/jobs",
  });
  expect(boardKey("polymer", "https://jobs.polymer.co/larkspur")).toBe("polymer:larkspur");
  const jobs = await polymer.fetch({ careers_url: "https://jobs.polymer.co/larkspur" }, ctx);
  expect(asked).toEqual([
    "https://api.polymer.co/v1/hire/organizations/larkspur/jobs?page=1",
    "https://api.polymer.co/v1/hire/organizations/larkspur/jobs?page=2",
  ]);
  expect(jobs[0]).toEqual({
    title: "Agent Engineer 1",
    url: "https://jobs.larkspur.example/1",
    location: "New York City, NY",
    externalId: "1",
    postedAt: Date.parse("2026-10-28T21:01:34.082Z"),
  });
});

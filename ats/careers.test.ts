import { afterAll, expect, test } from "bun:test";
import { tempData } from "../core/testing.ts";
import { careersJobs, jsonLdJobs } from "./careers.ts";

const data = tempData();
afterAll(data.cleanup);

test("schema.org JobPosting data wins when the page has it", () => {
  const jobs = jsonLdJobs(
    [
      {
        "@graph": [
          {
            "@type": "JobPosting",
            title: "Platform Engineer",
            url: "https://acme.dev/careers/platform",
            datePosted: "2026-10-20",
            jobLocation: { "@type": "Place", address: { addressLocality: "Boulder", addressRegion: "CO" } },
          },
          { "@type": "Organization", name: "Acme" },
        ],
      },
    ],
    "https://acme.dev/careers",
  );
  expect(jobs).toEqual([
    {
      id: "https://acme.dev/careers/platform",
      title: "Platform Engineer",
      url: "https://acme.dev/careers/platform",
      location: "Boulder, CO",
      postedAt: "2026-10-20T00:00:00.000Z",
    },
  ]);
});

test("JobPosting with @type as a list keeps every location and remote", () => {
  const [job] = jsonLdJobs(
    [
      {
        "@type": ["JobPosting", "Thing"],
        title: "SRE",
        url: "https://acme.dev/careers/sre",
        jobLocationType: "TELECOMMUTE",
        jobLocation: [
          { address: { addressLocality: "Boulder", addressRegion: "CO" } },
          { address: { addressLocality: "Austin", addressRegion: "TX" } },
        ],
      },
    ],
    "https://acme.dev/careers",
  );
  expect(job?.location).toBe("Boulder, CO · Austin, TX · Remote");
});

test("board links come from hrefs, escaped JSON and embed snippets", async () => {
  // @ts-expect-error plain JS module
  const { linksIn, careersLinks } = await import("./links.mjs");
  const html = `
    <a href="/en/careers">Careers</a>
    <a href="https://tallowlycareers.tallowly.com/jobs">Jobs</a>
    <script>var u = "https:\\/\\/quillmark.wd1.myworkdayjobs.com\\/Quillmark_Careers";</script>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
    <script>whr_embed(52731, {detail: 'titles'})</script>
    <script src="https://apply.workable.com/api/v1/widget/accounts/brindleworks?details=true"></script>
    <iframe src="https://ats.rippling.com/embed/larkspur-careers/jobs?s=x"></iframe>
    https://boards-api.greenhouse.io/v1/boards/velmoor/jobs?content=true
    https://api.greenhouse.io/v1/boards/corvane42/jobs
    https://api.ashbyhq.com/posting-api/job-board/fennory?includeCompensation=true
    <div data-props="{&quot;src&quot;:&quot;https://jobs.ashbyhq.com/marrowfield/embed?version=2&quot;}"></div>`;
  const links = linksIn(html, "https://www.tallowly.com/");
  for (const l of [
    "https://jobs.ashbyhq.com/marrowfield/embed?version=2",
    "https://www.tallowly.com/en/careers",
    "https://quillmark.wd1.myworkdayjobs.com/Quillmark_Careers",
    "https://boards.greenhouse.io/acme",
    "https://apply.workable.com/52731",
    "https://apply.workable.com/brindleworks",
    "https://ats.rippling.com/larkspur-careers/jobs",
    "https://boards.greenhouse.io/velmoor",
    // The board APIs a rendered page calls (Corvane's, Fennory's).
    "https://boards.greenhouse.io/corvane42",
    "https://jobs.ashbyhq.com/fennory",
  ])
    expect(links).toContain(l);
  // A career site served on the company's own domain is named by its platform's asset host.
  // @ts-expect-error plain JS module
  const { brandedBoards } = await import("./links.mjs");
  expect(
    brandedBoards(
      ["https://rmkcdn.successfactors.com/3e70ab21/a.css", "https://www.hollowpine.com/"],
      "https://jobs.hollowpine.com/x",
    ),
  ).toEqual([{ provider: "successfactors", careers_url: "https://jobs.hollowpine.com/" }]);
  // A branded Avature site names itself in meta tags; its list is the careers path's SearchJobs.
  expect(
    brandedBoards('<meta name="avature.portal.id" content="7"/>', "https://apply.dunmarra.com/en_US/careers"),
  ).toEqual([{ provider: "avature", careers_url: "https://apply.dunmarra.com/en_US/careers/SearchJobs" }]);
  // A branded Jibe site (iCIMS): the same JSON at /api/jobs.
  expect(
    brandedBoards('<div id="jibe-container"></div>', "https://jobs.orrerygroup.com/working-at-orrery/"),
  ).toEqual([{ provider: "jibeapply", careers_url: "https://jobs.orrerygroup.com/api/jobs" }]);
  // Google Careers by its own address only, not a page that links to it.
  expect(brandedBoards("", "https://www.google.com/about/careers/applications/")).toEqual([
    { provider: "google", careers_url: "https://www.google.com/about/careers/applications/jobs/results/" },
  ]);
  expect(brandedBoards("https://www.google.com/about/careers/", "https://acme.dev/careers")).toEqual([]);
  // A SmartRecruiters posting id on the company's own posting page.
  // @ts-expect-error plain JS module
  const { smartRecruitersIds } = await import("./links.mjs");
  expect(
    smartRecruitersIds([
      "https://careers.tallmere.com/jobs/731906452288104/software-engineer/",
      "https://acme.dev/jobs/12345",
    ]),
  ).toEqual(["731906452288104"]);
  // A separate jobs site comes before same-host pages; other-language copies are skipped.
  expect(
    careersLinks(
      [
        "https://www.tallowly.com/en/careers",
        "https://www.tallowly.com/fr-fr/careers",
        "https://tallowlycareers.tallowly.com/jobs",
        "https://evil.example/careers",
        "https://www.tallowly.com/public/css/jobs.css",
      ],
      "tallowly.com",
      "https://www.tallowly.com/en",
    ),
  ).toEqual(["https://tallowlycareers.tallowly.com/jobs", "https://www.tallowly.com/en/careers"]);
});

test("a board bears a company's name words or its real site's first label, punctuation squashed; never a key or a shared word", async () => {
  // @ts-expect-error plain JS module
  const { boardBearer } = await import("./links.mjs");
  // Quorvex's site is brightwell-labs.io; its board is jobs.ashbyhq.com/brightwell-labs.
  expect(boardBearer("Quorvex", "brightwell-labs.io")("https://jobs.ashbyhq.com/brightwell-labs")).toBe(true);
  // With no site there is no site word: a company keyed by its id (856) doesn't bear a board
  // whose job id holds it. Given the key as a site it would.
  const other = "https://job-boards.greenhouse.io/other/jobs/4856123";
  expect(boardBearer("Acme Robotics", undefined)(other)).toBe(false);
  expect(boardBearer("Acme Robotics", "856")(other)).toBe(true);
  // Its name's words still count.
  expect(boardBearer("Acme Robotics", undefined)("https://jobs.lever.co/acme")).toBe(true);
  expect(boardBearer("Acme Robotics", "acmebots.com")("https://jobs.lever.co/acmebots")).toBe(true);
  // Words many boards or names share say nothing ("Labs", the site jobs.example.com).
  expect(boardBearer("Labs", "jobs.example.com")("https://jobs.lever.co/labs")).toBe(false);
});

test("a careers page whose own job list no ATS claims is read from its plain HTML", () => {
  const list = [1001, 1002, 1003].map((id) => ({
    id,
    title: `Role ${id}`,
    url: `https://acme.dev/jobs/${id}`,
  }));
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { jobs: list } })}</script>`;
  expect(careersJobs(html, "https://acme.dev/careers").map((j) => j.title)).toEqual([
    "Role 1001",
    "Role 1002",
    "Role 1003",
  ]);
});

// A page's own job list, linking these postings.
const listing = (urls: string[]) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { jobs: urls.map((url, i) => ({ id: 2001 + i, title: `Role ${i + 1}`, url })) },
  })}</script>`;
// Roles on four employers' boards, on two job-board hosts; a fifth on one of theirs.
const four = [
  "https://job-boards.greenhouse.io/acme/jobs/101",
  "https://boards.greenhouse.io/beta/jobs/102",
  "https://jobs.ashbyhq.com/gamma/0e1c0f8b-1a2b-4c3d-8e9f-0123456789ab",
  "https://jobs.ashbyhq.com/delta/1e1c0f8b-1a2b-4c3d-8e9f-0123456789ab",
  "https://job-boards.greenhouse.io/acme/jobs/105",
];
const three = four.filter((u) => !u.includes("delta"));
// One company's five JOIN postings (Dunmarra's careers page links them).
const join = [1, 2, 3, 4, 5].map((i) => `https://join.com/companies/dunmarracom/2493317${i}-engineer-${i}`);

test("a list whose roles are on 4 or more employers' boards is a fund's job board, no company's: none", () => {
  const titles = (html: string, page = "https://jobs.fund.vc/jobs") =>
    careersJobs(html, page).map((j) => j.title);
  expect(titles(listing(four))).toEqual([]);
  expect(titles(listing(three))).toEqual(["Role 1", "Role 2", "Role 3", "Role 4"]);
  // One employer's board, however many roles: a Workday tenant is one employer.
  const tenant = Array.from(
    { length: 10 },
    (_, i) => `https://acme.wd1.myworkdayjobs.com/en-US/External/job/Boulder/Engineer_R${i}`,
  );
  expect(titles(listing(tenant))).toHaveLength(10);
  // Links on no job board never count: Notion pages, companies' own sites.
  const pages = [
    "https://acme.notion.site/Engineer-1",
    "https://beta.notion.site/Engineer-2",
    "https://gamma.dev/careers/engineer",
    "https://delta.io/jobs/4",
    "https://epsilon.ai/careers/5",
    "https://zeta.com/careers/6",
  ];
  expect(titles(listing(pages))).toHaveLength(6);
  // One company's JOIN postings are one employer.
  expect(titles(listing(join), "https://dunmarra.com/careers/")).toHaveLength(5);
  // The page's own board isn't another employer's: its roles and three others' are kept.
  const own = ["https://jobs.lever.co/omega/1111", "https://jobs.lever.co/omega/2222", ...three];
  expect(titles(listing(own), "https://jobs.lever.co/omega")).toHaveLength(6);
  // JobPosting data and a feed are held to the same rule.
  const ld = `<script type="application/ld+json">${JSON.stringify(
    four.map((url) => ({ "@type": "JobPosting", title: "Engineer", url })),
  )}</script>`;
  expect(titles(ld)).toEqual([]);
  expect(titles(ld.replace(/delta/g, "gamma"))).toHaveLength(5);
  const rss = `<?xml version="1.0"?><rss><channel>${four
    .map((u) => `<item><title>Engineer</title><link>${u}</link></item>`)
    .join("")}</channel></rss>`;
  expect(titles(rss, "https://jobs.fund.vc/feed.xml")).toEqual([]);
});

test("an address that takes applications: any on a careers page, a careers-type one on the home page, own domain only", async () => {
  // @ts-expect-error plain JS module
  const { applyEmailIn, cfDecode } = await import("./links.mjs");
  const careers = `<p>No openings listed. <a href="mailto:hello@quarry.so">Say hi</a> or write to
    <a href="mailto:privacy@quarry.so">privacy</a>.</p><img src="logo@2x.png">`;
  // A careers page's hello@ or contact@ is a contact; a mailto: that says "Apply" is an application.
  expect(applyEmailIn(careers, "quarry.so", true)).toBeNull();
  expect(applyEmailIn("<p>Questions? contact@brakmoor.com</p>", "brakmoor.com", true)).toBeNull();
  expect(
    applyEmailIn(`<a href="mailto:founders@quarry.so?subject=Role">Apply now</a>`, "quarry.so", true),
  ).toBe("founders@quarry.so");
  expect(applyEmailIn(`<a href="mailto:founders@quarry.so">Apply now</a>`, "quarry.so", false)).toBeNull();
  // A post's own text may name any address that isn't for something else.
  expect(applyEmailIn("Email hello@quarry.so with your work", "quarry.so", "post")).toBe("hello@quarry.so");
  const home = `<footer>hello@quarry.so · support@quarry.so · <a href="mailto:careers@quarry.so">Careers</a></footer>`;
  expect(applyEmailIn(home, "quarry.so", false)).toBe("careers@quarry.so");
  expect(applyEmailIn("<footer>hello@quarry.so</footer>", "quarry.so", false)).toBeNull();
  // Seen on careers pages (2026-10-28): not where applications go.
  expect(applyEmailIn("corporateprivacy@hollowpine.com", "hollowpine.com", true)).toBeNull();
  expect(applyEmailIn("recruitingaccommodations@velmoor.com", "velmoor.com", true)).toBeNull();
  // A subdomain is the company's; another domain (a recruiter, a webmail) isn't.
  expect(applyEmailIn("jobs@team.quarry.so", "quarry.so", true)).toBe("jobs@team.quarry.so");
  expect(applyEmailIn("<a href='mailto:jobs@recruitco.com'>apply</a>", "quarry.so", true)).toBeNull();
  // Cloudflare's protected address: the first byte XORs the rest.
  const encode = (s: string, key = 0x42) =>
    key.toString(16).padStart(2, "0") +
    [...s].map((ch) => (ch.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
  expect(cfDecode(encode("careers@quarry.so"))).toBe("careers@quarry.so");
  const cf = `<a href="/cdn-cgi/l/email-protection#${encode("jobs@quarry.so")}"><span class="__cf_email__" data-cfemail="${encode("jobs@quarry.so")}">[email&#160;protected]</span></a>`;
  expect(applyEmailIn(cf, "quarry.so", false)).toBe("jobs@quarry.so");
});

test("a jobs feed the careers page names is read as a feed, RSS or Atom", async () => {
  // @ts-expect-error plain JS module
  const { jobsFeed } = await import("./links.mjs");
  expect(
    jobsFeed(
      '<link rel="alternate" type="application/rss+xml" title="Blog" href="/feed.xml"><link rel="alternate" type="application/atom+xml" title="Tallmere Jobs Feed" href="https://tallmere.com/feed/jobs.xml">',
      "https://tallmere.com/jobs",
    ),
  ).toBe("https://tallmere.com/feed/jobs.xml");
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Jobs</title>
    <entry><id>tag:tallmere.com,2026:job-1</id><title>Senior Programmer</title>
      <link href="https://tallmere.com/jobs/senior-programmer" rel="alternate"/><published>2026-10-20T12:00:00Z</published></entry></feed>`;
  expect(careersJobs(atom, "https://tallmere.com/feed/jobs.xml")).toEqual([
    {
      id: "tag:tallmere.com,2026:job-1",
      title: "Senior Programmer",
      url: "https://tallmere.com/jobs/senior-programmer",
      location: "",
      postedAt: "2026-10-20T12:00:00.000Z",
    },
  ]);
  const rss = `<rss version="2.0"><channel><title>Jobs</title>
    <item><title><![CDATA[Sales Lead]]></title><link>https://careers.acme.com/jobs/7-sales-lead</link><guid>7</guid><pubDate>Fri, 30 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  expect(
    careersJobs(rss, "https://careers.acme.com/jobs.rss").map((j) => [j.id, j.title, j.postedAt]),
  ).toEqual([["7", "Sales Lead", "2026-10-30T10:00:00.000Z"]]);
});

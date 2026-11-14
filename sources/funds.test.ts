import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import funds, { ldItems, nextArray, readers, slugOf } from "./funds/index.ts";

const { cleanup } = tempData();
afterAll(cleanup);

test("a Next.js page's list is read whole from its server data, quotes and brackets inside included", () => {
  const data = `x{"companies":[{"name":"Brakmoor","domain":"brakmoor.com","slug":"brakmoor-industries","jobCount":3,"description":"a [bracket] and \\"quote\\""}],"more":1}`;
  const html = `<script>self.__next_f.push([1,${JSON.stringify(data.slice(0, 30))}])</script><script>self.__next_f.push([1,${JSON.stringify(data.slice(30))}])</script>`;
  expect(nextArray(html, "companies")).toEqual([
    {
      name: "Brakmoor",
      domain: "brakmoor.com",
      slug: "brakmoor-industries",
      jobCount: 3,
      description: 'a [bracket] and "quote"',
    },
  ]);
  expect(nextArray(html, "roles")).toBeNull();
});

test("Index's companies list is read from its JSON-LD, and a name is slugged as its job addresses write it", () => {
  const ld = {
    "@graph": [
      { "@type": "WebPage", name: "Companies" },
      {
        "@type": "CollectionPage",
        mainEntity: {
          itemListElement: [
            { url: "https://www.indexventures.com/companies/incident/", name: "incident.io" },
            { url: "https://www.indexventures.com/companies/x/", name: "Ben &amp; Jerry" },
          ],
        },
      },
    ],
  };
  expect(ldItems(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`)).toEqual([
    { name: "incident.io", url: "https://www.indexventures.com/companies/incident/" },
    { name: "Ben & Jerry", url: "https://www.indexventures.com/companies/x/" },
  ]);
  expect(["incident.io", "Lightning AI", "Café Ö", "ankar.ai"].map(slugOf)).toEqual([
    "incident-io",
    "lightning-ai",
    "cafe-o",
    "ankar-ai",
  ]);
});

test("a ticked fund's hiring companies come in once each, their website still to be proven", async () => {
  expect(await funds.connected()).toBe(false);
  writeFileSync(paths.config(), '[source.funds]\npicks = ["a16z"]\n');
  expect(await funds.connected()).toBe(true);
  const real = readers.a16z;
  readers.a16z = async () => [
    {
      name: "Brakmoor",
      domain: "brakmoor.com",
      slug: "brakmoor-industries",
      jobs: 3,
      location: "Costa Mesa",
      page: "https://jobs.a16z.com/company/brakmoor-industries",
    },
    {
      name: "Hushwell",
      domain: "hushwell.com",
      slug: "hushwell",
      jobs: 0,
      location: "",
      page: "https://jobs.a16z.com/company/hushwell",
    },
  ];
  try {
    const leads = await funds.fetch(null);
    expect(leads.map((l) => [l.company_hint, l.domain, l.domain_from, l.url])).toEqual([
      ["Brakmoor", "brakmoor.com", "looked up", "https://jobs.a16z.com/company/brakmoor-industries"],
    ]);
    expect(await funds.fetch(null)).toEqual([]);
  } finally {
    readers.a16z = real;
  }
});

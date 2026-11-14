// What the small model says about a careers page is kept only where the page shows it.
import { afterAll, expect, test } from "bun:test";
import { tempData } from "../core/testing.ts";
import { keep, type PageText, plainText, showsAll, textHash } from "./read-page.ts";

const data = tempData();
afterAll(data.cleanup);

const acme = { name: "Acme Robotics, Inc.", domain: "acme.dev" };
const page: PageText = {
  url: "https://acme.dev/careers",
  text: "Open roles\nSenior  Robotics Engineer – Controls\nBoulder, CO\nFounding Designer\nEmail jobs@acme.dev\nRecruiter",
  links: [
    { href: "https://acme.dev/careers/robotics-engineer", text: "Senior Robotics Engineer - Controls" },
    { href: "mailto:jobs@acme.dev?subject=Designer", text: "Apply" },
    { href: "https://jobs.lever.co/acme", text: "All openings" },
  ],
};
const answer = (roles: { title: string; url: string }[], employers = ["Acme Robotics"], board = "") => ({
  roles,
  employers,
  board,
  note: "",
});

test("a role is kept when the page shows its title word for word and its link is the page's", () => {
  const read = keep(
    answer([
      // Case, spacing and dashes aside, word for word, and once.
      { title: "Senior Robotics Engineer - Controls", url: "https://acme.dev/careers/robotics-engineer/" },
      { title: "senior robotics engineer - controls", url: "https://acme.dev/careers/robotics-engineer" },
      { title: "Founding Designer", url: "mailto:jobs@acme.dev?subject=Founding%20Designer" },
      { title: "Recruiter", url: "https://acme.dev/careers" },
      // Not on the page, or not in these words, or a link the page doesn't have.
      { title: "Staff Software Engineer", url: "https://acme.dev/careers" },
      { title: "Robotics Engineer, Controls", url: "https://acme.dev/careers/robotics-engineer" },
      { title: "Founding Designer", url: "https://acme.dev/careers/founding-designer" },
    ]),
    acme,
    page,
  );
  expect(read.jobs.map((j) => [j.title, j.url])).toEqual([
    ["Senior Robotics Engineer - Controls", "https://acme.dev/careers/robotics-engineer/"],
    ["Founding Designer", "mailto:jobs@acme.dev?subject=Founding%20Designer"],
    ["Recruiter", "https://acme.dev/careers"],
  ]);
  expect(read.note).toContain("3 not shown on the page");
  // A role with its own link is known by it; one on the page itself, by its title too.
  expect(read.jobs.map((j) => j.id)).toEqual([
    "https://acme.dev/careers/robotics-engineer/",
    "mailto:jobs@acme.dev?subject=Founding%20Designer",
    "https://acme.dev/careers#recruiter",
  ]);
});

test("roles at other employers, or several, or none named, are not the company's", () => {
  const roles = [{ title: "Recruiter", url: "https://acme.dev/careers" }];
  expect(keep(answer(roles, ["Acme"]), acme, page).jobs).toHaveLength(1);
  expect(keep(answer(roles, ["acme.dev"]), acme, page).jobs).toHaveLength(1);
  expect(keep(answer(roles, ["Acme", "Sola"]), acme, page).jobs).toEqual([]);
  expect(keep(answer(roles, ["Sola"]), acme, page).jobs).toEqual([]);
  // The page's own site doesn't name it (T:0's page on airwallex.com, Airwallex's roles).
  expect(keep(answer(roles, ["Acme Dev"]), { name: "T:0", domain: null }, page).jobs).toEqual([]);
  expect(keep(answer(roles, []), acme, page)).toMatchObject({
    jobs: [],
    note: expect.stringContaining("no employer"),
  });
  // On its own site, the one employer the page names is the company (Cal.com's "Foundation", a
  // team), or none named; several are still other employers' roles.
  expect(keep(answer(roles, ["Foundation"]), acme, page, true).jobs).toHaveLength(1);
  expect(keep(answer(roles, []), acme, page, true).jobs).toHaveLength(1);
  expect(keep(answer(roles, ["Apple", "Google DeepMind"]), acme, page, true).jobs).toEqual([]);
});

test("a board is kept only when it is one of the page's links", () => {
  expect(keep(answer([], [], "https://jobs.lever.co/acme"), acme, page).board).toBe(
    "https://jobs.lever.co/acme",
  );
  expect(keep(answer([], [], "https://jobs.lever.co/other"), acme, page).board).toBeNull();
});

test("a plain page reads as text and links; it shows the roles the render did, or it doesn't", () => {
  const plain = plainText(
    '<nav><a href="/">Home</a></nav><script>var x = "Recruiter";</script><h2>Senior Robotics Engineer &ndash; Controls</h2><a href="/careers/robotics-engineer">Apply</a>',
    "https://acme.dev/careers",
  );
  expect(plain.links.map((l) => l.href)).toEqual([
    "https://acme.dev/",
    "https://acme.dev/careers/robotics-engineer",
  ]);
  expect(plain.text).not.toContain("Recruiter");
  const role = {
    title: "Senior Robotics Engineer - Controls",
    url: "https://acme.dev/careers/robotics-engineer",
  };
  expect(showsAll([role], plain)).toBe(true);
  expect(showsAll([role, { title: "Recruiter", url: "https://acme.dev/careers" }], plain)).toBe(false);
  expect(textHash("a  b\n c")).toBe(textHash("a b c"));
});

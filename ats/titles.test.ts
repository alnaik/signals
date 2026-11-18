// The title words as folded words (tokenise): invented titles only.
import { expect, test } from "bun:test";
import { head, missed, type PostingFilters, reviewTitle, score, tokenise, variants } from "./filters.ts";

const f: PostingFilters = {
  title_include: [
    "Software Engineer",
    "Software Development",
    "Developer",
    "Full Stack",
    "Solutions Architect",
    "Systems Engineer",
    "Data Engineer",
    "AI Engineer",
    "Analytics Engineer",
    "Sales Engineer",
    "Product Engineer",
    "Web Developer",
    "Mobile",
    "AR",
    "Unity",
    "Prototyp",
    "ML Engineer",
    "Technical Product",
  ],
  title_exclude: ["Engineering Manager", "Hardware Engineer", "TS/SCI", "Top Secret", "Clearance"],
};
const fit = (title: string) => score({ title }, f).fits;
const matched = (title: string) => score({ title }, f).matched;
const out = (title: string) => missed({ title }, f)?.match(/“(.+)”, a word you left out/)?.[1];
const near = (title: string) => score({ title }, f).review;

test("punctuation and case don't matter; accents fold", () => {
  expect(fit("Senior Full-Stack Engineer")).toBe(true);
  expect(fit("Software Engineer (Go)")).toBe(true);
  expect(fit("Ingénieur Software Engineer")).toBe(true);
  expect(matched("#Software Engineer")).toBe("Software Engineer");
});

test("singular is plural, both ways", () => {
  expect(matched("Solution Architect")).toBe("Solutions Architect");
  expect(matched("Control System Engineer")).toBe("Systems Engineer");
  expect(fit("Web Developers")).toBe(true);
});

test("short forms read as what they stand for, on both sides", () => {
  expect(matched("Software Dev Engineer II")).toBe("Software Development");
  expect(matched("Sr. SW Engineer")).toBe("Software Engineer");
  expect(matched("Staff SWE - Networking")).toBe("Software Engineer");
  expect(fit("SDE II")).toBe(true);
  expect(fit("Staff MLE, Search")).toBe(true);
  expect(fit("Tech Bus Dev")).toBe(false); // dev is development, not developer
});

test("a two-word phrase matches as one word, and with the other job words", () => {
  expect(fit("Fullstack Engineer")).toBe(true);
  expect(matched("Staff Web Engineer")).toBe("Web Developer");
  expect(matched("Software Developer")).toBe("Developer"); // as written beats another form
  expect(fit("Graphics Programmer")).toBe(false);
});

test("words must be adjacent: ',', '&', '/', 'and' and ' - ' break a phrase", () => {
  expect(fit("Sales, Engineering - West")).toBe(false);
  expect(fit("Operations Manager, Product & Engineering")).toBe(false);
  expect(fit("Head of Product and Engineering")).toBe(false);
  expect(fit("Engineer II - Software")).toBe(false);
  expect(fit("AI/ML Engineer")).toBe(true);
  expect(fit("Solutions/Sales Engineer")).toBe(true);
});

test("exclusions read the same forms and take the owner's punctuation", () => {
  expect(out("Software Engineering Mgr - L5")).toBe("Engineering Manager");
  expect(out("Java Engineer (TS SCI)")).toBe("TS/SCI");
  expect(out("Java Engineer (TS/SCI)")).toBe("TS/SCI");
  expect(out("Software Engineer (TopSecret)")).toBe("Top Secret");
  expect(out("Hardware Developer")).toBe("Hardware Engineer");
  expect(fit("Software Engineer, Clearance Preferred")).toBe(false);
});

test("short words whole, stems, a kind of job needs a job word", () => {
  expect(fit("Software Architect, AR/VR")).toBe(true);
  expect(fit("Enterprise Architect")).toBe(false);
  expect(fit("Community Manager")).toBe(false);
  expect(fit("Rapid Prototyping Lead")).toBe(true);
  expect(fit("Mobile Dog Groomer")).toBe(false);
  expect(fit("Member of Technical Staff, Mobile")).toBe(true);
  expect(fit("MTS, Mobile")).toBe(true);
});

test("review: close to a phrase of yours (fewest words between, one segment), else the head", () => {
  expect(near("AI and Data Science Engineer II")).toBe("Data Engineer + science");
  expect(reviewTitle("AI and Data Science Engineer II", f)).toEqual({
    key: "Data Engineer + science",
    phrase: "Data Science Engineer",
    like: "Data Engineer",
  });
  expect(reviewTitle("Health Care Analytics and Insights Engineer II", f)?.phrase).toBe(
    "Analytics and Insights Engineer",
  );
  expect(near("Distinguished Engineer AI")).toBe("AI Engineer (any order)");
  expect(near("Engineer, Data")).toBe("engineer"); // different segments: not close
  expect(near("Security Engineer, Infrastructure")).toBe("security engineer");
  expect(near("Software Development Engineer in Test")).toBeNull(); // it fits
  expect(near("Office Assistant")).toBeNull(); // names no job
  expect(near("Hardware Developer")).toBeNull(); // left out
  // Only in your places.
  expect(
    score({ title: "Security Engineer", location: "Lisbon" }, { ...f, locations: ["Denver"] }).review,
  ).toBeNull();
  expect(
    score({ title: "Security Engineer", location: "Denver" }, { ...f, locations: ["Denver"] }).review,
  ).toBe("security engineer");
  expect(missed({ title: "Data Center Engineer" }, f)).toBe(
    "title has none of your words · close to “Data Engineer”",
  );
});

test("heads leave level and small words out", () => {
  expect(head(tokenise("Senior Palantir AI and Data Science Engineer"))).toBe("data science engineer");
  expect(head(tokenise("Data Platform Support Lead"))).toBe("platform support lead");
  expect(head(tokenise("Office Assistant"))).toBe("");
  expect(head(tokenise("Member of Technical Staff"))).toBe("technical staff");
});

test("tokens: + and # stay at a word's end; small words soften the next break", () => {
  expect(tokenise("C++ / C# Developer, .NET").t).toEqual(["c++", "c#", "developer", "net"]);
  const x = tokenise("Head of Engineering");
  expect([x.t, x.seg, x.brk]).toEqual([
    ["head", "engineering"],
    [0, 0],
    [0, 1],
  ]);
  expect(tokenise("Engineer II - Backend").seg).toEqual([0, 0, 1, 1]);
  expect(variants("ML")).toEqual(["ml", "machine learning"]);
  expect(variants("Senior")).toEqual(["senior", "sr"]);
  expect(variants("engineers")).toEqual(["engineers", "engineer", "eng", "engr"]);
});

test("review: a three-word phrase with more than two words between in all falls to any order, and no crash", () => {
  const g: PostingFilters = { ...f, title_include: ["Machine Learning Engineer"] };
  // One word between the first two, two between the last two: three in all, past the limit of two.
  expect(score({ title: "Machine Vision Learning Platform Ops Engineer" }, g).review).toBe(
    "Machine Learning Engineer (any order)",
  );
  expect(score({ title: "Machine Vision Learning Engineer" }, g).review).toBe(
    "Machine Learning Engineer + vision",
  );
});

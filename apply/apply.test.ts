import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { upsertCompany } from "../intake/companies.ts";
import { findAnswer, questionType, saveAnswer } from "./answers.ts";
import { detectAts, mapFields } from "./forms.ts";
import { isLinkedIn } from "./linkedin.ts";
import { cvDates, cvHistory, cvList, cvName, pdfs, removeCv, saveCv, saveCvText } from "./me.ts";
import { chosenPdf, pickPdf, prepare } from "./prepare.ts";

const data = tempData();
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeAll(() => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({
      full_name: "Sam Example",
      email: "sam@example.com",
      phone: "+44 7700 900000",
      linkedin: "https://linkedin.com/in/example",
      location: "London",
      needs_sponsorship: false,
    }),
  );
});

test("a CV's Markdown gives its work history and education, never its projects", () => {
  const md = `# SAM RIVERA
Portland, OR | (555) 555-0100

## EXPERIENCE

**Larkspur Freight Co.** | Seattle, WA (Remote)
**Platform Engineer** | Jul 2025 - Present
- Built the route search.

**Quillmark Labs** | Portland, OR
**Firmware Engineer** | Oct 2024 - Jul 2025
Regional robotics league finalist (2024).
- Wrote the sensor software.
- Added structured logging.
*Rust, Python, Linux*

**Brightwater Apps** | Portland, OR | github.com/samrivera-example/tide-app
**Mobile Developer (iOS / React Native)** | Aug 2023 - Apr 2024
- Wrote the sync layer.

**Willow County Library**
**IT Assistant** | Jan 2022 - Jul 2022
- Fixed network issues.

**Freelance Web Developer** | Remote | 2020 - 2022
- Built sites.

## PROJECTS

**ledger-lite** | Command-line budgeting tool | Oct 2026 | github.com/samrivera-example/ledger-lite
- Not a job.

## SKILLS

**Languages:** Go, Python

## EDUCATION

**Cascade State University** | B.S. Computer Science | GPA 3.71
Coursework: Distributed Systems
`;
  const h = cvHistory(md)!;
  expect(h.work.map((j) => [j.company, j.title, j.location])).toEqual([
    ["Larkspur Freight Co.", "Platform Engineer", "Seattle, WA (Remote)"],
    ["Quillmark Labs", "Firmware Engineer", "Portland, OR"],
    ["Brightwater Apps", "Mobile Developer (iOS / React Native)", "Portland, OR"],
    ["Willow County Library", "IT Assistant", ""],
    ["", "Freelance Web Developer", "Remote"],
  ]);
  expect(h.work[0]).toMatchObject({ start: { month: "07", year: "2025" }, end: null, current: true });
  expect(h.work[1]!.description).toBe(
    "Regional robotics league finalist (2024).\nWrote the sensor software.\nAdded structured logging.",
  );
  expect(h.work[4]).toMatchObject({ start: { month: "", year: "2020" }, end: { month: "", year: "2022" } });
  expect(h.education).toEqual([
    {
      school: "Cascade State University",
      degree: "B.S.",
      field: "Computer Science",
      gpa: "3.71",
      firstYear: "",
      lastYear: "",
    },
  ]);
  // Years attended as the CV gives them: a range, a lone (graduation) year, still there.
  const years = (line: string) => {
    const s = cvHistory(`## EDUCATION\n\n**Cascade State** | ${line}\n`)!.education[0]!;
    return [s.degree, s.firstYear, s.lastYear, s.gpa];
  };
  expect(years("B.S. Physics | 2019 - 2023")).toEqual(["B.S.", "2019", "2023", ""]);
  expect(years("B.S. Physics | Aug 2019 – May 2023 | GPA 3.9")).toEqual(["B.S.", "2019", "2023", "3.9"]);
  expect(years("B.S. Physics | May 2023")).toEqual(["B.S.", "", "2023", ""]);
  expect(years("M.S. Physics | 2024 - Present")).toEqual(["M.S.", "2024", "", ""]);
  expect(cvHistory("# A\n\nJust words.\n")).toBeNull();
  expect(cvDates("Oct 2024 – Jul 2025")).toEqual({
    start: { month: "10", year: "2024" },
    end: { month: "07", year: "2025" },
    current: false,
  });
});

test("ATS detection from posting URLs", () => {
  expect(detectAts("https://boards.greenhouse.io/tessera/jobs/4410?gh_jid=4410")).toMatchObject({
    ats: "greenhouse",
    slug: "tessera",
    jobId: "4410",
  });
  expect(detectAts("https://jobs.lever.co/quarry/abc-123")?.applyUrl).toBe(
    "https://jobs.lever.co/quarry/abc-123/apply",
  );
  expect(detectAts("https://jobs.ashbyhq.com/Brindle/9f2c")?.applyUrl).toBe(
    "https://jobs.ashbyhq.com/Brindle/9f2c/application",
  );
  // A role in Ashby's embed view (the hosted pages are off) applies in it.
  expect(detectAts("https://jobs.ashbyhq.com/tallowly/13ce?embed=js")).toMatchObject({
    jobId: "13ce",
    applyUrl: "https://jobs.ashbyhq.com/tallowly/13ce/application?embed=js",
  });
  expect(detectAts("https://careers.quillmark.dev/jobs/1")).toBeNull();
});

test("the answer bank types questions and reuses answers", () => {
  expect(questionType("Why do you want to work at Tessera?")).toBe("why_company");
  expect(questionType("What is your notice period?")).toBe("notice");
  saveAnswer("What's your notice period?", "Quarry", "One month.");
  expect(findAnswer("When can you start?", "Tessera Labs")?.answer).toBe("One month.");
  // "Why this company" answers are never reused across companies.
  saveAnswer("Why Quarry?", "Quarry", "Your build pipeline.");
  expect(findAnswer("Why do you want to join us?", "Tessera Labs")).toBeNull();
  // An answer that names its company stays with that company; an older one is used elsewhere.
  saveAnswer("Notice period?", "Quarry", "One month, after Quarry's launch.");
  expect(findAnswer("Notice period?", "Quarry")?.answer).toBe("One month, after Quarry's launch.");
  expect(findAnswer("Notice period?", "Tessera Labs")?.answer).toBe("One month.");
});

test("fields come from the profile, the answer bank, the PDF, or are answered on the form", () => {
  const fields = mapFields(
    [
      { label: "First Name", name: "first_name", type: "input_text", required: true },
      { label: "Last Name", name: "last_name", type: "input_text", required: true },
      { label: "Resume/CV", name: "resume", type: "input_file", required: true },
      {
        label: "Will you now or in the future require sponsorship?",
        name: "q1",
        type: "multi_value_single_select",
        required: true,
      },
      { label: "Gender", name: "gender", type: "multi_value_single_select", required: false },
      { label: "What is your notice period?", name: "q2", type: "input_text", required: false },
      { label: "Why do you want to work at Tessera?", name: "q3", type: "textarea", required: true },
    ],
    {
      profile: JSON.parse(readFileSync(paths.me("profile.json"), "utf8")),
      company: "Tessera Labs",
      cvFile: "/x/cv.pdf",
    },
  );
  expect(fields.map((f) => [f.value, f.source])).toEqual([
    ["Sam", "profile"],
    ["Example", "profile"],
    ["/x/cv.pdf", "resume file"],
    ["No", "profile"],
    ["", "voluntary: your choice"],
    ["One month.", "answer bank"],
    ["", "answer on the form"],
  ]);
});

test("with two PDFs in me/ Apply asks once per role and remembers each role's pick; a pick from before picks were per role counts for none", () => {
  const id = "quarry.so";
  append(id, { actor: "ats", kind: "signal", data: { company: "Quarry", kind: "posting", title: "SRE" } });
  writeFileSync(paths.me("cv-infra.pdf"), "%PDF-1.4");
  writeFileSync(paths.me("cv-product.pdf"), "%PDF-1.4");
  const [sre, data] = ["https://quarry.so/jobs/sre", "https://quarry.so/jobs/data"];
  // Picked for the company, as before: no role reuses it.
  append(id, { actor: "board", kind: "note", data: { event: "pdf_chosen", file: "cv-infra.pdf" } });
  expect(chosenPdf(id, sre)).toBeNull();
  expect(pickPdf(id, sre, "nope.pdf")).toBe(false);
  expect(pickPdf(id, sre, "cv-infra.pdf")).toBe(true);
  expect(chosenPdf(id, sre)).toBe("cv-infra.pdf");
  expect(chosenPdf(id, data)).toBeNull(); // another role at the company asks again
  expect(pickPdf(id, data, "cv-product.pdf")).toBe(true);
  expect([chosenPdf(id, sre), chosenPdf(id, data)]).toEqual(["cv-infra.pdf", "cv-product.pdf"]);
  expect(chosenPdf(id, undefined)).toBeNull();
  expect(chosenPdf("tessera.dev", sre)).toBeNull();
  rmSync(paths.me("cv-infra.pdf"));
  expect(chosenPdf(id, data)).toBe("cv-product.pdf"); // one PDF: that one, asked or not
  expect(chosenPdf(id, undefined)).toBe("cv-product.pdf");
  expect(readFileSync(paths.log(id), "utf8")).toContain("pdf_chosen");
});

test("a week after applying, each posting is checked once: up, gone, or moved to the board", async () => {
  const { checkPostings } = await import("./jobs.ts");
  const B = "https://93.184.215.14";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (url === `${B}/jobs/up`)
      return new Response("<html>role</html>", { headers: { "content-type": "text/html" } });
    if (url === `${B}/jobs/moved`)
      return new Response(null, { status: 302, headers: { location: `${B}/?error=true` } });
    if (url === `${B}/`)
      return new Response("<html>board</html>", { headers: { "content-type": "text/html" } });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const id = "posted.dev";
  for (const [slug, ts] of [
    ["up", "2026-10-01T00:00:00Z"],
    ["moved", "2026-10-01T00:00:00Z"],
    ["gone", "2026-10-01T00:00:00Z"],
    ["fresh", "2026-10-25T00:00:00Z"],
  ])
    append(id, {
      actor: "board",
      kind: "decision",
      data: { action: "applied", url: `${B}/jobs/${slug}` },
      ts,
    } as never);
  // LinkedIn is never read: a posting there isn't checked.
  append(id, {
    actor: "board",
    kind: "decision",
    data: { action: "applied", url: "https://www.linkedin.com/jobs/view/4410" },
    ts: "2026-10-01T00:00:00Z",
  } as never);
  const now = new Date("2026-10-27T00:00:00Z");
  expect(await checkPostings(now)).toBe("3 postings checked · 2 gone");
  const checks = read(id).filter((e) => e.data.event === "posting_check");
  expect(checks.map((e) => [e.data.url.split("/").at(-1), e.data.ok])).toEqual([
    ["up", true],
    ["moved", false],
    ["gone", false],
  ]);
  expect(await checkPostings(now)).toBe("0 postings checked · 0 gone");
});

test("a role from a LinkedIn alert is never applied on there: no link; the panel points to the company's board", async () => {
  const { feature } = await import("./server.ts");
  const routes = feature.routes!["/api/apply/:id"] as {
    GET: (req: unknown) => Response;
    POST: (req: unknown) => Promise<Response>;
  };
  const id = "weave.example";
  const url = "https://www.linkedin.com/comm/jobs/view/4410";
  append(id, {
    actor: "gmail",
    kind: "signal",
    data: { company: "Weave", kind: "posting", title: "Robotics Engineer" },
    source: { type: "page", url },
  });
  append(id, { actor: "board", kind: "decision", data: { action: "apply", url } });
  index.reindex(id);
  const role = (await import("../core/derive.ts")).derive(read(id)).roles[0]!;
  expect((await prepare(id, role)).apply_url).toBe("");
  const res = await routes.POST({ params: { id }, json: async () => ({ url }) });
  expect(res.status).toBe(400);
  expect((await res.json()).toast).toContain("own board");
  expect(isLinkedIn("https://lnkd.in/abc")).toBe(true);
  expect(isLinkedIn("https://notlinkedin.com/x")).toBe(false);
  // The board to apply on: the company's own, once one is known.
  expect((await routes.GET({ params: { id } }).json()).board).toBeNull();
  const company = upsertCompany({ name: "Weave", domain: id });
  open()
    .query(
      "INSERT INTO boards (company_id, provider, url, key, created_at) VALUES (?, 'greenhouse', ?, 'gh:weave', ?)",
    )
    .run(company, "https://job-boards.greenhouse.io/weave", new Date().toISOString());
  expect((await routes.GET({ params: { id } }).json()).board).toBe("https://job-boards.greenhouse.io/weave");
});

test("with the extension the board has it open the form; without it, the default browser opens it unfilled", async () => {
  const { feature, setUrlOpener } = await import("./server.ts");
  const post = (feature.routes!["/api/apply/:id"] as { POST: (req: unknown) => Promise<Response> }).POST;
  const opened: string[] = [];
  setUrlOpener((url) => opened.push(url));
  try {
    const id = "doverco.example";
    const url = "https://app.dover.com/apply/Doverco/abc123";
    append(id, {
      actor: "board",
      kind: "signal",
      data: { company: "Doverco", kind: "posting", title: "Robotics Engineer" },
      source: { type: "page", url },
    });
    append(id, { actor: "board", kind: "decision", data: { action: "apply", url } });
    index.reindex(id);
    const withExt = await (await post({ params: { id }, json: async () => ({ url, ext: true }) })).json();
    expect(withExt.open).toEqual({ url, thread: id, role: url, company: "Doverco" });
    expect(opened).toEqual([]);
    const without = await (await post({ params: { id }, json: async () => ({ url }) })).json();
    expect(without.open).toBeUndefined();
    expect(without.toast).toContain("add the form filler");
    expect(opened).toEqual([url]);
  } finally {
    setUrlOpener(null);
  }
});

test("Apply opens only a web page or a mail link: a file or another app's link opens nothing", async () => {
  const { feature, setUrlOpener } = await import("./server.ts");
  const post = (feature.routes!["/api/apply/:id"] as { POST: (req: unknown) => Promise<Response> }).POST;
  const opened: string[] = [];
  setUrlOpener((url) => opened.push(url));
  const roleAt = (id: string, url: string) => {
    append(id, {
      actor: "board",
      kind: "signal",
      data: { company: id, kind: "posting", title: "Robotics Engineer" },
      source: { type: "page", url },
    });
    append(id, { actor: "board", kind: "decision", data: { action: "apply", url } });
    index.reindex(id);
  };
  try {
    for (const url of ["file:///Applications/Calculator.app", "vscode://file/etc/passwd"]) {
      const id = url.startsWith("file") ? "filelink.example" : "applink.example";
      roleAt(id, url);
      for (const ext of [false, true]) {
        const res = await post({ params: { id }, json: async () => ({ url, ext }) });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.toast).toContain("isn't a web page");
        expect(body.open).toBeUndefined();
      }
    }
    expect(opened).toEqual([]);
    const web = "https://jobs.example.com/roles/7";
    roleAt("weblink.example", web);
    const res = await post({ params: { id: "weblink.example" }, json: async () => ({ url: web }) });
    expect(res.status).toBe(200);
    expect(opened).toEqual([web]);
    // A mail link opens in the mail app, with the extension too: its tab can't open one.
    const mail = "mailto:jobs@maillink.example?subject=Robotics%20Engineer";
    roleAt("maillink.example", mail);
    for (const ext of [false, true]) {
      const body = await (
        await post({ params: { id: "maillink.example" }, json: async () => ({ url: mail, ext }) })
      ).json();
      expect(body.open).toBeUndefined();
      expect(body.toast).toContain("mail app");
    }
    expect(opened).toEqual([web, mail, mail]);
  } finally {
    setUrlOpener(null);
  }
});

test("when the extension doesn't answer Apply's open (it was reloading), the form opens unfilled all the same", async () => {
  const { startApply } = await import("./board.tsx");
  const sent: string[] = [];
  const posts: unknown[] = [];
  let toast = "";
  const g = globalThis as { chrome?: unknown };
  g.chrome = {
    runtime: {
      sendMessage: async (_id: string, msg: { type: string }) => {
        sent.push(msg.type);
        if (msg.type === "hello") return { build: "b" };
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
    },
  };
  try {
    const url = "https://jobs.example.org/apply/1";
    const ctx = {
      post: async (_path: string, body: { ext?: boolean }) => {
        posts.push(body);
        return Response.json(
          body.ext ? { open: { url, thread: "example.org" }, toast: "Opening" } : { toast: "Opened" },
        );
      },
      toast: (t: string) => {
        toast = t;
      },
      refetch: async () => {},
    } as unknown as Parameters<typeof startApply>[0];
    await startApply(ctx, "example.org", url);
    expect(sent).toEqual(["hello", "open"]);
    expect(posts).toEqual([{ url, ext: true }, { url }]);
    expect(toast).toBe("The extension didn't answer: the form opened unfilled");
  } finally {
    delete g.chrome;
  }
});

test("a dropped CV is kept in me/ under a safe name: PDFs only, never outside me/", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7 a CV");
  expect(cvName("../../etc/Sam Rivera CV.pdf")).toBe("Sam Rivera CV.pdf");
  expect(cvName("..\\.hidden/x.PDF")).toBe("x.pdf");
  expect(cvName(".bashrc")).toBe("bashrc.pdf");
  expect(cvName("résumé;rm -rf.pdf")).toBe("r_sum__rm -rf.pdf");
  expect(saveCv("../Sam's CV.pdf", pdf)).toBe("Sam_s CV.pdf");
  expect(readFileSync(paths.me("Sam_s CV.pdf"), "utf8")).toBe("%PDF-1.7 a CV");
  expect(() => saveCv("notes.pdf", new TextEncoder().encode("hello"))).toThrow("That isn't a PDF");
  // Its text file: matched to the PDF by name, plain text with jobs or schools in it, or refused.
  const { CV_TEXT_EXAMPLE } = await import("./applying.tsx");
  const text = (s: string) => new TextEncoder().encode(s);
  expect(() => saveCvText("Nobody.md", text(CV_TEXT_EXAMPLE))).toThrow("There's no Nobody.pdf yet");
  expect(() => saveCvText("Sam's CV.md", text("Just words."))).toThrow("No jobs or schools");
  expect(() => saveCvText("Sam's CV.md", text("## EDUCATION\0"))).toThrow("isn't a plain text file");
  expect(() => saveCvText("Sam's CV.md", new Uint8Array([0xff, 0xfe]))).toThrow("isn't a plain text file");
  expect(saveCvText("../../Sam's CV.txt", text(CV_TEXT_EXAMPLE))).toBe("Sam_s CV.md");
  expect(cvList().find((c) => c.name === "Sam_s CV.pdf")?.text).toEqual({ jobs: 2, schools: 1 });
  expect(() => removeCv("../profile.json")).toThrow("No such CV");
  removeCv("Sam_s CV.pdf");
  expect(pdfs()).not.toContain("Sam_s CV.pdf");
  expect(existsSync(paths.me("Sam_s CV.md"))).toBe(false);
});

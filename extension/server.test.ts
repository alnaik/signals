import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { answers } from "../apply/answers.ts";
import { append } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { refuse } from "../server/guard.ts";
import { startServer } from "../server/main.ts";
import { EXTENSION_ID, EXTENSION_KEY, EXTENSION_ORIGIN } from "./id.ts";
import { learnAll, read } from "./server.ts";

const data = tempData();
let app: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  app = await startServer({ port: 0 });
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ full_name: "Sam Rivera", email: "a@example.com" }),
  );
});
afterAll(() => {
  app.stop();
  data.cleanup();
});

const post = (body: unknown, headers: Record<string, string> = { origin: EXTENSION_ORIGIN }) =>
  fetch(`${app.url}api/ext/read`, { method: "POST", body: JSON.stringify(body), headers });

test("the pinned key gives the pinned extension ID", () => {
  // Chrome's rule: SHA-256 of the key, its first 32 hex digits read as a–p.
  const hash = new Bun.CryptoHasher("sha256").update(Buffer.from(EXTENSION_KEY, "base64")).digest("hex");
  const id = [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
  expect(id).toBe(EXTENSION_ID);
});

test("only the extension reaches its route: its origin, by POST, on this Mac", async () => {
  expect((await post({ tab: 1, url: "https://example.com/" })).status).toBe(200);
  expect((await post({ tab: 1 }, { origin: "https://evil.example" })).status).toBe(403);
  expect(
    (await post({ tab: 1 }, { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).status,
  ).toBe(403);
  expect((await post({ tab: 1 }, {})).status).toBe(403); // no origin: curl, or a GET
  const get = new Request("http://127.0.0.1:4317/api/ext/read", {
    headers: { host: "127.0.0.1:4317", origin: EXTENSION_ORIGIN },
  });
  expect(refuse(get, 4317)).toBe("not the Job Signal extension");
  // From another device, never, though config.toml has a [server] section and a login is sent.
  writeFileSync(
    paths.config(),
    '[server]\nallowed_hosts = ["mac.tail.ts.net"]\nallowed_logins = ["me@example.com"]\n',
  );
  const remote = new Request("http://127.0.0.1:4317/api/ext/read", {
    method: "POST",
    headers: { host: "mac.tail.ts.net", origin: EXTENSION_ORIGIN, "tailscale-user-login": "me@example.com" },
  });
  expect(refuse(remote, 4317)).toBe("unknown host");
  writeFileSync(paths.config(), "");
  // Its origin opens nothing else.
  const other = await fetch(`${app.url}api/threads/x.dev/decision`, {
    method: "POST",
    body: "{}",
    headers: { origin: EXTENSION_ORIGIN },
  });
  expect(other.status).toBe(403);
});

test("a read answers what to fill, with the CV when asked; what you typed is learned when the tab closes", async () => {
  const thread = "acme.com";
  append(thread, { actor: "ats", kind: "signal", data: { company: "Acme", kind: "posting", title: "SRE" } });
  writeFileSync(paths.me("cv.pdf"), "%PDF-1.4 test");
  writeFileSync(paths.me("answers.jsonl"), "");
  const questions = [
    { label: "First Name", name: "first", type: "text", required: true },
    { label: "Resume/CV", name: "resume", type: "file", required: true },
    { label: "Salary expectations", name: "sal", type: "text", required: false },
    { label: "Gender", name: "g", type: "radio", required: false, options: ["Woman", "Man"] },
  ];
  const url = "https://job-boards.greenhouse.io/acme/jobs/1";
  const r = (await (await post({ tab: 7, frame: 0, thread, url, questions, want_cv: true })).json()) as {
    fields: { label: string; kind: string; value: string }[];
    cv?: { name: string; data: string };
  };
  expect(r.fields.map((f) => [f.label, f.kind, f.value])).toEqual([
    ["First Name", "factual", "Sam"],
    ["Resume/CV", "file", "cv.pdf"],
    ["Salary expectations", "open", ""],
    ["Gender", "voluntary", ""],
  ]);
  expect(Buffer.from(r.cv!.data, "base64").toString()).toBe(readFileSync(paths.me("cv.pdf"), "utf8"));
  // What you typed and picked yourself (the extension marks it touched).
  const typed = questions.map((q) =>
    q.name === "sal"
      ? { ...q, value: "120k", touched: true }
      : q.name === "g"
        ? { ...q, value: "Woman", touched: true }
        : q,
  );
  const again = (await (await post({ tab: 7, frame: 0, thread, url, questions: typed })).json()) as object;
  expect(again).not.toHaveProperty("cv"); // not asked for
  expect(answers()).toEqual([]); // still on the page
  await post({ tab: 7, closed: true });
  expect(answers().map((a) => [a.question, a.answer, a.company])).toEqual([
    ["Salary expectations", "120k", "Acme"],
  ]);
});

test("a read asking for work history gets the attached CV's, from its Markdown twin; none without one", async () => {
  writeFileSync(paths.me("cv.pdf"), "%PDF-1.4 test");
  writeFileSync(
    paths.me("cv.md"),
    "# A\n\n## EXPERIENCE\n\n**Acme** | Boulder, CO\n**SRE** | Jan 2020 - Present\n- Ran things.\n\n## EDUCATION\n\n**CU Boulder** | B.S. Computer Science\n",
  );
  const url = "https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/X/apply/applyManually";
  const ask = async (want_history?: boolean) =>
    (await (await post({ tab: 21, frame: 0, url, questions: [], want_history })).json()) as {
      history?: { work: { company: string; title: string }[]; education: { school: string }[] };
    };
  const r = await ask(true);
  expect(r.history?.work.map((j) => [j.company, j.title])).toEqual([["Acme", "SRE"]]);
  expect(r.history?.education.map((e) => e.school)).toEqual(["CU Boulder"]);
  expect(await ask()).not.toHaveProperty("history"); // not asked for
  rmSync(paths.me("cv.md"));
  expect(await ask(true)).not.toHaveProperty("history"); // no twin: nothing, never another source
  await post({ tab: 21, closed: true });
});

test("a tab Apply opened for a role gets that role's CV, whichever was picked last at the company", async () => {
  const thread = "basalt.dev";
  append(thread, {
    actor: "ats",
    kind: "signal",
    data: { company: "Basalt", kind: "posting", title: "SRE" },
  });
  writeFileSync(paths.me("cv.pdf"), "%PDF-1.4 cv");
  writeFileSync(paths.me("other.pdf"), "%PDF-1.4 other");
  const [sre, data] = ["https://basalt.dev/jobs/sre", "https://basalt.dev/jobs/data"];
  const { pickPdf } = await import("../apply/prepare.ts");
  pickPdf(thread, sre, "other.pdf");
  pickPdf(thread, data, "cv.pdf");
  const questions = [{ label: "Resume/CV", name: "resume", type: "file", required: true }];
  const cv = async (role?: string) => {
    const r = (await (
      await post({
        tab: 22,
        frame: 0,
        thread,
        role,
        url: "https://basalt.dev/apply",
        questions,
        want_cv: true,
      })
    ).json()) as { cv?: { name: string } };
    return r.cv?.name ?? null;
  };
  expect([await cv(sre), await cv(data), await cv()]).toEqual(["other.pdf", "cv.pdf", null]);
  await post({ tab: 22, closed: true });
  rmSync(paths.me("other.pdf"));
});

test("a LinkedIn page is never filled", async () => {
  const r = await post({
    tab: 8,
    url: "https://www.linkedin.com/jobs/view/1",
    questions: [{ label: "First Name", name: "f", type: "text", required: true }],
  });
  expect(await r.json()).toEqual({ fields: [] });
});

const salary = { label: "Salary expectations", name: "sal", type: "text", required: false };
const said = (answer: string) => answers().filter((a) => a.answer === answer);

test("when the board stops, what every open form holds is learned, once", () => {
  writeFileSync(paths.me("answers.jsonl"), "");
  read({
    tab: 25,
    frame: 0,
    url: "https://careers.zeta.dev/apply",
    questions: [{ ...salary, value: "170k", touched: true }],
  });
  expect(learnAll()).toBeGreaterThanOrEqual(1);
  expect(said("170k")).toHaveLength(1);
  read({ tab: 25, closed: true });
  expect(said("170k")).toHaveLength(1);
});

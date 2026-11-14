/// <reference types="chrome" />
// The built extension in a real Chromium, against the board's real server: forms are served as if
// from Greenhouse and a company's site, without a network.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page, Worker } from "playwright";
import { answers } from "../apply/answers.ts";
import { append } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { startServer } from "../server/main.ts";
import { buildExtension, setBuildDir } from "./build.ts";
import { EXTENSION_ID } from "./id.ts";

const data = tempData();
const dir = mkdtempSync(path.join(os.tmpdir(), "jobsignal-ext-"));
const ext = path.join(dir, "ext");
let app: Awaited<ReturnType<typeof startServer>>;
let context: BrowserContext;
let worker: Worker;
const pages = new Map<string, string>(); // url → html
// The sites, served from this machine: Chromium resolves their names to it (a tab the extension
// opens isn't routed by Playwright, so this keeps every request off the network).
const sites = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const u = new URL(req.url);
    const html = pages.get(`http://${req.headers.get("host")}${u.pathname}`) ?? "<p>none</p>";
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});
const site = (host: string, p: string) => `http://${host}:${sites.port}${p}`;
const HOSTS = [
  "job-boards.greenhouse.io",
  "careers.acme.com",
  "forms.example.net",
  "jobs.example.net",
  "ads.example.com",
  "acme.wd5.myworkdayjobs.com",
];

beforeAll(async () => {
  app = await startServer({ port: 0 });
  await buildExtension(Number(new URL(app.url).port), ext);
  setBuildDir(ext);
  const { chromium } = await import("playwright");
  context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(", ")}`,
      "--disable-features=HttpsUpgrades",
    ],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}, 60_000);
afterAll(async () => {
  await context?.close();
  app.stop();
  sites.stop(true);
  setBuildDir(null);
  rmSync(dir, { recursive: true, force: true });
  data.cleanup();
});

/** The board asks the extension to open a role, as Apply does; the tab that opens. */
async function applyFor(thread: string, url: string): Promise<Page> {
  const board = await context.newPage();
  await board.goto(app.url);
  const opened = context.waitForEvent("page");
  const ok = await board.evaluate(
    ([id, u, t]) =>
      (globalThis as unknown as { chrome: typeof chrome }).chrome.runtime.sendMessage(id!, {
        type: "open",
        url: u,
        thread: t,
      }),
    [EXTENSION_ID, url, thread],
  );
  expect(ok).toEqual({ ok: true });
  await board.close();
  const page = await opened;
  await page.waitForLoadState();
  return page;
}

/** You click the toolbar button on this page: what chrome.action.onClicked does, run in the worker (a test can't click the toolbar). */
async function clickFill(url: string): Promise<void> {
  await worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.storage.session.set({ [`click:${tab!.id}`]: new URL(u).hostname });
    await chrome.scripting.executeScript({
      target: { tabId: tab!.id!, allFrames: true },
      files: ["content.js"],
    });
  }, url);
}

// A react-select-like box: once open, the input lists matching options as you type; a pick shows
// beside it and empties the input. As Greenhouse's react-select, it opens on a click on its box,
// mousedown to click (or your own typing), not on a script's typing or a mousedown alone, and the
// input names its list (aria-controls).
const combo = (id: string, label: string, options: string[]) => `
  <label id="${id}-label" for="${id}">${label}*</label>
  <div class="select__control"><div class="select__value-container">
    <input id="${id}" role="combobox" aria-labelledby="${id}-label" aria-controls="${id}-menu" value="">
  </div></div>
  <div id="${id}-menu"></div>
  <script>(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    const menu = document.getElementById(${JSON.stringify(`${id}-menu`)});
    const box = input.closest(".select__control");
    let open = false;
    let down = false;
    box.addEventListener("mousedown", () => { down = true; });
    box.addEventListener("click", () => { open = down; down = false; });
    input.addEventListener("input", (e) => {
      menu.innerHTML = "";
      open ||= e.isTrusted;
      if (!open) return;
      const q = input.value.toLowerCase();
      for (const o of ${JSON.stringify(options)}) {
        if (!q || !o.toLowerCase().includes(q)) continue;
        const d = document.createElement("div");
        d.setAttribute("role", "option");
        d.textContent = o;
        d.onclick = () => {
          const v = input.closest(".select__control").querySelector(".select__value-container");
          v.querySelector(".select__single-value")?.remove();
          const s = document.createElement("div");
          s.className = "select__single-value";
          s.textContent = o;
          v.prepend(s);
          input.value = "";
          menu.innerHTML = "";
          open = false;
        };
        menu.append(d);
      }
    });
  })();</script>`;

/** What `get` returns once it equals `want`, or what it returned last after 10 s. */
async function until<T>(get: () => Promise<T> | T, want: T): Promise<T> {
  let last = await get();
  for (let i = 0; i < 100 && JSON.stringify(last) !== JSON.stringify(want); i++) {
    await Bun.sleep(100);
    last = await get();
  }
  return last;
}

const shown = (page: Page, id: string) =>
  page.evaluate(
    (i) =>
      document.getElementById(i)?.closest(".select__control")?.querySelector(".select__single-value")
        ?.textContent ?? "",
    id,
  );

test("a role Apply opens fills from the profile, the bank and the CV; what you type is learned when the tab closes", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({
      full_name: "Sam Rivera",
      email: "a@example.com",
      phone: "555",
      location: "Portland, OR",
      needs_sponsorship: true,
    }),
  );
  writeFileSync(paths.me("cv.pdf"), "%PDF-1.4 test");
  writeFileSync(
    paths.me("answers.jsonl"),
    `${JSON.stringify({ ts: "t", type: "relocation", question: "Relocate?", company: "Other", answer: "Unsure" })}\n`,
  );
  append("larkspurfreight.com", {
    actor: "ats",
    kind: "signal",
    data: { company: "Larkspur Freight", kind: "posting", title: "SRE" },
  });
  const url = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/1");
  pages.set(
    url,
    `<form onsubmit="event.preventDefault()">
      <label for="f">Legal First Name</label><input id="f">
      <label for="m">Email</label><input id="m" value="kept@example.com">
      <label for="p">Phone</label><input id="p" style="display:none">
      <label for="cv">Resume/CV</label><input id="cv" type="file" style="opacity:0">
      <label for="g">Gender</label><input id="g">
      <fieldset><legend>Would you be willing to relocate?</legend>
        <input type="radio" id="r1" name="rel"><label for="r1">Yes</label>
        <input type="radio" id="r2" name="rel"><label for="r2">Unsure</label></fieldset>
      ${combo("loc", "Location (City)", ["Portland, Maine, United States", "Portland, Oregon, United States"])}
      ${combo("hear", "How did you hear about this job?", ["LinkedIn", "Referral"])}
      <label for="sal">Salary expectations</label><input id="sal">
      <button>Submit application</button></form>`,
  );
  const page = await applyFor("larkspurfreight.com", url);
  await page.waitForFunction(() => (document.getElementById("f") as HTMLInputElement).value === "Sam");
  await page.waitForFunction(() => (document.getElementById("cv") as HTMLInputElement).files?.length === 1);
  expect(await page.evaluate(() => (document.getElementById("cv") as HTMLInputElement).files![0]!.name)).toBe(
    "cv.pdf",
  );
  await page.waitForFunction(() => (document.getElementById("r2") as HTMLInputElement).checked);
  const city = "Portland, Oregon, United States";
  expect(await until(() => shown(page, "loc"), city)).toBe(city);
  expect(await page.inputValue("#m")).toBe("kept@example.com"); // never overwrites
  expect(await page.inputValue("#p")).toBe(""); // hidden: not yours to fill
  expect(await page.inputValue("#g")).toBe(""); // voluntary questions are yours
  expect(await shown(page, "hear")).toBe(""); // nothing known yet

  // You answer what was left, and leave.
  await page.fill("#hear", "Link");
  await page.getByRole("option", { name: "LinkedIn" }).click();
  await page.locator("#sal").pressSequentially("120k");
  await page.waitForTimeout(800); // your typing reaches the board
  await page.close();
  const learned = [
    ["Relocate?", "Unsure", "Other"],
    ["How did you hear about this job?", "LinkedIn", "Larkspur Freight"],
    ["Salary expectations", "120k", "Larkspur Freight"],
  ];
  expect(await until(() => answers().map((a) => [a.question, a.answer, a.company]), learned)).toEqual(
    learned,
  );

  // The next company's form asks again: it fills from the bank, in the company's own site's frame.
  append("acme.com", {
    actor: "ats",
    kind: "signal",
    data: { company: "Acme", kind: "posting", title: "SRE" },
  });
  const frame = site("job-boards.greenhouse.io", "/embed/acme");
  pages.set(frame, `<form>${combo("hear2", "How did you hear about us?", ["Job board", "LinkedIn"])}</form>`);
  pages.set(site("careers.acme.com", "/jobs/2"), `<h1>Acme</h1><iframe src="${frame}"></iframe>`);
  const next = await applyFor("acme.com", site("careers.acme.com", "/jobs/2"));
  const inner = next.frameLocator("iframe");
  const picked = () =>
    inner
      .locator(".select__single-value")
      .textContent({ timeout: 500 })
      .catch(() => "");
  expect(await until(picked, "LinkedIn")).toBe("LinkedIn");
  await next.close();
}, 60_000);

test("another company's form on the same job board, reached from the role's, fills nothing and attaches nothing until you say Fill", async () => {
  const other = site("job-boards.greenhouse.io", "/otherco/jobs/3");
  pages.set(
    other,
    `<form><label for="f">First Name</label><input id="f">
      <label for="cv">Resume/CV</label><input id="cv" type="file"></form>`,
  );
  const url = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/11");
  pages.set(url, `<p>Moving on</p><script>location.href = ${JSON.stringify(other)}</script>`);
  const page = await applyFor("larkspurfreight.com", url);
  await page.waitForURL(other);
  const notice = () => page.frames().find((f) => f.url().includes("/notice.html#"));
  const say = () =>
    notice()
      ?.locator("#say")
      .textContent({ timeout: 500 })
      .catch(() => "") ?? "";
  const asked =
    "This form is for otherco on job-boards.greenhouse.io, not larkspurfreight.com. Fill it anyway?";
  expect(await until(say, asked)).toBe(asked);
  const cv = () =>
    page.evaluate(() => (document.getElementById("cv") as HTMLInputElement).files?.length ?? 0);
  expect(await page.inputValue("#f")).toBe("");
  expect(await cv()).toBe(0);
  // The page can't reach into the notice: it sits in a closed shadow root, at the extension's own address.
  expect(
    await page.evaluate(() => document.querySelector("job-signal-notice")?.shadowRoot ?? null),
  ).toBeNull();

  await page.waitForTimeout(600); // the button has been in plain view a moment, as for a person reading it
  await notice()!.getByRole("button", { name: "Fill" }).click();
  await page.waitForFunction(() => (document.getElementById("f") as HTMLInputElement).value === "Sam");
  expect(await until(cv, 1)).toBe(1);
  expect(await until(() => !!notice(), false)).toBe(false);
  await page.close();
}, 30_000);

test("a page no Apply opened is left alone until you click Fill; a sign-in is never filled", async () => {
  const url = site("forms.example.net", "/apply");
  pages.set(url, '<form><label for="n">First Name</label><input id="n"></form>');
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForTimeout(1500);
  expect(await page.inputValue("#n")).toBe("");
  await clickFill(url);
  await page.waitForFunction(() => (document.getElementById("n") as HTMLInputElement).value === "Sam");

  const signin = site("forms.example.net", "/login");
  pages.set(
    signin,
    '<form><label for="e">Email</label><input id="e"><label for="pw">Password</label><input id="pw" type="password"></form>',
  );
  await page.goto(signin);
  await page.waitForTimeout(1500);
  expect(await page.inputValue("#e")).toBe("");
  await page.close();
}, 60_000);

test("only the board's own page reaches the extension, and only with a company for a thread", async () => {
  const form = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/9");
  pages.set(form, '<form><label for="f">First Name</label><input id="f"></form>');
  const ask = (page: Page, thread: string) =>
    page.evaluate(
      ([id, u, t]) => {
        const rt = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.runtime;
        if (!rt?.sendMessage) return null;
        return rt.sendMessage(id!, { type: "open", url: u, thread: t }).then(
          (r) => r ?? null,
          () => null,
        );
      },
      [EXTENSION_ID, form, thread],
    );
  const tabs = context.pages().length;
  // A page on another port of this Mac (a dev server, anything): the extension never hears it.
  pages.set(site("127.0.0.1", "/other"), "<p>another local server</p>");
  const other = await context.newPage();
  await other.goto(site("127.0.0.1", "/other"));
  expect(await ask(other, "larkspurfreight.com")).toBeNull();
  await other.close();
  // The board's own page, with a thread that isn't a company domain: no tab opens.
  const board = await context.newPage();
  await board.goto(app.url);
  expect(await ask(board, "../me")).toBeNull();
  await board.close();
  await Bun.sleep(500);
  expect(context.pages().length).toBe(tabs);
}, 30_000);

test("a page you clicked Fill on fills its own site's frames and job boards', never another site's", async () => {
  const email = (id: string) => `<form><label for="${id}">Email</label><input id="${id}"></form>`;
  pages.set(site("jobs.example.net", "/embed"), email("e"));
  pages.set(site("ads.example.com", "/frame"), email("e"));
  const url = site("forms.example.net", "/careers");
  pages.set(
    url,
    `<h1>Careers</h1><iframe src="${site("jobs.example.net", "/embed")}"></iframe>
     <iframe src="${site("ads.example.com", "/frame")}"></iframe>`,
  );
  const page = await context.newPage();
  await page.goto(url);
  await clickFill(url);
  const value = (host: string) =>
    page
      .frames()
      .find((f) => f.url().includes(host))!
      .evaluate(() => (document.getElementById("e") as HTMLInputElement).value);
  expect(await until(() => value("jobs.example.net"), "a@example.com")).toBe("a@example.com");
  expect(await value("ads.example.com")).toBe("");
  await page.close();
}, 30_000);

test("a field you can't see, or named only by its placeholder or name, is never filled; a hidden file input still takes the CV", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({
      full_name: "Sam Rivera",
      email: "a@example.com",
      phone: "555",
      location: "Portland, OR",
      website: "https://samrivera.example",
      linkedin: "https://linkedin.com/in/sam-rivera-example",
    }),
  );
  const url = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/3");
  pages.set(
    url,
    `<form>
      <label for="f">First Name</label><input id="f">
      <input name="website" id="hp" autocomplete="off" style="position:absolute;left:-9999px">
      <label for="tab">Phone</label><input id="tab" tabindex="-1">
      <div aria-hidden="true"><label for="ah">Last Name</label><input id="ah"></div>
      <label for="op">Email</label><input id="op" style="opacity:0">
      <input id="ph" placeholder="LinkedIn">
      <label for="cv">Resume</label><input id="cv" type="file" style="opacity:0">
    </form>`,
  );
  const page = await applyFor("larkspurfreight.com", url);
  await page.waitForFunction(() => (document.getElementById("f") as HTMLInputElement).value === "Sam");
  await page.waitForFunction(() => (document.getElementById("cv") as HTMLInputElement).files?.length === 1);
  const left = await page.evaluate(() =>
    ["hp", "tab", "ah", "op", "ph"].map((id) => (document.getElementById(id) as HTMLInputElement).value),
  );
  expect(left).toEqual(["", "", "", "", ""]);
  await page.close();
}, 30_000);

test("only what you typed or picked yourself is learned, and a page you clicked Fill on keeps it as its own site's", async () => {
  writeFileSync(paths.me("answers.jsonl"), "");
  const url = site("forms.example.net", "/quiz");
  pages.set(
    url,
    `<form>
      <fieldset><legend>Have you ever been convicted of a felony?</legend>
        <input type="radio" name="fel" id="y"><label for="y">Yes</label>
        <input type="radio" name="fel" id="n"><label for="n">No</label></fieldset>
      <label for="w">Why are you interested in this role?</label><textarea id="w"></textarea>
      <label for="sal">Salary expectations</label><input id="sal">
    </form>
    <script>setTimeout(() => { y.checked = true; w.value = "written by the page"; }, 300)</script>`,
  );
  const page = await context.newPage();
  await page.goto(url);
  await clickFill(url);
  await page.waitForTimeout(800);
  await page.locator("#sal").pressSequentially("150k");
  await page.waitForTimeout(800); // your typing reaches the board
  await page.close();
  const learned = [["Salary expectations", "150k", "example"]];
  const got = () => answers().map((a) => [a.question, a.answer, a.company]);
  expect(await until(got, learned)).toEqual(learned);
}, 30_000);

test("a dropdown whose options are buttons that would submit the form is never clicked", async () => {
  writeFileSync(
    paths.me("answers.jsonl"),
    `${JSON.stringify({ ts: "t", type: "referral", question: "How did you hear about us?", company: "Other", answer: "LinkedIn" })}\n`,
  );
  const url = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/5");
  pages.set(
    url,
    `<form onsubmit="event.preventDefault(); document.title = 'submitted'">
      <label for="h">How did you hear about us?</label>
      <input id="h" role="combobox" aria-controls="menu"><div id="menu"></div></form>
     <script>h.addEventListener("input", () => {
       menu.innerHTML = '<button role="option">LinkedIn</button><button role="option">Other</button>';
     });</script>`,
  );
  const page = await applyFor("larkspurfreight.com", url);
  // It types, finds only options that would submit, and leaves the box as it was.
  await page.waitForFunction(() => (document.getElementById("menu") as HTMLElement).childElementCount > 0);
  const cleared = () => (document.getElementById("h") as HTMLInputElement).value === "";
  await page.waitForFunction(cleared, undefined, { timeout: 10_000 });
  expect(await page.title()).not.toBe("submitted");
  await page.close();
}, 30_000);

test("a password showing in any frame of the tab is a sign-in: nothing in the tab fills until it's gone", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ full_name: "Sam Rivera", email: "a@example.com" }),
  );
  const login = site("job-boards.greenhouse.io", "/login");
  pages.set(login, '<form><label for="pw">Password</label><input id="pw" type="password"></form>');
  const url = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/10");
  pages.set(url, `<form><label for="e">Email</label><input id="e"></form><iframe src="${login}"></iframe>`);
  const page = await applyFor("larkspurfreight.com", url);
  await page.waitForTimeout(2000);
  expect(await page.inputValue("#e")).toBe("");
  // Signed in, the frame goes: the form fills, though its own fields never changed.
  await page.evaluate(() => document.querySelector("iframe")!.remove());
  expect(await until(() => page.inputValue("#e"), "a@example.com")).toBe("a@example.com");
  await page.close();
}, 30_000);

// Greenhouse's "Autofill my application", outside the form: pressed, it fills from MyGreenhouse a
// field at a time over a few seconds (here: First Name, a new Degree question, Salary), as `steps`.
// The page's script wires the button `wired` ms after load (a press before that does nothing).
const autofill = (steps: string, wired = 0) => `
  <button type="button" class="btn btn--rectangle btn--secondary" id="auto">Autofill my application</button>
  <form><label for="f">First Name</label><input id="f">
    <label for="l">Last Name</label><input id="l">
    <label for="sal">Salary expectations</label><input id="sal"><button>Submit application</button></form>
  <script>
    window.presses = 0;
    window.clicks = 0;
    window.early = false; // did anything else fill before the autofill was done?
    const set = (id, v) => {
      const i = document.getElementById(id);
      i.value = v;
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const step = (ms, run) => setTimeout(() => { if (l.value) early = true; run(); }, ms);
    auto.addEventListener("click", () => clicks++);
    addEventListener("load", () =>
      setTimeout(() => auto.addEventListener("click", () => { presses++; ${steps} }), ${wired}));
  </script>`;

test("when Greenhouse's autofill shows a sign-in, nothing fills", async () => {
  const url = site("job-boards.greenhouse.io", "/larkspurfreight/jobs/15");
  pages.set(
    url,
    autofill(`step(300, () => document.body.insertAdjacentHTML("beforeend",
      '<form><label for="pw">Password</label><input id="pw" type="password"></form>'));`),
  );
  const page = await applyFor("larkspurfreight.com", url);
  await page.waitForFunction(() => document.getElementById("pw"));
  await page.waitForTimeout(4000);
  expect([await page.inputValue("#f"), await page.inputValue("#l")]).toEqual(["", ""]);
  await page.close();
}, 30_000);

// A Workday dropdown, as its page draws it: a button whose text is the pick, an unlabeled text input
// beside it, and a list drawn at the end of the page once a click opens it (aria-controls names it),
// "Select One" first. A click on an option picks it and closes the list. `named`: its label, or
// the questionnaire's fieldset legend (a hashed id). The page counts each time a list opens.
const workdayDropdown = (id: string, named: string, options: string[], legend = false) => {
  const button = `<div><button type="button" aria-haspopup="listbox" aria-expanded="false" id="${id}"
    name="${id}" aria-label="Select One Required">Select One</button><input type="text" value=""></div>`;
  return `${
    legend
      ? `<fieldset><legend>${named}*</legend>${button}</fieldset>`
      : `<label for="${id}">${named}*</label>${button}`
  }<script>(() => {
    const b = document.getElementById(${JSON.stringify(id)});
    const close = () => {
      document.getElementById(b.id + "-list")?.remove();
      b.setAttribute("aria-expanded", "false");
      b.removeAttribute("aria-controls");
    };
    b.addEventListener("keydown", (e) => e.key === "Escape" && close());
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-expanded") === "true") return close();
      window.lists = (window.lists ?? 0) + 1;
      const ul = document.createElement("ul");
      ul.id = b.id + "-list";
      ul.setAttribute("role", "listbox");
      for (const o of ["Select One", ...${JSON.stringify(options)}]) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.textContent = o;
        li.onclick = () => {
          b.textContent = o;
          b.setAttribute("aria-label", o + " Required");
          close();
        };
        ul.append(li);
      }
      setTimeout(() => {
        document.body.append(ul);
        b.setAttribute("aria-expanded", "true");
        b.setAttribute("aria-controls", ul.id);
      }, 100);
    });
  })();</script>`;
};

test("Workday's dropdowns are opened and picked with what fits; its header's menus are never opened", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ full_name: "Sam Rivera", phone: "555", country: "United States of America" }),
  );
  writeFileSync(
    paths.me("answers.jsonl"),
    [
      {
        ts: "t",
        type: "referral",
        question: "How did you hear about us?",
        company: "Other",
        answer: "LinkedIn",
      },
      { ts: "t", type: "q:are you over 18", question: "Are you over 18?", company: "Other", answer: "Yes" },
    ]
      .map((a) => JSON.stringify(a))
      .join("\n"),
  );
  const url = site("acme.wd5.myworkdayjobs.com", "/en-US/Acme/job/Portland/SRE_1/apply/applyManually");
  pages.set(
    url,
    `<header><button type="button" aria-haspopup="listbox" data-automation-id="languageSelectorButton"
      id="lang" onclick="window.menus = (window.menus ?? 0) + 1">English</button></header>
    <div data-automation-id="applyFlowPage">
      <label for="legalName--firstName">First Name*</label><input id="legalName--firstName" name="legalName--firstName">
      ${workdayDropdown("source--source", "How Did You Hear About Us?", ["Job Board", "LinkedIn", "Referral"])}
      ${workdayDropdown("countryRegion--country", "Country", ["Canada", "United States of America"])}
      ${workdayDropdown("a1b2c3", "Are you over 18?", ["Yes", "No"], true)}
      ${workdayDropdown("d4e5f6", "Do you hold a clearance?", ["Yes", "No"], true)}
      ${workdayDropdown("phoneNumber--phoneType", "Phone Device Type", ["Fax", "Landline", "Mobile", "Pager"])}
      <div data-automation-id="formField-countryPhoneCode">
        <label for="phoneNumber--countryPhoneCode">Country Phone Code*</label>
        <div data-automation-id="multiSelectContainer"><ul data-automation-id="selectedItemList" role="listbox">
          <li role="presentation"><div data-automation-id="selectedItem" role="option">
            <p data-automation-id="promptOption">United States of America (+1)</p></div></li></ul>
          <input id="phoneNumber--countryPhoneCode" data-automation-id="searchBox" placeholder="Search"
            oninput="window.typedCode = true"></div></div>
    </div>`,
  );
  const page = await applyFor("larkspurfreight.com", url);
  const text = (id: string) => page.evaluate((i) => document.getElementById(i)!.textContent, id);
  expect(await until(() => text("a1b2c3"), "Yes")).toBe("Yes");
  expect(await text("source--source")).toBe("LinkedIn");
  expect(await text("countryRegion--country")).toBe("United States of America");
  expect(await text("d4e5f6")).toBe("Select One"); // nothing known: never opened
  expect(await page.inputValue("#legalName--firstName")).toBe("Sam");
  const counts = () =>
    page.evaluate(() => {
      const w = window as unknown as { lists?: number; menus?: number };
      return {
        lists: w.lists ?? 0,
        menus: w.menus ?? 0,
        open: document.querySelectorAll("[role=listbox]:not([data-automation-id=selectedItemList])").length,
      };
    });
  // Opened once each with an answer, Phone Device Type as Mobile; Country Phone Code, which shows
  // its pick, is never typed into. The pick is waited for first: the count reaches 4 on the fourth
  // click, 100 ms before that list is drawn, when nothing is open and nothing is picked yet.
  expect(await until(() => text("phoneNumber--phoneType"), "Mobile")).toBe("Mobile");
  expect(await until(counts, { lists: 4, menus: 0, open: 0 })).toEqual({ lists: 4, menus: 0, open: 0 });
  expect(await page.inputValue("#phoneNumber--countryPhoneCode")).toBe("");
  expect(await page.evaluate(() => (window as unknown as { typedCode?: boolean }).typedCode ?? false)).toBe(
    false,
  );
  await page.close();
}, 30_000);

// Workday's "My Experience", as measured on a large employer's: a section per kind of history, its heading over
// an Add button; Add draws an entry whose fields' ids start workExperience-N-- or education-N-- (N
// not in order), with a Delete inside. Its date parts (role=spinbutton) keep their own value, as a
// React input does: one set as `.value =` from the page is put back at the next input event, one set
// through HTMLInputElement's own setter holds (as is any set from the extension's own world). "I currently work here" takes the To date away. The degree is a dropdown.
// `existing`: a work entry already there (yours, or Workday's reading of the CV).
// A second employer's, as measured: each section a group labelled by its h4 (aria-labelledby="Education-section"),
// the work section "Professional Experience" (its entries "Professional Experience 1"), Add reading
// "Add Another" once there's an entry, and more sections with an Add (Languages, Portfolio with an
// entry of its own); a school is education-N--schoolName, a degree dropdown, a field of study search
// box and its first and last year attended (year parts), no GPA.
const SECOND_SECTIONS = `
    <div role="group" aria-labelledby="Languages-section"><h4 id="Languages-section">Languages</h4>
      <button type="button" data-automation-id="add-button" onclick="pressed.push('Languages')">Add</button></div>
    <div role="group" aria-labelledby="Skills-section"><h4 id="Skills-section">Skills</h4>
      <label for="skills--skills">Type to Add Skills</label>
      <input id="skills--skills" data-automation-id="searchBox" placeholder="Search"></div>
    <div role="group" aria-labelledby="Portfolio-section"><h4 id="Portfolio-section">Portfolio</h4>
      <div role="group"><h5>Portfolio 1</h5><label for="webAddress-1--url">URL</label><input id="webAddress-1--url"></div>
      <button type="button" data-automation-id="add-button" onclick="pressed.push('Portfolio')">Add Another</button></div>
    <div role="group" aria-labelledby="Resume/CV-section"><h4 id="Resume/CV-section">Resume/CV</h4></div>`;
const myExperience = (existing = "", second = false) => {
  const section = (name: string, inner: string, add: string) =>
    second
      ? `<div role="group" aria-labelledby="${name.replace(/ /g, "-")}-section"><h4 id="${name.replace(/ /g, "-")}-section">${name}</h4>${inner}
        <button type="button" data-automation-id="add-button" onclick="${add}">Add</button></div>`
      : `<div role="group"><h3>${name}</h3>${inner}
        <button type="button" data-automation-id="add-button" onclick="${add}">Add</button></div>`;
  return `
  <div data-automation-id="applyFlowPage"><h2>My Experience</h2>
    ${section(second ? "Professional Experience" : "Work Experience", `<div id="work">${existing}</div>`, "addWork(this)")}
    ${section("Education", '<div id="schools"></div>', "addSchool(this)")}
    ${section("Certifications", "", "pressed.push('Certifications')")}
    ${
      second
        ? SECOND_SECTIONS
        : `<div role="group"><h3>Skills</h3><label for="skills--skills">Type to Add Skills</label>
      <input id="skills--skills" data-automation-id="searchBox" placeholder="Search"></div>`
    }
    <button type="button" data-automation-id="pageFooterNextButton" onclick="window.saved = true">Save and Continue</button>
  </div>
  <script>
    const second = ${second};
    window.pressed = [];
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    window.react = (el) => {
      let tracked = "", state = "";
      Object.defineProperty(el, "value", {
        configurable: true,
        get() { return native.get.call(this); },
        set(v) { tracked = String(v); native.set.call(this, v); },
      });
      el.addEventListener("input", () => {
        const now = native.get.call(el);
        if (now !== tracked) tracked = state = now;
        native.set.call(el, state);
      });
    };
    const ids = [6, 37, 38, 41, 52, 60, 77];
    const field = (id, label, tag = "input") =>
      '<label for="' + id + '">' + label + '</label><' + tag + ' id="' + id + '"></' + tag + '>';
    const date = (id, label) => '<div id="' + id + '"><span>' + label + '</span>' +
      '<input id="' + id + '-dateSectionMonth-input" role="spinbutton" aria-label="Month" aria-valuemin="1" aria-valuemax="12">' +
      '<input id="' + id + '-dateSectionYear-input" role="spinbutton" aria-label="Year"></div>';
    const entry = (box, html) => {
      box.insertAdjacentHTML("beforeend", html);
      const e = box.lastElementChild;
      e.querySelectorAll("[role=spinbutton]").forEach(react);
      e.querySelector("[data-automation-id=delete]").onclick = () => e.remove();
      return e;
    };
    const another = (add) => { if (second) add.textContent = "Add Another"; };
    window.addWork = (add) => setTimeout(() => {
      another(add);
      const n = ids.shift();
      const p = "workExperience-" + n + "--";
      const e = entry(work, '<div role="group"><h4>' + (second ? "Professional" : "Work") + ' Experience ' + (work.children.length + 1) + '</h4>' +
        '<button type="button" data-automation-id="delete">Delete</button>' +
        field(p + "jobTitle", "Job Title*") + field(p + "companyName", "Company*") + field(p + "location", "Location") +
        '<input type="checkbox" id="' + p + 'currentlyWorkHere"><label for="' + p + 'currentlyWorkHere">I currently work here</label>' +
        date(p + "startDate", "From*") + date(p + "endDate", "To*") +
        field(p + "roleDescription", "Role Description", "textarea") + "</div>");
      e.querySelector("[type=checkbox]").onchange = (ev) => ev.target.checked && document.getElementById(p + "endDate")?.remove();
    }, 100);
    const year = (id, label) => '<div id="' + id + '"><span>' + label + '</span>' +
      '<input id="' + id + '-dateSectionYear-input" role="spinbutton" aria-label="Year"></div>';
    window.addSchool = (add) => setTimeout(() => {
      another(add);
      const p = "education-" + ids.shift() + "--";
      const e = entry(schools, '<div role="group"><h4>Education ' + (schools.children.length + 1) + '</h4>' +
        '<button type="button" data-automation-id="delete">Delete</button>' +
        field(p + (second ? "schoolName" : "school"), "School or University*") +
        '<label for="' + p + 'degree">Degree*</label><button type="button" aria-haspopup="listbox" id="' + p + 'degree">Select One</button>' +
        '<label for="' + p + 'fieldOfStudy">Field of Study</label><input id="' + p + 'fieldOfStudy" data-automation-id="searchBox" placeholder="Search">' +
        (second
          ? year(p + "firstYearAttended", "From") + year(p + "lastYearAttended", "To (Actual or Expected)")
          : field(p + "gradeAverage", "Overall Result (GPA)")) + "</div>");
      const b = document.getElementById(p + "degree");
      b.onclick = () => {
        if (b.getAttribute("aria-expanded") === "true") return;
        const ul = document.createElement("ul");
        ul.id = p + "degree-list";
        ul.setAttribute("role", "listbox");
        for (const o of ["Select One", "High School Diploma", "Associate's Degree", "Bachelor of Arts", "Bachelor of Science", "Master's Degree"]) {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.textContent = o;
          li.onclick = () => { b.textContent = o; ul.remove(); b.setAttribute("aria-expanded", "false"); };
          ul.append(li);
        }
        document.body.append(ul);
        b.setAttribute("aria-expanded", "true");
        b.setAttribute("aria-controls", ul.id);
      };
    }, 100);
  </script>`;
};

// The chosen CV's Markdown twin, in its shape: a current job, a job with a sentence, a link and a
// tech line, a freelance line with no company, then Projects (never work history) and Education.
const CV_MD = `# SAM RIVERA
Portland, OR | (555) 555-0100 | a@example.com

## EXPERIENCE

**Larkspur Freight Co.** | Seattle, WA (Remote)
**Platform Engineer** | Jul 2025 - Present
- Built the dispatch team's route search.
- Run the company website.

**Brightwater Apps** | Portland, OR | github.com/samrivera-example/tide-app
**Mobile Developer** | Aug 2023 - Apr 2024
Offline-first tide chart app.
- Wrote the sync layer.
*Swift, SwiftUI, SQLite*

**Freelance Web Developer** | Remote | 2020 - 2022
- Built sites for local shops.

## PROJECTS

**ledger-lite** | Command-line budgeting tool | Oct 2026 | github.com/samrivera-example/ledger-lite
- Not a job.

## EDUCATION

**Cascade State University** | B.S. Computer Science | GPA 3.71
`;

// Save and Continue, and any other section's Add.
const pressed = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { saved?: boolean; pressed: string[] };
    return { saved: !!w.saved, pressed: w.pressed };
  });

test("Workday's My Experience gets the chosen CV's work history and education once, in the CV's order; entries already there are left, and nothing is pressed or learned", async () => {
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ full_name: "Sam Rivera", location: "Portland, OR" }),
  );
  writeFileSync(paths.me("answers.jsonl"), "");
  writeFileSync(paths.me("cv.pdf"), "%PDF-1.4 test");
  writeFileSync(paths.me("cv.md"), CV_MD);
  const url = site("acme.wd5.myworkdayjobs.com", "/en-US/Acme/job/Portland/SRE_5/apply/applyManually");
  pages.set(url, myExperience());
  const page = await applyFor("larkspurfreight.com", url);
  // The stand-in's date part, as Workday's: `.value =` and an input event leave it empty.
  expect(
    await page.evaluate(() => {
      const i = document.createElement("input");
      (window as unknown as { react: (e: Element) => void }).react(i);
      i.value = "03";
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return i.value;
    }),
  ).toBe("");
  const schools = () => page.evaluate(() => document.querySelectorAll("[id$='--school']").length);
  expect(await until(schools, 1)).toBe(1);
  await page.waitForTimeout(1000);
  const values = (suffix: string) =>
    page.evaluate(
      (s) =>
        Array.from(document.querySelectorAll(`[id$="--${s}"]`)).map(
          (e) => (e as HTMLInputElement).value ?? e.textContent,
        ),
      suffix,
    );
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[id$='--jobTitle']")).map((e) => e.id.split("--")[0]),
  );
  expect(ids).toEqual(["workExperience-6", "workExperience-37", "workExperience-38"]);
  expect(await values("jobTitle")).toEqual([
    "Platform Engineer",
    "Mobile Developer",
    "Freelance Web Developer",
  ]);
  expect(await values("companyName")).toEqual(["Larkspur Freight Co.", "Brightwater Apps", ""]);
  expect(await values("location")).toEqual(["Seattle, WA (Remote)", "Portland, OR", "Remote"]);
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("[id$='--currentlyWorkHere']")).map(
        (e) => (e as HTMLInputElement).checked,
      ),
    ),
  ).toEqual([true, false, false]);
  expect(await values("startDate-dateSectionMonth-input")).toEqual(["07", "08", ""]);
  expect(await values("startDate-dateSectionYear-input")).toEqual(["2025", "2023", "2020"]);
  expect(await values("endDate-dateSectionMonth-input")).toEqual(["04", ""]); // the current job has no To
  expect(await values("endDate-dateSectionYear-input")).toEqual(["2024", "2022"]);
  expect(await values("roleDescription")).toEqual([
    "Built the dispatch team's route search.\nRun the company website.",
    "Offline-first tide chart app.\nWrote the sync layer.",
    "Built sites for local shops.",
  ]);
  expect(await values("school")).toEqual(["Cascade State University"]);
  expect(await page.evaluate(() => document.getElementById("education-41--degree")!.textContent)).toBe(
    "Bachelor of Science",
  );
  expect(await values("gradeAverage")).toEqual(["3.71"]);
  expect(await values("fieldOfStudy")).toEqual([""]); // a search box: yours
  expect(await pressed(page)).toEqual({ saved: false, pressed: [] });
  // You delete the entries: once per page load, so they don't come back.
  await page.evaluate(() => {
    for (const b of document.querySelectorAll<HTMLElement>("#work [data-automation-id=delete]")) b.click();
  });
  await page.waitForTimeout(2000);
  expect(await values("jobTitle")).toEqual([]);
  await page.close();

  // A work entry already there: left as it is, nothing added beside it; Education, empty, fills.
  const mine = site("acme.wd5.myworkdayjobs.com", "/en-US/Acme/job/Portland/SRE_6/apply/applyManually");
  pages.set(
    mine,
    myExperience(`<div role="group"><h4>Work Experience 1</h4>
      <label for="workExperience-3--jobTitle">Job Title*</label><input id="workExperience-3--jobTitle" value="Mine">
      <label for="workExperience-3--companyName">Company*</label><input id="workExperience-3--companyName"></div>`),
  );
  const next = await applyFor("larkspurfreight.com", mine);
  expect(
    await until(() => next.evaluate(() => document.querySelectorAll("[id$='--school']").length), 1),
  ).toBe(1);
  await next.waitForTimeout(1000);
  expect(
    await next.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          "[id^=workExperience-][id$='--jobTitle'], [id^=workExperience-][id$='--companyName']",
        ),
      ).map((e) => [e.id, (e as HTMLInputElement).value]),
    ),
  ).toEqual([
    ["workExperience-3--jobTitle", "Mine"],
    ["workExperience-3--companyName", ""],
  ]);
  await next.close();
  await Bun.sleep(1500); // the board learns what the tabs held
  expect(answers()).toEqual([]);
}, 60_000);

test("an Add button that would submit its form is never pressed; the other sections still fill", async () => {
  // The whole page in a form, and Work Experience's Add with no type: a submit button.
  const html = myExperience().replace(
    '<button type="button" data-automation-id="add-button" onclick="addWork(this)">',
    '<button data-automation-id="add-button" onclick="addWork(this)">',
  );
  expect(html).toContain('<button data-automation-id="add-button" onclick="addWork(this)">');
  const url = site("acme.wd5.myworkdayjobs.com", "/en-US/Acme/job/Portland/SRE_7/apply/applyManually");
  pages.set(url, `<form onsubmit="window.submitted = true; return false">${html}</form>`);
  const page = await applyFor("larkspurfreight.com", url);
  expect(
    await until(() => page.evaluate(() => document.querySelectorAll("[id$='--school']").length), 1),
  ).toBe(1);
  await page.waitForTimeout(1000);
  expect(
    await page.evaluate(() => ({
      work: document.querySelectorAll("[id^=workExperience-]").length,
      submitted: !!(window as unknown as { submitted?: boolean }).submitted,
    })),
  ).toEqual({ work: 0, submitted: false });
  expect(await pressed(page)).toEqual({ saved: false, pressed: [] });
  await page.close();
}, 30_000);

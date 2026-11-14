/// <reference types="chrome" />
// Runs in an application page in your own Chrome (each frame). The worker puts it only where it
// may fill: a tab Apply opened, on a job board or the company's own site, or a page where you
// clicked the button. Each pass first asks the worker whether this frame may be filled now: a form
// for another company than the one Apply opened the tab for fills nothing until you say so in the
// extension's own notice. It reads the form, asks the board what goes in each field, and fills
// each empty field once. It never presses Enter or clicks Submit, and fills nothing while a
// password field shows (that's your sign-in). What you type or pick yourself is sent back, marked as
// yours, so the board learns it; never what the page wrote by itself.
import type { History, Job, MonthYear, School } from "../../apply/me.ts";
import { comboOption, degreeOption, pickOption, type Question, readFormFields } from "../../apply/page.ts";

type Field = {
  label: string;
  kind: "factual" | "file" | "open" | "voluntary";
  value: string;
  options?: string[];
  combobox?: boolean;
};
type Reply = { fields?: Field[]; cv?: { name: string; data: string }; history?: History; signIn?: boolean };

const SUBMIT = /submit|send application|apply$/i;

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
// Laid out and not visibility:hidden: a password field that shows, a dropdown's options.
const visible = (el: Element) =>
  el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

/**
 * Can you see it and reach it? Laid out, big enough to see, on the page (not placed far off it),
 * not transparent, not under aria-hidden or inert, not out of the tab order. A field that isn't is
 * a trap for bots (a honeypot) or not yours: it is never filled.
 */
function shown(el: Element): boolean {
  if (!visible(el) || el.closest('[aria-hidden="true"], [inert]') || el.getAttribute("tabindex") === "-1")
    return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false;
  for (let e: Element | null = el; e; e = e.parentElement)
    if (Number(getComputedStyle(e).opacity) === 0) return false;
  return true;
}

// What you touched yourself (typed in, picked, clicked): only those answers are learned, never
// one the page wrote or ticked itself. A radio or a Yes/No button touches its question's box; a
// pick in a dropdown's list touches the dropdown (it keeps the focus while its list is open).
const touched = new WeakSet<Element>();
const CHOICE_BOX = 'fieldset, [role="radiogroup"], [role="group"], .ashby-application-form-field-entry';
function touch(e: Event): void {
  const t = e.target as Element | null;
  if (!t?.closest) return;
  touched.add(t);
  const box = t.closest('input[type="radio"], input[type="checkbox"], button[type="button"]')
    ? t.closest(CHOICE_BOX)
    : null;
  if (box) touched.add(box);
  const active = document.activeElement;
  if (active?.getAttribute("role") === "combobox") touched.add(active);
}
function isTouched(el: Element): boolean {
  if (touched.has(el)) return true;
  const input = el as HTMLInputElement;
  if (input.type !== "radio" && input.type !== "checkbox") return false;
  const box = el.closest(CHOICE_BOX);
  if (box && touched.has(box)) return true;
  const name = CSS.escape(input.name);
  return (
    !!input.name && Array.from(document.querySelectorAll(`input[name="${name}"]`)).some((r) => touched.has(r))
  );
}

/** Would clicking it submit or reset its form? A <button> with no type is a submit button. */
function submits(el: Element): boolean {
  const b = el.closest("button, input") as HTMLButtonElement | HTMLInputElement | null;
  return !!b?.form && ["submit", "reset", "image"].includes(b.type);
}

function ask(questions: Question[], wantCv = false, wantHistory = false): Promise<Reply> {
  return chrome.runtime
    .sendMessage({ type: "read", url: location.href, questions, want_cv: wantCv, want_history: wantHistory })
    .then((r: Reply | undefined) => r ?? {})
    .catch(() => ({}));
}

// The notice asking whether to fill another company's form: the extension's own page in a frame,
// inside a closed shadow root, so the page can't read it, click it or learn its address (it carries
// the worker's number for this form). It sits in the top layer, above anything the page draws in
// its own. Its buttons answer the worker, which takes it away.
let notice: HTMLElement | null = null;
function showNotice(nonce: string): void {
  if (notice?.isConnected) return;
  notice = document.createElement("job-signal-notice");
  notice.popover = "manual";
  notice.style.cssText =
    "position:fixed;inset:16px 16px auto auto;margin:0;padding:0;border:0;background:transparent;" +
    "width:380px;height:132px;overflow:visible";
  const frame = document.createElement("iframe");
  frame.src = `${chrome.runtime.getURL("notice.html")}#${nonce}`;
  frame.title = "Job Signal";
  frame.style.cssText =
    "width:100%;height:100%;border:0;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.25);" +
    "color-scheme:light;background:#fff";
  notice.attachShadow({ mode: "closed" }).append(frame);
  document.documentElement.append(notice);
  notice.showPopover();
}

/**
 * May this frame be filled now? The worker decides from the frame's real address, at every pass
 * (a form that moves to another site is asked about again). Another company's form shows the
 * notice, once there's a form to fill.
 */
async function allowed(): Promise<boolean> {
  const r = (await chrome.runtime.sendMessage({ type: "may" }).catch(() => null)) as {
    ok?: boolean;
    ask?: string;
  } | null;
  if (r?.ask && readFormFields(true).length) showNotice(r.ask);
  return r?.ok === true;
}

// Without elements: what crosses to the board is plain data, each answer you gave marked as yours.
const plain = (qs: (Question & { el?: Element })[]): Question[] =>
  qs.map(({ el, ...q }) => (el && isTouched(el) ? { ...q, touched: true } : q));

/** Start on the page; returns a pass, for the button to run again. */
function start(): () => void {
  // Each field is tried once, filled or not: a dropdown with no fitting option isn't typed into and
  // cleared again on every pass, a field you clear stays cleared, and one that held something
  // (yours, or the page's) is left for good. A new element in its place (a step drawn anew) is tried.
  const tried = new WeakSet<Element>();
  let cv: File | null = null;
  // The CV goes in once: attaching it can redraw the form (Greenhouse swaps the upload for the
  // file's name), and it never goes in another upload after that, nor again if you remove it.
  let attached = false;
  let pressed = false; // Greenhouse's own autofill: pressed once per page
  let historyDone = false; // Workday's work history and education: added once per page load
  let busy = false;
  let again = false; // the form changed during a pass: one more pass after it
  let shape = "";
  const signIn = () => Array.from(document.querySelectorAll("input[type=password]")).some(visible);
  // A sign-in held a pass back: another once it's gone. Signing in may only hide it and show the
  // form (styles change, no element comes or goes, so the form's shape starts no pass), so this
  // looks each second; when the sign-in is in another frame (the worker said so), every 2 s.
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const afterSignIn = (elsewhere = false) => {
    if (waiting) return;
    const look = () => {
      waiting = undefined;
      if (!elsewhere && signIn()) waiting = setTimeout(look, 1000);
      else pass();
    };
    waiting = setTimeout(look, elsewhere ? 2000 : 1000);
  };

  async function pass(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    if (signIn()) return afterSignIn();
    busy = true;
    const ok = await allowed();
    busy = false;
    if (!ok) return;
    // Greenhouse fills from MyGreenhouse first (your name, CV, education, signed in): it goes
    // first, and its changes start no pass. What it wrote is held, so it's left; it was never
    // touched by you, so it isn't learned. Pressing may show a sign-in: then nothing fills.
    // Not on arrival: the script comes in before the page's own script has wired the button, and
    // a press then is lost. So once the page has loaded and been still for 1 s (5 s at most); a
    // press that changes nothing is left at that, never pressed again.
    if (!pressed && autofillButton()) {
      pressed = true;
      busy = true;
      if (document.readyState !== "complete")
        await new Promise((r) => addEventListener("load", r, { once: true }));
      await quiet(1000, 5000);
      autofillButton()?.click();
      await quiet(2000, 30_000);
      shape = shapeOf();
      busy = again = false;
      if (signIn()) return afterSignIn();
    }
    const read = readFormFields(true);
    const history = historyDone ? [] : emptyHistory();
    if (!read.length && !history.length) return;
    busy = true;
    try {
      const reply = await ask(
        plain(read),
        !cv && read.some((q) => q.type === "file" || q.type === "input_file"),
        history.length > 0,
      );
      if (reply.signIn) {
        afterSignIn(true);
        return;
      }
      if (history.length) historyDone = true;
      if (reply.cv) {
        const bytes = Uint8Array.from(atob(reply.cv.data), (c) => c.charCodeAt(0));
        cv = new File([bytes], reply.cv.name, { type: "application/pdf" });
      }
      const fields = reply.fields ?? [];
      for (let i = 0; i < read.length && i < fields.length; i++) {
        const q = read[i]!;
        const f = fields[i]!;
        if (!q.el || tried.has(q.el)) continue;
        if (q.value) tried.add(q.el);
        if (!f.value || f.kind === "voluntary" || q.value) continue;
        // No label of its own, only a placeholder or a name: maybe a trap for bots, so nothing
        // from the profile goes in it.
        if (f.kind === "factual" && q.unlabeled) continue;
        if (f.kind === "file" && attached) continue;
        tried.add(q.el);
        try {
          if ((await fillOne(q, q.el, f, cv)) && f.kind === "file") attached = true;
        } catch {
          // One field failing leaves it to you; the rest still fill.
        }
      }
      if (reply.history && history.length) await addHistory(reply.history);
    } finally {
      busy = false;
    }
    markSubmit();
    if (again) {
      again = false;
      pass();
    }
  }

  // Re-read when the form changes shape (a next step, a question that appears), not as you type.
  // My Experience's sections count too: a step with only those still starts a pass.
  const shapeOf = () =>
    [
      ...readFormFields().map((q) => `${q.label}|${q.name}|${q.type}`),
      ...KINDS.filter((k) => addButton(k)),
    ].join("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = shapeOf();
      if (now === shape) return;
      shape = now;
      pass();
    }, 700);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // What you type, as you type it and as you submit, before any script swaps the form away.
  let typing: ReturnType<typeof setTimeout> | undefined;
  const report = () => {
    clearTimeout(typing);
    const qs = readFormFields(true);
    if (qs.length) ask(plain(qs));
  };
  // Your own events are trusted; a pass's are not (it fires plain Events and clicks by script).
  const mine = (e: Event) => e.isTrusted && !busy;
  addEventListener(
    "input",
    (e) => {
      if (e.isTrusted) touch(e);
      if (!mine(e)) return;
      clearTimeout(typing);
      typing = setTimeout(report, 400);
    },
    true,
  );
  addEventListener(
    "change",
    (e) => {
      if (e.isTrusted) touch(e);
      if (mine(e)) report();
    },
    true,
  );
  addEventListener("submit", (e) => mine(e) && report(), true);
  addEventListener(
    "click",
    (e) => {
      if (e.isTrusted) touch(e);
      if (mine(e) && (e.target as Element | null)?.closest?.('button, [type="submit"]')) report();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "notice-done") return;
    notice?.remove();
    notice = null;
  });

  shape = shapeOf();
  pass();
  return () => {
    pass();
  };
}

/**
 * Greenhouse's "Autofill my application": a plain button outside the form, never one that submits.
 */
function autofillButton(): HTMLButtonElement | null {
  const b = Array.from(document.querySelectorAll('button[type="button"]')).find(
    (x) => text(x) === "Autofill my application" && !x.closest("form") && !submits(x),
  );
  return (b as HTMLButtonElement | undefined) ?? null;
}

/** Until the page has changed nothing for `still` ms, or `most` ms at most. */
function quiet(still: number, most: number): Promise<void> {
  return new Promise((done) => {
    const end = () => {
      watch.disconnect();
      clearTimeout(calm);
      clearTimeout(cap);
      done();
    };
    let calm = setTimeout(end, still);
    const cap = setTimeout(end, most);
    const watch = new MutationObserver(() => {
      clearTimeout(calm);
      calm = setTimeout(end, still);
    });
    watch.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  });
}

// Workday's "My Experience": a section per kind of history, its heading over an Add button that
// draws an entry ("Add", then "Add Another"), each entry's fields named by ids that start
// workExperience-N-- or education-N-- (N not in order), whatever the tenant calls the section. A
// section's own heading is exactly its name (Cisco's "Work Experience", Litera's "Professional
// Experience"), an entry's is that name and a number ("Professional Experience 1"); the section is
// a group labelled by its heading (aria-labelledby="Professional-Experience-section").
const HISTORY = {
  work: {
    heading: /^((work|professional) )?experience$|^employment( history)?$|^work history$/i,
    entry: "workExperience",
  },
  education: { heading: /^education$/i, entry: "education" },
} as const;
type Kind = keyof typeof HISTORY;
const KINDS = Object.keys(HISTORY) as Kind[];
const HEADING = "h1, h2, h3, h4, h5, h6";
const ADD = 'button[data-automation-id="add-button"]';
const GROUP = '[role="group"][aria-labelledby$="-section"]';

/** A section group's name: its labelling heading's words, else its label id's. */
function sectionName(g: Element): string {
  const by = g.getAttribute("aria-labelledby")!;
  return text(document.getElementById(by)) || by.replace(/-section$/, "").replace(/-/g, " ");
}

/**
 * A section's Add button: the group named for it, its own Add; else up from its heading to the
 * first box that holds one, never a box holding a heading other than the section's and its entries'
 * (so never another section's Add, whatever that section is called).
 */
function addButton(kind: Kind): HTMLButtonElement | null {
  const ok = (b: Element | null | undefined) =>
    b && !submits(b) && shown(b) ? (b as HTMLButtonElement) : null;
  const g = Array.from(document.querySelectorAll(GROUP)).find((x) =>
    HISTORY[kind].heading.test(sectionName(x)),
  );
  if (g) return ok(Array.from(g.querySelectorAll(ADD)).find((b) => b.closest(GROUP) === g));
  const h = Array.from(document.querySelectorAll(HEADING)).find((x) => HISTORY[kind].heading.test(text(x)));
  if (!h) return null;
  const name = text(h);
  const own = (x: Element) =>
    x === h || (/^ \d+$/.test(text(x).slice(name.length)) && text(x).startsWith(name));
  for (let box = h.parentElement; box && box !== document.body; box = box.parentElement) {
    if (!Array.from(box.querySelectorAll(HEADING)).every(own)) return null;
    const b = box.querySelector(ADD);
    if (b) return ok(b);
  }
  return null;
}

/** The numbers of a kind's entries on the page now. */
function entries(kind: Kind): Set<string> {
  const prefix = HISTORY[kind].entry;
  const re = new RegExp(`^${prefix}-(\\d+)--`);
  return new Set(
    Array.from(document.querySelectorAll(`[id^="${prefix}-"]`)).flatMap((e) => e.id.match(re)?.[1] ?? []),
  );
}

/** The sections with an Add button and no entry yet, yours or Workday's: the only ones the CV fills. */
function emptyHistory(): Kind[] {
  return KINDS.filter((k) => addButton(k) && !entries(k).size);
}

/**
 * Add the CV's work history and education on Workday's My Experience, an entry per job or school in
 * the CV's order, in each section that still has none: Add, then the new entry's fields. A section
 * with an entry (yours, or Workday's own reading of the CV) is never touched, nor anything in it; an
 * entry whose Add draws nothing ends that section. Never Save and Continue. What goes in isn't
 * learned: an entry's fields are never read as questions (readFormFields).
 */
async function addHistory(history: History): Promise<void> {
  for (const kind of emptyHistory()) {
    const items: (Job | School)[] = kind === "work" ? history.work : history.education;
    for (const item of items) {
      const add = addButton(kind);
      if (!add) break;
      const before = entries(kind);
      add.click();
      let n: string | undefined;
      for (let waited = 0; !n && waited < 3000; waited += 100) {
        await new Promise((r) => setTimeout(r, 100));
        n = [...entries(kind)].find((x) => !before.has(x));
      }
      if (!n) break;
      await quiet(300, 2000); // the entry's fields draw
      const id = `${HISTORY[kind].entry}-${n}--`;
      try {
        if (kind === "work") await fillJob(id, item as Job);
        else await fillSchool(id, item as School);
      } catch {
        // A field failing leaves it to you; the next entry still goes in.
      }
    }
  }
}

const byId = (id: string) => document.getElementById(id);

/** Text into an entry's empty field (an input or textarea). */
function putText(el: HTMLElement | null, value: string): void {
  const input = el as HTMLInputElement | HTMLTextAreaElement | null;
  if (!value || !input || !("value" in input) || input.value || !visible(input)) return;
  setText(input, value);
  input.blur();
}

/**
 * A date part (month, year: role=spinbutton) keeps its own value: set as `.value =` from the page,
 * it's gone at its next render, as on a React input; set through HTMLInputElement's own setter, it
 * holds. This script's world never sees the page's setter, so a plain write here is that same write;
 * it's spelled out as measured, so it holds from either world.
 */
function putPart(el: HTMLElement | null, value: string): void {
  const input = el as HTMLInputElement | null;
  if (!value || !input || input.tagName !== "INPUT" || input.value || !visible(input)) return;
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  fire(input, "input");
  fire(input, "change");
}

// Month, then year, and only then out of the date: leaving the month with no year yet makes
// Workday mark the date ("Invalid Date: 07/"), and that mark stays once the year is in.
function putDate(id: string, d: MonthYear | null): void {
  if (!d) return;
  putPart(byId(`${id}-dateSectionMonth-input`), d.month);
  putPart(byId(`${id}-dateSectionYear-input`), d.year);
  (document.activeElement as HTMLElement | null)?.blur();
}

async function fillJob(id: string, job: Job): Promise<void> {
  putText(byId(`${id}jobTitle`), job.title);
  putText(byId(`${id}companyName`), job.company);
  putText(byId(`${id}location`), job.location);
  // "I currently work here" first: ticked, it takes the To date away.
  const current = byId(`${id}currentlyWorkHere`) as HTMLInputElement | null;
  if (job.current && current?.type === "checkbox" && !current.checked) {
    current.click();
    await quiet(200, 1000);
  }
  putDate(`${id}startDate`, job.start);
  if (!job.current) putDate(`${id}endDate`, job.end);
  putText(byId(`${id}roleDescription`), job.description);
}

/** An entry's field by its label's words. */
function labelled(id: string, words: RegExp): HTMLElement | null {
  const label = Array.from(document.querySelectorAll(`label[for^="${id}"]`)).find((l) =>
    words.test(text(l)),
  ) as HTMLLabelElement | undefined;
  return label ? byId(label.htmlFor) : null;
}

/** A plain text box: not a search box, whose words must be one of Workday's list. */
function plainBox(el: HTMLElement | null): boolean {
  return (
    el?.tagName === "TEXTAREA" ||
    (el?.tagName === "INPUT" &&
      (el as HTMLInputElement).type === "text" &&
      el.getAttribute("data-automation-id") !== "searchBox" &&
      !/^search$/i.test((el as HTMLInputElement).placeholder))
  );
}

/**
 * A school: its name (education-N--school on Cisco, --schoolName on Litera, else the box labelled
 * School or University) when that's a plain text box, its GPA, and the years attended the CV gives,
 * by id; its degree by matching the dropdown's options ("B.S." takes a Bachelor's), and its field of
 * study by label when that's a plain text box or a dropdown; a search box (a school or field of study
 * Workday lists) is left to you.
 */
async function fillSchool(id: string, school: School): Promise<void> {
  const name = byId(`${id}school`) ?? byId(`${id}schoolName`) ?? labelled(id, /school|university/i);
  if (plainBox(name)) putText(name, school.school);
  const degree = byId(`${id}degree`);
  if (degree?.tagName === "BUTTON" && school.degree)
    await pickList(degree as HTMLButtonElement, school.degree, (os) => degreeOption(os, school.degree));
  putText(byId(`${id}gradeAverage`), school.gpa);
  for (const [part, year] of [
    ["firstYearAttended", school.firstYear],
    ["lastYearAttended", school.lastYear],
  ] as const) {
    putPart(byId(`${id}${part}-dateSectionYear-input`), year);
    (document.activeElement as HTMLElement | null)?.blur();
  }
  if (!school.field) return;
  const field = labelled(id, /field of study|major|discipline/i);
  if (field?.tagName === "BUTTON" && field.getAttribute("aria-haspopup") === "listbox")
    await pickList(field as HTMLButtonElement, school.field);
  else if (plainBox(field)) putText(field, school.field);
}

/** Fill one field; true when it now holds the value. */
async function fillOne(q: Question, el: Element, f: Field, cv: File | null): Promise<boolean> {
  if (f.kind === "file") {
    const input = el as HTMLInputElement;
    if (!cv || input.type !== "file" || input.files?.length) return false;
    // ATS file pickers hide the real input behind a button: set it directly.
    const dt = new DataTransfer();
    dt.items.add(cv);
    input.files = dt.files;
    fire(input, "input");
    fire(input, "change");
    return true;
  }
  if (f.options && !f.combobox) return pickChoice(q, el, f);
  // Hidden: a trap for bots, or not one of yours. A native list can sit 1px wide under its own
  // widget (select2), so for it being laid out is enough.
  if (!(el.tagName === "SELECT" ? visible(el) : shown(el))) return false;
  if (el.tagName === "BUTTON") return pickList(el as HTMLButtonElement, f.value);
  if (f.combobox) return pickCombo(el as HTMLInputElement, f.value);
  if (el.tagName === "SELECT") {
    const select = el as HTMLSelectElement;
    const options = Array.from(select.options);
    const pick = pickOption(
      options.map((o) => text(o)),
      f.value,
    );
    const o = options.find((x) => text(x) === pick);
    if (!o) return false;
    select.value = o.value;
    fire(select, "change");
    return true;
  }
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  if (input.value) return false;
  setText(input, f.value);
  input.blur();
  return true;
}

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function setText(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.focus();
  input.value = value;
  fire(input, "input");
  fire(input, "change");
}

/** A radio group or Yes/No buttons: click the option the value names, inside its question. */
function pickChoice(q: Question, el: Element, f: Field): boolean {
  const pick = pickOption(f.options!, f.value);
  if (!pick) return false;
  const input = el as HTMLInputElement;
  if (input.type === "radio") {
    const group = Array.from(
      document.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`),
    ) as HTMLInputElement[];
    if (group.some((r) => r.checked)) return true;
    const labelOf = (r: HTMLInputElement) =>
      (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest("label");
    const radio = group.find((r) => text(labelOf(r)) === pick);
    // A styled radio hides its input and shows its label: one of the two must show.
    const label = radio ? labelOf(radio) : null;
    if (!radio || !(shown(radio) || (label && shown(label)))) return false;
    radio.click();
    return true;
  }
  // Ashby's boolean: Yes/No buttons over a hidden checkbox. Only plain buttons, never a submit.
  const box = el.closest(".ashby-application-form-field-entry, fieldset");
  const button = Array.from(box?.querySelectorAll("button") ?? []).find(
    (b) => b.type === "button" && text(b) === pick,
  );
  if (!button || !shown(button) || q.value) return false;
  button.click();
  return true;
}

/**
 * A type-and-pick box (react-select): open it, type the value, click the option it names. Leaves
 * a pick you made, and clears what it typed when no option fits.
 */
async function pickCombo(input: HTMLInputElement, value: string): Promise<boolean> {
  const control = input.closest('[class*="control"], [class*="Control"]');
  const picked =
    input.value.trim() || text(control?.querySelector('[class*="single-value"], [class*="singleValue"]'));
  if (picked) return true;
  openBox(control ?? input, input);
  const first = value.split(",")[0]!.trim();
  for (const typed of first && first !== value ? [value, first] : [value]) {
    setText(input, typed);
    const options = await optionsFor(input);
    const pick = comboOption(
      options.map((o) => text(o)),
      value,
    );
    const o = options.find((x) => text(x) === pick);
    if (o) {
      o.click();
      return true;
    }
  }
  setText(input, "");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  input.blur();
  return false;
}

/**
 * Workday's dropdown, a button: open it, click the option the value names (or `choose` picks) in the
 * list it then names (aria-controls), never "Select One". Leaves a pick already made, and closes the list again when no
 * option fits.
 */
async function pickList(
  button: HTMLButtonElement,
  value: string,
  choose = (options: string[]) => comboOption(options, value),
): Promise<boolean> {
  if (!/^(select one)?$/i.test(text(button))) return true;
  if (submits(button)) return false;
  button.click();
  const options = (await optionsFor(button)).filter((o) => !/^select one$/i.test(text(o)));
  const pick = choose(options.map((o) => text(o)));
  const o = options.find((x) => text(x) === pick);
  if (o) {
    o.click();
    return true;
  }
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (button.getAttribute("aria-expanded") === "true") button.click();
  return false;
}

/**
 * Open a dropdown as a click on its box does: react-select lists nothing as it's typed into until
 * then, and mousedown with focus alone doesn't open it. Never on a box that would submit the form.
 */
function openBox(box: Element, input: HTMLInputElement): void {
  if (submits(box)) return;
  const press = (type: string) =>
    box.dispatchEvent(
      new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        view: window,
      }),
    );
  press("pointerdown");
  press("mousedown");
  input.focus();
  press("pointerup");
  press("mouseup");
  press("click");
}

/**
 * The options in the list a combobox names (aria-controls or aria-owns: react-select names its list
 * once it opens), waiting up to 3 s for them to show. Never options elsewhere on the page, and never
 * one that would submit the form.
 */
async function optionsFor(input: Element): Promise<HTMLElement[]> {
  const list = () =>
    `${input.getAttribute("aria-controls") ?? ""} ${input.getAttribute("aria-owns") ?? ""}`
      .split(/\s+/)
      .flatMap((id) => Array.from(document.getElementById(id)?.querySelectorAll('[role="option"]') ?? []))
      .filter((o) => visible(o) && !submits(o)) as HTMLElement[];
  for (let waited = 0; waited < 3000; waited += 100) {
    const now = list();
    if (now.length) return now;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

/** Show where to submit, without pressing it. */
function markSubmit(): void {
  const b = Array.from(document.querySelectorAll('button, input[type="submit"]')).find((x) =>
    SUBMIT.test(text(x) || (x as HTMLInputElement).value || ""),
  ) as HTMLElement | undefined;
  if (b) b.style.outline = "3px solid #ff5a1f";
}

// Started once per frame. The worker puts the script in again when you click the button: then
// it runs a pass, so a click always fills what it can now (a form a sign-in held back, an answer
// you have just added to your profile).
const win = window as unknown as { jobSignal?: (() => void) | boolean };
if (typeof win.jobSignal === "function") win.jobSignal();
else if (!win.jobSignal) win.jobSignal = start();

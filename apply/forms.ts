// Application forms: which ATS, which questions, and where each answer comes from.
// Greenhouse publishes its questions through the job board API; Lever and Ashby forms
// are read from the page itself with a headless browser.
import { BROWSER_ARGS, guardRequests, publicRequests } from "../ats/render.ts";
import { assertPublicHost } from "../core/http.ts";
import { findAnswer, questionType } from "./answers.ts";
import type { Profile } from "./me.ts";
import { type Question, readFormFields } from "./page.ts";

export type { Question } from "./page.ts";

export type Ats = { ats: "greenhouse" | "lever" | "ashby"; slug: string; jobId: string; applyUrl: string };

export function detectAts(url: string): Ats | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const safe = (s: string | undefined) => !!s && /^[\w.-]+$/.test(s);
  const gh = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (gh && /(^|\.)greenhouse\.io$/.test(u.hostname) && safe(gh[1])) {
    return {
      ats: "greenhouse",
      slug: gh[1]!,
      jobId: gh[2]!,
      applyUrl: `https://job-boards.greenhouse.io/${gh[1]}/jobs/${gh[2]}`,
    };
  }
  const seg = u.pathname.match(/^\/([^/]+)\/([^/?#]+)/);
  if (seg && /^jobs\.(eu\.)?lever\.co$/.test(u.hostname) && safe(seg[1]) && safe(seg[2])) {
    return {
      ats: "lever",
      slug: seg[1]!,
      jobId: seg[2]!,
      applyUrl: `https://${u.hostname}/${seg[1]}/${seg[2]}/apply`,
    };
  }
  if (seg && u.hostname === "jobs.ashbyhq.com" && safe(seg[1]) && safe(seg[2])) {
    // A role in Ashby's embed view (its hosted pages are off: intake/refresh.ts ownPages) applies there too.
    const embed = u.searchParams.get("embed") === "js" ? "?embed=js" : "";
    return {
      ats: "ashby",
      slug: seg[1]!,
      jobId: seg[2]!,
      applyUrl: `https://jobs.ashbyhq.com/${seg[1]}/${seg[2]}/application${embed}`,
    };
  }
  return null;
}

/**
 * Where Apply opens a role: a Workday posting (…myworkdayjobs.com/…/job/…) at "Apply Manually",
 * its query left off: Workday's own reading of the CV ("Autofill with Resume") got 2 of 6 jobs
 * right, so it isn't where you start (a saved draft sends you on to the draft). The CV still goes in
 * under My Experience's Resume/CV, or on Autofill with Resume if you go there. Any other address,
 * or one already in an application (/apply), as it is.
 */
export function applyAddress(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/(^|\.)myworkdayjobs\.com$/i.test(u.hostname) || !/\/job\//.test(u.pathname)) return url;
  if (/\/apply(\/|$)/.test(u.pathname)) return url;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/apply/applyManually`;
}

export async function greenhouseQuestions(a: Ats): Promise<Question[]> {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${a.slug}/jobs/${a.jobId}?questions=true`,
    {
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`Greenhouse questions: HTTP ${res.status}`);
  const j = (await res.json()) as {
    questions?: {
      label: string;
      required: boolean;
      fields: { name: string; type: string; values?: { label: string }[] }[];
    }[];
  };
  return (j.questions ?? []).map((q) => ({
    label: q.label,
    name: q.fields[0]?.name ?? q.label,
    type: q.fields[0]?.type ?? "input_text",
    required: q.required,
    ...(q.fields[0]?.values?.length ? { options: q.fields[0].values.map((v) => v.label) } : {}),
  }));
}

/** Read a form's fields from the page: label, name, type, required. */
export async function pageQuestions(applyUrl: string): Promise<Question[]> {
  await assertPublicHost(new URL(applyUrl).hostname);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  try {
    const page = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
    const isPublic = publicRequests();
    await guardRequests(page, (r) => isPublic(r.url));
    await page.goto(applyUrl, { waitUntil: "networkidle", timeout: 45_000 });
    return await page.evaluate(readFormFields);
  } finally {
    await browser.close();
  }
}

export async function formQuestions(a: Ats): Promise<Question[]> {
  return a.ats === "greenhouse" ? greenhouseQuestions(a) : pageQuestions(a.applyUrl);
}

export type Field = {
  key: string;
  label: string;
  kind: "factual" | "file" | "open" | "voluntary";
  value: string;
  source: string; // profile · answer bank · resume file · answer on the form
  required: boolean;
  missing?: string; // what to add so it fills next time
  question_type?: string;
  options?: string[]; // a radio group or Yes/No buttons: the value must be one of these
  combobox?: boolean; // a type-and-pick box: the value is typed, then its option chosen
};

const FACTUAL: [RegExp, keyof Profile | "first_name" | "last_name" | "city"][] = [
  [/^((legal|preferred) )?first name|given name/i, "first_name"],
  [/^((legal|preferred) )?last name|surname|family name/i, "last_name"],
  [/^(legal )?(full )?name$/i, "full_name"],
  [/^country/i, "country"],
  [/e-?mail/i, "email"],
  [/phone|mobile/i, "phone"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
  [/website|portfolio|personal (site|url)|other url/i, "website"],
  [/^city$/i, "city"], // a field for the city alone (Workday: State is its own dropdown)
  [/^(current )?location|city|where are you based/i, "location"],
  [/authori[sz]ed to work|right to work|legally (able|eligible)/i, "work_authorization"],
  [/sponsor/i, "needs_sponsorship"],
];
const VOLUNTARY = /gender|race|ethnic|veteran|disabilit|pronoun|sexual orientation|hispanic/i;
const FILE = /resume|cv\b|curriculum/i;

export function mapFields(
  questions: Question[],
  ctx: { profile: Profile; company: string; cvFile: string | null },
): Field[] {
  const p = ctx.profile;
  const [first, ...rest] = String(p.full_name ?? "").split(" ");
  const value = (k: string): string => {
    if (k === "first_name") return first ?? "";
    if (k === "last_name") return rest.join(" ");
    if (k === "city")
      return String(p.location ?? "")
        .split(",")[0]!
        .trim();
    if (k === "needs_sponsorship")
      return p.needs_sponsorship === undefined ? "" : p.needs_sponsorship ? "Yes" : "No";
    return String(p[k] ?? "");
  };
  return questions.map((q, i) => {
    const f = mapField(q, i);
    return {
      ...f,
      ...(q.options ? { options: q.options } : {}),
      ...(q.type === "combobox" ? { combobox: true } : {}),
    };
  });

  function mapField(q: Question, i: number): Field {
    const key = q.name || `q${i}`;
    if (q.type === "input_file" || q.type === "file" || FILE.test(q.label)) {
      if (/cover/i.test(q.label))
        return {
          key,
          label: q.label,
          kind: "file",
          value: "",
          source: "optional: skip or attach",
          required: q.required,
        };
      return {
        key,
        label: q.label,
        kind: "file",
        value: ctx.cvFile ?? "",
        source: "resume file",
        required: q.required,
        ...(ctx.cvFile ? {} : { missing: "add a PDF to me/" }),
      };
    }
    if (VOLUNTARY.test(q.label))
      return {
        key,
        label: q.label,
        kind: "voluntary",
        value: "",
        source: "voluntary: your choice",
        required: false,
      };
    // A phone's extension: nothing from the profile fits it (the phone number went in it).
    if (/\bext(ension|\.)?$/i.test(q.label))
      return { key, label: q.label, kind: "factual", value: "", source: "left empty", required: q.required };
    // A phone's kind (Workday's Phone Device Type: Fax, Landline, Mobile, Pager): the profile's
    // phone is a mobile, so not the number itself.
    if (/^phone (device )?type$/i.test(q.label))
      return {
        key,
        label: q.label,
        kind: "factual",
        value: "Mobile",
        source: "profile",
        required: q.required,
      };
    const fact = FACTUAL.find(([re]) => re.test(q.label));
    if (fact) {
      const v = value(fact[1] as string);
      return {
        key,
        label: q.label,
        kind: "factual",
        value: v,
        source: "profile",
        required: q.required,
        ...(v || !q.required
          ? {}
          : { missing: `add ${fact[1] === "city" ? "location" : fact[1]} to me/profile.json` }),
      };
    }
    const saved = findAnswer(q.label, ctx.company);
    if (saved) {
      return {
        key,
        label: q.label,
        kind: "open",
        value: saved.answer,
        source: "answer bank",
        required: q.required,
        question_type: saved.type,
      };
    }
    return {
      key,
      label: q.label,
      kind: "open",
      value: "",
      source: "answer on the form",
      required: q.required,
    };
  }
}

// Never kept, whatever the form calls them.
const PRIVATE = /ssn|social security|date of birth|passport|card|iban|routing/i;
// A record ID, not words (a long hex string, a UUID): the page's own value, never your answer.
const RECORD_ID = /^([0-9a-f]{24,}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/**
 * Answers you typed on the form that the bank should keep: open questions it had no answer for,
 * and only ones you typed or picked yourself (touched), never what the page wrote or ticked itself.
 * Textareas, radio groups and dropdowns (a choice recurs: "Are you 18+?") always; a one-line field
 * only when it's a question type the bank knows (salary, notice…), not any stray input. Never a voluntary (EEO), profile or file field,
 * a password, a card field or an ID number, nor an answer that is a record ID (the page's value).
 * `questions` and `fields` are mapFields' input and output.
 */
export function typedAnswers(
  questions: Question[],
  fields: Field[],
  company: string,
): { question: string; answer: string }[] {
  return questions.flatMap((q, i) => {
    const f = fields[i];
    const answer = q.value?.trim() ?? "";
    if (f?.kind !== "open" || f.value || !answer || !q.touched) return [];
    if (q.type === "password" || /^cc-/i.test(q.autocomplete ?? "") || PRIVATE.test(q.label)) return [];
    if (RECORD_ID.test(answer)) return [];
    const named = !questionType(q.label).startsWith("q:");
    if (
      !(
        q.type === "textarea" ||
        q.type === "radio" ||
        q.type === "select-one" ||
        q.type === "combobox" ||
        (named && ["text", "number"].includes(q.type))
      )
    )
      return [];
    if (findAnswer(q.label, company)?.answer === answer) return [];
    return [{ question: q.label, answer }];
  });
}

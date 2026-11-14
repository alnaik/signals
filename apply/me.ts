// Your own material in me/: the profile, and the PDFs Apply attaches with their Markdown twins.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.ts";

export type Profile = Record<string, string | boolean | undefined> & {
  full_name?: string;
  email?: string;
  phone?: string;
  location?: string;
  country?: string;
  linkedin?: string;
  github?: string;
  website?: string;
  work_authorization?: string;
  needs_sponsorship?: boolean;
};

/** The PDFs in me/, by name: the CV or CVs Apply can attach. */
export function pdfs(): string[] {
  const dir = paths.me();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.pdf$/i.test(f) && !f.startsWith("."))
    .sort();
}

export const CV_MAX_BYTES = 10 * 1024 * 1024;
// A CV's text is a few KB; anything near this is not a CV.
export const CV_TEXT_MAX_BYTES = 100 * 1024;

/**
 * A CV's file name as kept in me/: its last path part only, letters, digits, spaces and . _ - ( )
 * kept and the rest made _, never starting with a dot, ending .pdf. Nothing in it can leave me/.
 */
export function cvName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .normalize("NFKC")
    .replace(/[^\w .()-]/g, "_")
    .replace(/^[\s.]+/, "")
    .replace(/\.(pdf|md|txt)$/i, "")
    .trim()
    .slice(0, 100);
  return `${base || "CV"}.pdf`;
}

// Where a PDF's text twin is kept: beside it, the same name ending .md.
const twin = (pdf: string) => pdf.replace(/\.pdf$/i, ".md");

/** Saves a dropped PDF in me/ (a CV of the same name is replaced); returns the name it got. */
export function saveCv(name: string, bytes: Uint8Array): string {
  if (bytes.length > CV_MAX_BYTES) throw new Error("That PDF is over 10 MB");
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("That isn't a PDF");
  const file = cvName(name);
  const dir = paths.me();
  const to = path.join(dir, file);
  if (path.dirname(path.resolve(to)) !== path.resolve(dir)) throw new Error("Not a file name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(to, bytes);
  return file;
}

/**
 * Saves a dropped CV text file (.md, or .txt as TextEdit makes it) as the Markdown twin of the PDF
 * in me/ with the same name, replacing the one there; returns the name it got. Refused unless it is
 * plain UTF-8 text, small, names a PDF already there, and has jobs or schools to read.
 */
export function saveCvText(name: string, bytes: Uint8Array): string {
  if (bytes.length > CV_TEXT_MAX_BYTES) throw new Error("That text file is over 100 KB, too big for a CV");
  let md: string;
  try {
    md = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("That isn't a plain text file");
  }
  if (md.includes("\0")) throw new Error("That isn't a plain text file");
  const want = cvName(name);
  const pdf = pdfs().find((p) => cvName(p) === want);
  if (!pdf)
    throw new Error(`There's no ${want} yet: add the PDF first, then its text file with the same name`);
  if (!cvHistory(md))
    throw new Error(
      "No jobs or schools could be read from that text file: copy the example to see its shape",
    );
  const dir = paths.me();
  const to = path.join(dir, twin(pdf));
  if (path.dirname(path.resolve(to)) !== path.resolve(dir)) throw new Error("Not a file name");
  writeFileSync(to, md);
  return twin(pdf);
}

/** Removes one of the PDFs in me/ and its Markdown twin, if any, so no old text waits for a new PDF. */
export function removeCv(name: string): void {
  if (!pdfs().includes(name)) throw new Error("No such CV");
  unlinkSync(paths.me(name));
  rmSync(paths.me(twin(name)), { force: true });
}

/**
 * The PDFs in me/ with their sizes and what their text twin gives, for Settings: null with no twin,
 * the counts read from it, or "unreadable" when it has neither jobs nor schools.
 */
export const cvList = () =>
  pdfs().map((name) => {
    const md = paths.me(twin(name));
    const h = existsSync(md) ? cvHistory(readFileSync(md, "utf8")) : undefined;
    return {
      name,
      bytes: statSync(paths.me(name)).size,
      text: h === undefined ? null : h ? { jobs: h.work.length, schools: h.education.length } : "unreadable",
    };
  });

// A date as Workday's date parts take it: month "01"–"12" ("" when the CV gives only a year), year.
export type MonthYear = { month: string; year: string };
export type Job = {
  title: string;
  company: string;
  location: string;
  start: MonthYear | null;
  end: MonthYear | null; // none while current
  current: boolean;
  description: string; // the bullets, one per line
};
// Its years attended, "" when the CV doesn't give one: a lone year is the last ("May 2023").
export type School = {
  school: string;
  degree: string;
  field: string;
  gpa: string;
  firstYear: string;
  lastYear: string;
};
export type History = { work: Job[]; education: School[] };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthYear(s: string): MonthYear | null {
  const m = s.trim().match(/^(?:([a-z]{3})[a-z]*\.?\s+)?(\d{4})$/i);
  const i = m?.[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || (m[1] && i < 0)) return null;
  return { month: i < 0 ? "" : String(i + 1).padStart(2, "0"), year: m[2]! };
}

/** A CV's dates ("Jul 2025 - Present", "Oct 2024 – Jul 2025", "2020 - 2022"): start, end, current. */
export function cvDates(dates: string): Pick<Job, "start" | "end" | "current"> {
  const [from = "", to = ""] = dates.split(/\s*[-–—]\s*|\s+to\s+/i);
  const current = /^(present|current|now)$/i.test(to.trim());
  return { start: monthYear(from), end: current ? null : monthYear(to), current };
}

// A degree written before its field: "B.S. Computer Science", "Bachelor of Science in Physics", "MBA".
const DEGREE =
  /^(Ph\.?\s?D\.?|[A-Z][a-z]?\.(?:\s?[A-Z][a-z]{0,3}\.){1,2}|(?:BS|BA|BSc|BEng|BFA|BBA|MS|MA|MSc|MEng|MBA|MFA|PhD|AA|AS|AAS)\b|(?:Bachelor|Master|Associate|Doctor)(?:'s)?(?: of(?: [A-Z][a-z]+){1,2})?(?: [Dd]egree)?)\s*(?:in\s+|,\s*)?(.*)$/;

/**
 * Work history and education as the CV's own text gives them: the Markdown twin of a PDF in me/
 * (Sam_Rivera_Resume.md beside its .pdf), word for word what the PDF says, so what goes in
 * the form is what the attached resume says. None for a PDF with no twin, or one that doesn't parse.
 */
export function workHistory(pdf: string | null): History | null {
  const md = pdf?.replace(/\.pdf$/i, ".md");
  if (!md || md === pdf || !existsSync(md)) return null;
  return cvHistory(readFileSync(md, "utf8"));
}

/**
 * A CV's Markdown, read for its EXPERIENCE and EDUCATION sections (never PROJECTS). An experience
 * entry is `**Org** | Location[ | link]` then `**Title** | Jul 2025 - Present`, or one line
 * `**Title** | Location | 2020 - 2022` with no company; then an optional plain sentence, `- bullet`
 * lines and an optional `*tech, list*` line, which isn't part of the description. An education
 * entry is `**School** | B.S. Computer Science | GPA 3.71`, maybe with its years (`| 2019 - 2023`).
 * Null when neither section has one.
 */
export function cvHistory(md: string): History | null {
  // Each section's entries: lines between blank lines, a new one also at a bold line after others.
  const sections = new Map<string, string[][]>();
  let blocks: string[][] | null = null;
  let entry: string[] | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^#{2,3}\s+(.+)$/);
    if (head) {
      blocks = [];
      entry = null;
      sections.set(head[1]!.trim().toLowerCase(), blocks);
    } else if (!blocks) continue;
    else if (!line) entry = null;
    else {
      if (!entry || (/^\*\*/.test(line) && entry.some((l) => !/^\*\*/.test(l)))) {
        entry = [];
        blocks.push(entry);
      }
      entry.push(line);
    }
  }
  const of = (title: RegExp) =>
    [...sections].find(([t]) => title.test(t))?.[1].filter((b) => b.length && /^\*\*/.test(b[0]!)) ?? [];
  // `**Bold** | a | b` → ["Bold", "a", "b"]
  const parts = (line: string) =>
    line
      .split(/\s+\|\s+/)
      .map((p) => p.replace(/\*\*/g, "").trim())
      .filter(Boolean);
  const LINK = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\/\S*$/i;
  const DATES = /\b\d{4}\b|^present$/i;
  const work = of(/^((work|professional) )?experience$|^employment( history)?$|^work history$/).map(
    (b): Job => {
      const first = parts(b[0]!);
      const titled = b[1] && /^\*\*/.test(b[1]) ? parts(b[1]) : null;
      const rest = first.slice(1).filter((p) => !LINK.test(p));
      const dates = (titled ?? first).slice(1).find((p) => DATES.test(p)) ?? "";
      const description = b
        .slice(titled ? 2 : 1)
        .filter((l) => !/^\*[^*].*\*$/.test(l)) // the tech line
        .map((l) => l.replace(/^[-*•]\s+/, ""));
      return {
        title: titled ? titled[0]! : first[0]!,
        company: titled ? first[0]! : "",
        location: rest.find((p) => !DATES.test(p)) ?? "",
        ...cvDates(dates),
        description: description.join("\n"),
      };
    },
  );
  const education = of(/^education$/).map((b): School => {
    const first = parts(b[0]!);
    const second = b[1] && /^\*\*/.test(b[1]) ? parts(b[1]) : [];
    const all = [...first.slice(1), ...second];
    const named = all.filter((p) => !/\bGPA\b/i.test(p) && !DATES.test(p) && !LINK.test(p));
    const title = named.find((p) => DEGREE.test(p)) ?? named[0] ?? "";
    const m = title.match(DEGREE);
    // "2019 - 2023", "Aug 2019 – May 2023", "May 2023", "Expected 2027", "2024 - Present"
    const dates = all.filter((p) => DATES.test(p) && !/\bGPA\b/i.test(p)).join(" ");
    const years = dates.match(/\b\d{4}\b/g) ?? [];
    const ongoing = /\bpresent\b/i.test(dates);
    return {
      school: first[0]!,
      degree: m ? m[1]!.trim() : title,
      field: m ? m[2]!.trim() : "",
      gpa: b.join(" ").match(/\bGPA:?\s*(\d\.\d+)/i)?.[1] ?? "",
      firstYear: years.length > 1 || ongoing ? (years[0] ?? "") : "",
      lastYear: ongoing ? "" : (years.at(-1) ?? ""),
    };
  });
  return work.length || education.length ? { work, education } : null;
}

export function profile(): Profile {
  const f = paths.me("profile.json");
  if (!existsSync(f)) return {};
  try {
    const { filters: _, ...rest } = JSON.parse(readFileSync(f, "utf8"));
    return rest;
  } catch {
    return {};
  }
}

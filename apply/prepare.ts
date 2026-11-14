// Apply, now: read the application form's questions (Greenhouse publishes them; Lever and
// Ashby forms are read from the page) and note which PDF from me/ goes with it. No model.
// apply/<role>/apply.json holds the result; the fields are mapped when shown, so an answer
// saved a minute ago fills them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { open } from "../core/db.ts";
import { derive, type Role } from "../core/derive.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { failure } from "../core/trace.ts";
import { companyOfThread } from "../intake/companies.ts";
import {
  type Ats,
  applyAddress,
  detectAts,
  type Field,
  formQuestions,
  mapFields,
  type Question,
} from "./forms.ts";
import { isLinkedIn } from "./linkedin.ts";
import { pdfs, profile } from "./me.ts";

export type ApplyFile = {
  id: string; // the role's folder under apply/
  role: { key: string; title: string; url?: string; location: string };
  ats: Ats["ats"] | null;
  apply_url: string;
  pdf: string | null; // a file name in me/
  questions: Question[];
  error?: string;
};

export const applyDir = (thread: string, ...rest: string[]) =>
  path.join(paths.thread(thread), "apply", ...rest);
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "role";

export function companyName(thread: string): string {
  return derive(read(thread)).company || thread;
}

export const roleId = (r: Pick<Role, "key" | "url" | "title">) => {
  const ats = r.url ? detectAts(r.url) : null;
  return slug(ats?.jobId ?? r.url?.split("/").filter(Boolean).at(-1) ?? r.title);
};

/**
 * The PDF for a role: the only one in me/, else the one picked for that role (its key) before. Each
 * role at a company is asked for once: a pick made for the company before picks were per role (a
 * note with no role) counts for no role, so it's never reused unasked.
 */
export function chosenPdf(thread: string, role: string | undefined): string | null {
  const all = pdfs();
  if (all.length <= 1) return all[0] ?? null;
  if (!role) return null;
  const picked = read(thread).findLast(
    (e) => e.kind === "note" && e.data.event === "pdf_chosen" && e.data.role === role,
  );
  return picked && all.includes(picked.data.file) ? picked.data.file : null;
}

export function pickPdf(thread: string, role: string, file: string): boolean {
  if (!pdfs().includes(file)) return false;
  append(thread, {
    actor: "board",
    kind: "note",
    data: { event: "pdf_chosen", role, file, text: `CV: ${file}` },
  });
  return true;
}

/**
 * The role's apply.json. `later`: don't wait for the form's questions (the panel's list; the
 * extension reads the form itself), so the tab opens at once: the file is written again when
 * they're read, and `later` is called.
 */
export async function prepare(thread: string, role: Role, later?: () => void): Promise<ApplyFile> {
  const id = roleId(role);
  const ats = role.url ? detectAts(role.url) : null;
  const a: ApplyFile = {
    id,
    role: {
      key: role.key,
      title: role.title,
      location: role.location,
      ...(role.url ? { url: role.url } : {}),
    },
    ats: ats?.ats ?? null,
    // A LinkedIn link is never applied on: no link, and the panel points to the company's board.
    apply_url: ats?.applyUrl ?? (role.url && !isLinkedIn(role.url) ? applyAddress(role.url) : ""),
    pdf: chosenPdf(thread, role.key),
    questions: [],
  };
  const file = applyDir(thread, id, "apply.json");
  const before = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ApplyFile) : null;
  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(a, null, 1));
  };
  if (before?.questions.length) a.questions = before.questions;
  else if (ats) {
    const ask = formQuestions(ats).then(
      (q) => {
        a.questions = q;
      },
      (err) => {
        a.error = `form: ${(err as Error).message}`;
        failure("apply", thread, a.error, { step: "prepare", role: id, url: role.url });
      },
    );
    if (later) {
      save();
      void ask.then(() => {
        save();
        later();
      });
      return a;
    }
    await ask;
  }
  save();
  return a;
}

/** The company's own board, else the careers page discovery saw: where a LinkedIn role is applied for. */
export function ownBoard(thread: string): string | null {
  const c = companyOfThread(thread);
  if (!c) return null;
  const b = open()
    .query("SELECT url FROM boards WHERE company_id = ? AND status = 'ok' LIMIT 1")
    .get(c.id) as {
    url: string;
  } | null;
  return b?.url ?? c.careers_url;
}

export function applyFiles(thread: string): ApplyFile[] {
  return derive(read(thread)).roles.flatMap((r) => {
    const f = applyDir(thread, roleId(r), "apply.json");
    return existsSync(f) ? [JSON.parse(readFileSync(f, "utf8")) as ApplyFile] : [];
  });
}

/** Each field with its value and where it came from, as of now. */
export function fieldsFor(thread: string, a: ApplyFile): Field[] {
  return mapFields(a.questions, {
    profile: profile(),
    company: companyName(thread),
    cvFile: a.pdf ? paths.me(a.pdf) : null,
  });
}

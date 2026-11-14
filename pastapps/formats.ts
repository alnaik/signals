// Past-application files: the notebook CSV you transcribe, and email history (a Google
// Takeout .mbox, or messages read through the Gmail adapter). Rules only, no model.
import type { Past } from "./import.ts";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** A CSV is a past-applications notebook when it has a company and an applied date or a status. */
export function notebookCsv(text: string): Past[] | null {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const company = col(/^(company|employer|organisation|organization)$/);
  const date = col(/applied|date/);
  const status = col(/status|outcome|result/);
  if (company < 0 || (date < 0 && status < 0)) return null;
  const role = col(/role|position|title|job/);
  const link = col(/^(url|link|href|posting|job url)$/);
  const notes = col(/note|comment/);
  return rows.slice(1).flatMap((r) => {
    const name = r[company]?.trim();
    if (!name) return [];
    const d = date >= 0 ? Date.parse(r[date]!.trim()) : Number.NaN;
    return [
      {
        company: name,
        ...(role >= 0 && r[role]?.trim() ? { role: r[role]!.trim() } : {}),
        ...(link >= 0 && /^https?:\/\//.test(r[link]?.trim() ?? "") ? { url: r[link]!.trim() } : {}),
        ...(Number.isNaN(d) ? {} : { date: new Date(d).toISOString().slice(0, 10) }),
        ...(status >= 0 && r[status]?.trim() ? { status: r[status]!.trim() } : {}),
        ...(notes >= 0 && r[notes]?.trim() ? { notes: r[notes]!.trim() } : {}),
        source: "notebook",
      },
    ];
  });
}

export type Mail = { from: string; fromName: string; subject: string; date: string };

const ATS_SENDER =
  /greenhouse|lever\.co|ashbyhq|workday|myworkday|smartrecruiters|workable|recruitee|bamboohr|icims|jobvite|teamtailor|personio/i;
const CONFIRM =
  /(thank(s| you) for (applying|your (application|interest))|application (received|submitted)|we('ve| have) received your application|your application (to|for|at))/i;
const REJECT =
  /(unfortunately|not (to )?(move|moving) forward|other candidates|not selected|decided to pursue)/i;

/** An application confirmation or rejection email → a past application. */
export function mailToPast(m: Mail, body = ""): Past | null {
  const text = `${m.subject}\n${body.slice(0, 3000)}`;
  if (!CONFIRM.test(text) && !(REJECT.test(text) && ATS_SENDER.test(m.from))) return null;
  // "Thank you for applying to Tessera Labs" · "Your application for Engineer at Quarry"
  const at = m.subject.match(
    /(?:applying to|application (?:to|at|with)|interest in|at)\s+([A-Z][\w&.' -]{1,40}?)(?:[!.,|-]|$)/,
  );
  const role = m.subject.match(/(?:for|for the)\s+(?:the\s+)?(.+?)\s+(?:role|position|at)\b/i)?.[1];
  const company =
    at?.[1]?.trim() ||
    m.fromName
      .replace(/\b(careers|recruiting|talent|hiring|team|jobs)\b/gi, "")
      .replace(/[@<].*$/, "")
      .trim();
  if (!company) return null;
  const senderDomain = m.from.split("@")[1]?.toLowerCase() ?? "";
  return {
    company,
    ...(role ? { role: role.trim() } : {}),
    date: m.date.slice(0, 10),
    status: REJECT.test(text) ? "rejected" : "applied",
    ...(senderDomain && !ATS_SENDER.test(senderDomain) && !/gmail|outlook|yahoo|icloud/.test(senderDomain)
      ? { domain: senderDomain }
      : {}),
    source: "email",
  };
}

/** Headers of each message in an mbox, plus the start of the body. Streams line by line. */
export function* mbox(text: string): Generator<{ mail: Mail; body: string }> {
  const parts = text.split(/\r?\n(?=From .*\d{4}\r?\n)/);
  for (const part of parts) {
    const [head = "", ...rest] = part.split(/\r?\n\r?\n/);
    const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
    const h = (name: string) => unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
    const from = h("From");
    if (!from) continue;
    const date = Date.parse(h("Date"));
    yield {
      mail: {
        from: (from.match(/<([^>]+)>/)?.[1] ?? from).toLowerCase(),
        fromName: from
          .replace(/<[^>]+>/, "")
          .replace(/"/g, "")
          .trim(),
        subject: h("Subject"),
        date: Number.isNaN(date) ? new Date().toISOString() : new Date(date).toISOString(),
      },
      body: rest.join("\n\n").slice(0, 4000),
    };
  }
}

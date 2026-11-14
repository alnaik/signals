// The extension's one route. It reads a form in your own Chrome and posts the questions here;
// the answer is what to fill (profile, answer bank, CV). Each read is kept per tab and frame, so
// what you type is learned when the page moves on or the tab closes (apply/session.ts).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isLinkedIn } from "../apply/linkedin.ts";
import { pdfs, workHistory } from "../apply/me.ts";
import type { Question } from "../apply/page.ts";
import { chosenPdf, companyName } from "../apply/prepare.ts";
import { capture, learn, type Seen } from "../apply/session.ts";
import { ATS_URL, boardSlug, registrable } from "../ats/reader.ts";
import { paths } from "../core/paths.ts";
import type { ServerFeature } from "../server/types.ts";
import { builtVersion } from "./build.ts";

export type ExtRead = {
  tab?: number;
  frame?: number;
  thread?: string; // the company the tab was opened for by Apply; none when you clicked Fill
  role?: string; // the role Apply opened the tab for (its key): the tab gets that role's CV
  url?: string;
  questions?: Question[];
  want_cv?: boolean;
  want_history?: boolean; // Workday's My Experience has empty sections: the CV's history fills them
  closed?: boolean; // the tab closed: learn what it held
};

// Reads by `${tab}:${frame}`, each with when it was last read. In memory: what isn't learned yet
// is learned when the board stops (learnAll, on SIGTERM or Ctrl-C); only a crash loses it.
const seen = new Map<string, Seen & { at: number }>();
// A read idle this long is learned and dropped: its tab is long closed (the worker missed it), and
// Chrome numbers tabs afresh after a restart, so a new tab may get its number.
const IDLE_MS = 6 * 3_600_000;
// The most options one question brings (a country list is about 250).
const MAX_OPTIONS = 300;

/** Learn what every kept read holds, and forget them all: the board is stopping. */
export function learnAll(): number {
  let n = 0;
  for (const st of seen.values()) n += learn(st);
  seen.clear();
  return n;
}

const isThread = (t: unknown): t is string =>
  typeof t === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) && existsSync(paths.thread(t));

/**
 * The company a page you filled with the button is for (no Apply linked it): its site's thread
 * when there is one, else a job board's slug or the site's own name ("acme" for careers.acme.com).
 * What you write there is kept as that company's, not offered to every company as no one's.
 */
function siteCompany(url: URL): string {
  if (ATS_URL.test(url.hostname)) return boardSlug(url.href) ?? url.hostname;
  const site = registrable(url.hostname);
  const name = site.split(".")[0]!;
  return isThread(site) ? companyName(site) : name;
}

function questionsOf(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : undefined);
  return raw.slice(0, 300).flatMap((q) => {
    if (!q || typeof q !== "object" || typeof q.label !== "string") return [];
    const options = Array.isArray(q.options)
      ? q.options
          .slice(0, MAX_OPTIONS)
          .filter((o: unknown) => typeof o === "string")
          .map((o: string) => o.slice(0, 500))
      : [];
    const value = str(q.value);
    const autocomplete = str(q.autocomplete);
    return [
      {
        label: q.label.slice(0, 500),
        name: str(q.name) ?? "",
        type: str(q.type) ?? "text",
        required: q.required === true,
        ...(options.length ? { options } : {}),
        ...(value ? { value } : {}),
        ...(autocomplete ? { autocomplete } : {}),
        ...(q.touched === true ? { touched: true } : {}),
      },
    ];
  });
}

/** Answer one read: the fields to fill, in the order the questions came. */
export function read(b: ExtRead, now = Date.now()): Response {
  // No tab: the worker asking which build the board has.
  if (!Number.isInteger(b.tab)) return Response.json({ build: builtVersion() });
  for (const [k, st] of seen)
    if (now - st.at > IDLE_MS) {
      learn(st);
      seen.delete(k);
    }
  if (b.closed) {
    for (const [k, st] of seen)
      if (k.startsWith(`${b.tab}:`)) {
        learn(st);
        seen.delete(k);
      }
    return Response.json({ ok: true });
  }
  let url: URL;
  try {
    url = new URL(String(b.url));
  } catch {
    return Response.json({ toast: "No page address" }, { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol) || isLinkedIn(url.href)) return Response.json({ fields: [] });
  const thread = isThread(b.thread) ? b.thread : null;
  const all = pdfs();
  const role = typeof b.role === "string" ? b.role : undefined;
  const pdf = thread ? chosenPdf(thread, role) : all.length === 1 ? all[0]! : null;
  const ctx = {
    company: thread ? companyName(thread) : siteCompany(url),
    cvFile: pdf ? paths.me(pdf) : null,
  };
  const key = `${b.tab}:${Number.isInteger(b.frame) ? b.frame : 0}`;
  const st = seen.get(key) ?? { last: null, at: now };
  st.at = now;
  seen.set(key, st);
  const fields = capture(st, url.href, ctx, questionsOf(b.questions)).map((f) => ({
    label: f.label,
    kind: f.kind,
    value: f.kind === "file" && f.value ? path.basename(f.value) : f.value,
    ...(f.options ? { options: f.options } : {}),
    ...(f.combobox ? { combobox: true } : {}),
  }));
  const cv =
    b.want_cv && ctx.cvFile && fields.some((f) => f.kind === "file" && f.value)
      ? { name: path.basename(ctx.cvFile), data: readFileSync(ctx.cvFile).toString("base64") }
      : undefined;
  // Work history and education as the CV attached here says them (its .md twin), for the extension
  // to add as entries; never read back as answers (an entry's fields aren't questions).
  const history = b.want_history ? workHistory(ctx.cvFile) : null;
  return Response.json({
    fields,
    build: builtVersion(),
    ...(cv ? { cv } : {}),
    ...(history ? { history } : {}),
  });
}

export const feature: ServerFeature = {
  name: "extension",
  routes: {
    "/api/ext/read": {
      POST: async (req) => read((await req.json().catch(() => ({}))) as ExtRead),
    },
  },
};

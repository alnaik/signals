// A role's text, fetched the first time it's opened and kept in role_text. Board reads take
// the job list only; the text of a role that fits comes from the list when the list has it
// (Lever, Ashby), otherwise from here: the provider's own detail endpoint, else the posting's page.

import { open } from "../core/db.ts";
import { htmlToText } from "../core/http.ts";
// @ts-expect-error plain JS module
import { locationsFromDetail } from "../vendor/career-ops/providers/workday.mjs";
import { workMode } from "./filters.ts";
import { boardSlug, getPage } from "./reader.ts";

type RoleRow = {
  id: number;
  url: string;
  ext_id: string | null;
  title: string;
  location: string;
  mode: string;
};
type BoardRow = { provider: string; url: string };

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

async function json(url: string): Promise<Record<string, unknown>> {
  return JSON.parse((await getPage(url, { accept: "application/json" })).text);
}

/** A Workday posting's detail document, its CXS address: /<site>/job/... under /wday/cxs/<tenant>/. */
function workdayCxs(roleUrl: string): string | null {
  const u = new URL(roleUrl);
  const parts = u.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("job");
  if (at < 1) return null;
  return `${u.origin}/wday/cxs/${u.hostname.split(".")[0]}/${parts[at - 1]}/${parts.slice(at).join("/")}`;
}

/**
 * A Workday posting's places and text, from its detail document: the list says "3 Locations"
 * for a role in several places, and the detail names them (the vendored provider's own
 * locationsFromDetail). null when it can't be read; places "" when it names none.
 */
export async function workdayDetail(roleUrl: string): Promise<{ places: string; text: string } | null> {
  const url = workdayCxs(roleUrl);
  if (!url) return null;
  const j = await json(url);
  const info = j.jobPostingInfo as { jobDescription?: string } | undefined;
  return {
    places: locationsFromDetail(j),
    text: info?.jobDescription ? htmlToText(info.jobDescription) : "",
  };
}

/** Where a provider serves one posting's text, and how to take it out of the answer. */
async function fromProvider(role: RoleRow, board: BoardRow): Promise<string | null> {
  const id = role.ext_id;
  const slug = boardSlug(board.url);
  switch (board.provider) {
    case "greenhouse": {
      if (!id || !slug) return null;
      const j = await json(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`);
      return typeof j.content === "string" ? htmlToText(decode(j.content)) : null;
    }
    case "lever": {
      if (!id || !slug) return null;
      const j = await json(`https://api.lever.co/v0/postings/${slug}/${id}`);
      const lists = (j.lists as { text?: string; content?: string }[] | undefined) ?? [];
      return [
        j.descriptionPlain,
        ...lists.map((l) => `${l.text ?? ""}\n${htmlToText(l.content ?? "")}`),
        j.additionalPlain,
      ]
        .filter((x) => typeof x === "string" && x.trim())
        .join("\n\n");
    }
    case "smartrecruiters": {
      if (!id || !slug) return null;
      const j = await json(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`);
      const sections = ((j.jobAd as { sections?: Record<string, { text?: string }> })?.sections ??
        {}) as Record<string, { text?: string }>;
      return Object.values(sections)
        .map((s) => htmlToText(s.text ?? ""))
        .filter(Boolean)
        .join("\n\n");
    }
    case "workday": {
      const url = workdayCxs(role.url);
      if (!url) return null;
      const info = (await json(url)).jobPostingInfo as { jobDescription?: string } | undefined;
      return info?.jobDescription ? htmlToText(info.jobDescription) : null;
    }
    case "eightfold": {
      if (!id) return null;
      const b = new URL(board.url);
      const domain = b.searchParams.get("domain");
      const j = await json(
        `${b.origin}/api/apply/v2/jobs/${id}${domain ? `?domain=${encodeURIComponent(domain)}` : ""}`,
      );
      return typeof j.job_description === "string" ? htmlToText(j.job_description) : null;
    }
    default:
      return null;
  }
}

/** The posting's own page: its JobPosting description, else the page's text. */
async function fromPage(url: string): Promise<string | null> {
  const html = (await getPage(url)).text;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const flat = (v: unknown): Record<string, unknown>[] =>
        Array.isArray(v)
          ? v.flatMap(flat)
          : v && typeof v === "object"
            ? [v as Record<string, unknown>, ...flat((v as Record<string, unknown>)["@graph"])]
            : [];
      const posting = flat(JSON.parse(m[1]!)).find((o) => [o["@type"]].flat().includes("JobPosting"));
      if (typeof posting?.description === "string") return htmlToText(decode(posting.description));
    } catch {}
  }
  const text = htmlToText(html);
  return text.length >= 200 ? text.slice(0, 20_000) : null;
}

/** A role's text: from role_text, or fetched now and kept. null when nothing readable came back. */
export async function roleText(roleId: number, now = new Date()): Promise<string | null> {
  const d = open();
  const kept = d.query("SELECT text FROM role_text WHERE role_id = ?").get(roleId) as { text: string } | null;
  if (kept) return kept.text;
  const role = d
    .query("SELECT id, url, ext_id, title, location, mode, board_id FROM roles WHERE id = ?")
    .get(roleId) as (RoleRow & { board_id: number }) | null;
  if (!role) return null;
  const board = d
    .query("SELECT provider, url FROM boards WHERE id = ?")
    .get(role.board_id) as BoardRow | null;
  let text: string | null = null;
  try {
    text = board ? await fromProvider(role, board) : null;
  } catch {}
  if (!text) text = await fromPage(role.url).catch(() => null);
  if (!text?.trim()) return null;
  const clean = text.trim().slice(0, 20_000);
  d.query(
    "INSERT INTO role_text (role_id, text, fetched_at) VALUES (?, ?, ?) ON CONFLICT(role_id) DO UPDATE SET text = excluded.text",
  ).run(roleId, clean, now.toISOString());
  // The text can say what the title and place didn't: remote, hybrid, on-site.
  if (role.mode === "unknown") {
    const mode = workMode({ title: role.title, location: role.location, description: clean }).mode;
    if (mode !== "unknown") d.query("UPDATE roles SET mode = ? WHERE id = ?").run(mode, roleId);
  }
  return clean;
}

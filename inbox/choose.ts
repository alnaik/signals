// Choosing in the Inbox, one UPDATE each. Apply opens the company's thread with the role (a
// posting from the company's own board: the only kind of role there is); Dismiss puts a role, or
// a whole company, out of the Inbox; Watch puts the company on the Watchlist, and it comes back
// here only with roles first seen since. Clear, on a watched company, takes its new roles out of
// the Inbox and keeps watching it. Work, on a company with no role, opens its thread for a cold
// message; Work on it, on a role, puts the role on the thread (nothing chosen) for Work to use.
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import {
  applyEmailOf,
  type Company,
  dismissCompany,
  getCompany,
  signalsOf,
  threadIdOf,
  watchCompany,
} from "../intake/companies.ts";
import { sinceWatched } from "./query.ts";

export type RoleAction = "apply" | "apply_watch" | "dismiss" | "work";
export type CompanyAction = "watch" | "dismiss" | "apply_email" | "work";
export const ROLE_ACTIONS: RoleAction[] = ["apply", "apply_watch", "dismiss", "work"];
export const COMPANY_ACTIONS: CompanyAction[] = ["watch", "dismiss", "apply_email", "work"];

export type ChooseResult =
  | { ok: true; toast: string; company: number; thread?: string; url?: string; work?: boolean }
  | { ok: false; status: number; toast: string };

type RoleRow = {
  id: number;
  company_id: number;
  title: string;
  location: string;
  url: string;
  state: string;
  first_seen: string;
  reposted: string | null;
};

export function chooseRole(roleId: number, action: RoleAction, now = new Date()): ChooseResult {
  if (!ROLE_ACTIONS.includes(action)) return { ok: false, status: 400, toast: `Unknown action: ${action}` };
  const d = open();
  const r = d
    .query("SELECT id, company_id, title, location, url, state, first_seen, reposted FROM roles WHERE id = ?")
    .get(roleId) as RoleRow | null;
  if (!r) return { ok: false, status: 404, toast: "That role isn't known" };
  if (action === "work") return workRole(r, now);
  // "archived": out of the Inbox (three weeks old, or not news when it arrived) but still open.
  if (r.state !== "new" && r.state !== "archived")
    return { ok: false, status: 409, toast: "Already chosen: see the thread" };
  const c = getCompany(r.company_id)!;
  if (action === "dismiss") {
    d.query(
      "UPDATE roles SET state = 'dismissed', state_at = ? WHERE id = ? AND state IN ('new', 'archived')",
    ).run(now.toISOString(), roleId);
    return { ok: true, toast: `Dismissed · ${r.title}`, company: c.id };
  }
  const thread = threadIdOf(c);
  // The role joins the company's thread as the board shows it, then the choice.
  appendPosting(thread, c, r, now);
  append(thread, {
    actor: "board",
    kind: "decision",
    ts: now.toISOString(),
    data: { action: "apply", url: r.url },
  });
  d.query("UPDATE roles SET state = 'applied', state_at = ? WHERE id = ?").run(now.toISOString(), roleId);
  if (action === "apply_watch") watchCompany(c.id, "inbox", now);
  index.reindex(thread);
  const verb = action === "apply_watch" ? "Applying and watching" : "Applying";
  return { ok: true, toast: `${verb} · ${c.name}`, company: c.id, thread, url: r.url };
}

/** A role on its company's thread, as the board shows it: a posting, with its text when kept. */
function appendPosting(thread: string, c: Company, r: RoleRow, now: Date): void {
  const text = open().query("SELECT text FROM role_text WHERE role_id = ?").get(r.id) as {
    text: string;
  } | null;
  append(thread, {
    actor: "ats",
    kind: "signal",
    ts: now.toISOString(),
    data: {
      company: c.name,
      source_tag: "Board",
      kind: "posting",
      title: r.title,
      ...(r.location ? { location: r.location } : {}),
      ...(r.reposted ? { reposted: r.reposted } : {}),
    },
    source: {
      type: "page",
      url: r.url,
      quote: (text?.text ?? [r.title, r.location].filter(Boolean).join(" · ")).slice(0, 1000),
      fetched_at: r.first_seen,
    },
  });
}

/**
 * Work on it, on one role: the role joins its company's thread as Apply puts it there, but nothing is
 * chosen (no decision, the role stays where it was in the Inbox); the board then asks Work to start,
 * which reads the thread's roles. A role already on the thread isn't added twice.
 */
function workRole(r: RoleRow, now: Date): ChooseResult {
  const c = getCompany(r.company_id)!;
  const thread = threadIdOf(c);
  if (!read(thread).some((e) => e.kind === "signal" && e.source?.url === r.url)) {
    appendPosting(thread, c, r, now);
    index.reindex(thread);
  }
  return { ok: true, toast: `Working on ${c.name} · ${r.title}`, company: c.id, thread, work: true };
}

export function chooseCompany(companyId: number, action: CompanyAction, now = new Date()): ChooseResult {
  if (!COMPANY_ACTIONS.includes(action))
    return { ok: false, status: 400, toast: `Unknown action: ${action}` };
  const c = getCompany(companyId);
  if (!c) return { ok: false, status: 404, toast: "That company isn't known" };
  if (action === "watch") {
    watchCompany(c.id, "inbox", now);
    return { ok: true, toast: `Watching ${c.name}`, company: c.id };
  }
  if (action === "dismiss" && c.watched_at) {
    // "archived": out of the Inbox, still open and choosable on the company's Watchlist page.
    const n = open()
      .query(
        `UPDATE roles SET state = 'archived', state_at = $now
         WHERE company_id = $id AND state = 'new' AND fits = 1 AND closed_at IS NULL
           AND ${sinceWatched("first_seen", "$watched")}`,
      )
      .run({ id: c.id, now: now.toISOString(), watched: c.watched_at }).changes;
    return {
      ok: true,
      toast: `Cleared ${n} new role${n === 1 ? "" : "s"} · still watching ${c.name}`,
      company: c.id,
    };
  }
  if (action === "dismiss") {
    dismissCompany(c.id, now);
    return { ok: true, toast: `Dismissed ${c.name}`, company: c.id };
  }
  if (action === "work") return workCompany(c, now);
  // A company that takes applications by email: Apply opens the thread with what named it, no form.
  const email = applyEmailOf(c);
  if (!email) return { ok: false, status: 409, toast: `${c.name} has no apply address` };
  const s = signalsOf(c.id, 1)[0];
  const thread = threadIdOf(c);
  append(thread, {
    actor: s?.source ?? "inbox",
    kind: "signal",
    ts: now.toISOString(),
    data: {
      company: c.name,
      source_tag: s?.source_tag ?? "Inbox",
      kind: "posting",
      title: s?.title ?? `${c.name} (by email)`,
      ...(s?.location ? { location: s.location } : {}),
    },
    source: {
      type: "page",
      url: s?.url ?? email.page,
      ...(s?.text ? { quote: s.text } : { quote: email.address }),
      fetched_at: s?.received_at ?? now.toISOString(),
    },
  });
  append(thread, {
    actor: "board",
    kind: "decision",
    ts: now.toISOString(),
    data: { action: "apply", url: s?.url ?? email.page },
  });
  dismissCompany(c.id, now); // chosen: it leaves the Inbox; the thread holds it now
  index.reindex(thread);
  return { ok: true, toast: `Applying by email · ${email.address}`, company: c.id, thread };
}

/**
 * Work on a company with no role: its thread opens (or the one it has is reused) with what named
 * it, in the timeline only: no role to apply to, no decision. The board then asks Work to start.
 * The company stays in the Inbox, as nothing was chosen there: Dismiss would keep out the roles it
 * posts later.
 */
function workCompany(c: Company, now: Date): ChooseResult {
  const thread = threadIdOf(c);
  if (read(thread).length === 0) {
    const s = signalsOf(c.id, 1)[0];
    const url = s?.url ?? c.careers_url ?? (c.domain ? `https://${c.domain}` : undefined);
    append(thread, {
      actor: s?.source ?? "inbox",
      kind: "signal",
      ts: now.toISOString(),
      // A post, never a posting, and no title: a role here would ask you to apply.
      data: { company: c.name, source_tag: s?.source_tag ?? "Inbox", kind: "post" },
      ...(url
        ? {
            source: {
              type: "page" as const,
              url,
              quote: (s?.text ?? s?.title ?? c.name).slice(0, 1000),
              fetched_at: s?.received_at ?? now.toISOString(),
            },
          }
        : {}),
    });
    index.reindex(thread);
  }
  return { ok: true, toast: `Working on ${c.name}`, company: c.id, thread };
}

// Small display helpers shared by the board and features.
import type { Detail, Fact, Role, Summary } from "../core/derive.ts";
import { isStandIn } from "../core/vocab.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function age(ts: string | null | undefined, now = Date.now()): string {
  if (!ts) return "";
  const ms = Math.max(0, now - Date.parse(ts));
  if (ms < 5 * MIN) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  if (ms < 60 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms < 365 * DAY) return `${Math.floor(ms / (30 * DAY))}mo`;
  return `${Math.floor(ms / (365 * DAY))}y`;
}

export function ago(ts: string | null | undefined, now = Date.now()): string {
  const a = age(ts, now);
  if (a === "now") return "now";
  if (a === "1d") return "yesterday";
  return `${a} ago`;
}

export function shortDate(ts: string | null | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function boardDate(d = new Date()): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function sentence(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function domainOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A thread's status word as the board shows it: "sent · 5d", "closed (no reply)". `id`: the
 * thread, whose name says when it waits for its company's website. */
export function statusWord(
  s: Pick<Summary, "status" | "statusSince" | "closeReason"> & {
    tonight?: boolean;
    ran?: Summary["ran"];
    id?: string;
  },
): string | null {
  if (s.status === "researching" && s.id && isStandIn(s.id)) return "waiting for website";
  if (s.status === "sent") return `sent · ${age(s.statusSince)}`;
  if (s.status === "researching" && s.tonight) return "researching · next in line";
  if (s.status === "closed") return `closed${s.closeReason ? ` (${s.closeReason})` : ""}`;
  return s.status ?? s.ran ?? null;
}

export function roleWord(r: Role): string {
  return r.status === "applied" ? `applied · ${age(r.since)}` : r.status;
}

/** "2 roles · 1 applied". */
export function rolesSummary(roles: Role[]): string {
  const live = roles.filter((r) => r.status !== "dismissed" && r.status !== "gone");
  if (!roles.length) return "no roles";
  const applied = live.filter((r) => r.status === "applied").length;
  const n = live.length;
  return [`${n} role${n === 1 ? "" : "s"}`, applied ? `${applied} applied` : ""].filter(Boolean).join(" · ");
}

/** The URL when it is http(s), else undefined: links from search results are never trusted. */
export function safeHref(url: string | undefined, schemes = /^https?:$/): string | undefined {
  if (!url) return undefined;
  try {
    return schemes.test(new URL(url).protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A role's link: a web page, or a mail link, which a careers page may give as a role's link. */
export function roleHref(url: string | undefined): string | undefined {
  return safeHref(url, /^(https?|mailto):$/);
}

/** What a source link is, in words: "plaid/plaid-node #412", "HN #41234567", "LinkedIn profile". */
export function linkLabel(url: string | undefined): string {
  if (!url) return "no source";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com") {
    const [o, r, kind, ref] = parts;
    if (o && r && kind === "issues" && ref) return `${o}/${r} #${ref}`;
    if (o && r && kind === "pull" && ref) return `${o}/${r} PR #${ref}`;
    if (o && r && kind === "commit" && ref) return `${o}/${r} @${ref.slice(0, 7)}`;
    if (o && r) return `${o}/${r}`;
    if (o) return `@${o} on GitHub`;
  }
  if (host === "news.ycombinator.com" && u.searchParams.get("id")) return `HN #${u.searchParams.get("id")}`;
  if (/(^|\.)linkedin\.com$/.test(host) && parts[0] === "in") return "LinkedIn profile";
  if (host === "crt.sh") return "certificate log";
  return host || "link";
}

export type Source = { n: number; label: string; href?: string; text: string };

/** The facts the research block cites, once each, in the order the lines first cite them. */
export function citedSources(d: Pick<Detail, "research" | "facts">): Source[] {
  const r = d.research;
  if (!r) return [];
  const byN = new Map<number, Fact>(d.facts.map((f) => [f.n, f]));
  const out: Source[] = [];
  for (const n of new Set([...r.problem.facts, ...r.person.facts, ...r.proof.facts])) {
    const f = byN.get(n);
    if (f) out.push({ n, label: linkLabel(f.source?.url), href: safeHref(f.source?.url), text: f.text });
  }
  return out;
}

/** Is this page inside another page's frame? Comparing windows is allowed across origins. */
export function framed(w: { top: unknown; self: unknown }): boolean {
  return w.top !== w.self;
}

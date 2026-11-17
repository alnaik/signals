// The four outside measures, from the data folder alone: do we hold every role
// the board has, do applied postings still resolve a week on, how good are the people found,
// and do messages get answers. Counts and company domains only: no names, no profile text.
import { existsSync, readdirSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import { open } from "../core/db.ts";
import { type Channel, derive } from "../core/derive.ts";
import { entries, monthSpend, monthStart, spendBy } from "../core/ledger.ts";
import { type Entry, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;
/** An error's first line: a multi-line one (Playwright's banner) would flood the report. */
export const firstLine = (error: string) => error.split("\n")[0]!.trim();
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");

function threads(): string[] {
  return existsSync(paths.threads()) ? readdirSync(paths.threads()).filter((d) => !d.startsWith(".")) : [];
}

/** 1. Boards: read fine, read through their search only (partial), failing. */
export function boardCounts(): { checked: number; partial: number; off: string[] } {
  const rows = open()
    .query(
      `SELECT c.name, b.provider, b.status, b.partial, b.fails, b.last_error, b.last_read_at FROM boards b
       JOIN companies c ON c.id = b.company_id`,
    )
    .all() as {
    name: string;
    provider: string;
    status: string;
    partial: number;
    fails: number;
    last_error: string | null;
    last_read_at: string | null;
  }[];
  return {
    checked: rows.filter((r) => r.status === "ok" && r.last_read_at && !r.fails).length,
    partial: rows.filter((r) => r.partial).length,
    off: rows
      .filter((r) => r.status === "broken" || r.fails)
      .map(
        (r) =>
          `${r.name} (${r.provider}): ${r.status === "broken" ? "broken" : `${r.fails} failed`} · ${firstLine(r.last_error ?? "?")}`,
      ),
  };
}

export const applied = (log: Entry[]) =>
  log.filter((e) => e.kind === "decision" && e.data.action === "applied" && e.data.url);

/** 2. Applied postings: does the link still resolve 7 days on (the nightly posting check). */
export function postingsAfterWeek(now = new Date()) {
  let total = 0;
  let up = 0;
  let gone = 0;
  let unknown = 0;
  let waiting = 0;
  for (const id of threads()) {
    const log = read(id);
    const checks = new Map(
      log
        .filter((e) => e.kind === "note" && e.data.event === "posting_check")
        .map((e) => [e.data.url, e.data]),
    );
    for (const a of applied(log)) {
      total++;
      const c = checks.get(a.data.url);
      if (!c) {
        if (now.getTime() - Date.parse(a.ts) < 7 * 86_400_000) waiting++;
        else unknown++;
      } else if (c.ok === true) up++;
      else if (c.ok === false) gone++;
      else unknown++;
    }
  }
  return { total, up, gone, unknown, waiting };
}

const RANK = { verified: 3, pattern: 2, guessed: 1 } as const;
type Bucket = keyof typeof RANK | "no email";

/** When each message went out, and the first reply after each. */
function messages(log: Entry[]): { sent: string; reply?: string }[] {
  const out: { sent: string; reply?: string }[] = [];
  for (const e of log) {
    const sent =
      (e.kind === "decision" && e.data.action === "mark_sent") ||
      (e.kind === "sent" && e.data.channel !== "application");
    const reply = e.kind === "reply" || (e.kind === "decision" && e.data.action === "got_reply");
    if (sent) out.push({ sent: e.ts });
    else if (reply) {
      const open = out.at(-1);
      if (open && !open.reply) open.reply = e.data.at ?? e.ts;
    }
  }
  return out;
}

/** 3 and 4. People found by how sure their email is; messages sent and replies. */
export function people() {
  const buckets = new Map<Bucket, { people: number; sent: number; replied: number }>();
  let sent = 0;
  let replied = 0;
  const hours: number[] = [];
  for (const id of threads()) {
    const log = read(id);
    const msgs = messages(log);
    sent += msgs.length;
    for (const m of msgs) {
      if (!m.reply) continue;
      replied++;
      hours.push((Date.parse(m.reply) - Date.parse(m.sent)) / 3_600_000);
    }
    // The thread's person as the board shows it (derive's main one), not its last contact line.
    const contact = derive(log).contacts.find((c) => c.main && c.name);
    if (!contact) continue;
    const emails = contact.channels.filter((c: Channel) => c.channel === "email");
    const best = emails.sort((a, b) => RANK[b.confidence] - RANK[a.confidence])[0];
    const k: Bucket = best?.confidence ?? "no email";
    const b = buckets.get(k) ?? { people: 0, sent: 0, replied: 0 };
    const after = msgs.filter((m) => m.sent >= contact.ts);
    b.people++;
    if (after.length) b.sent++;
    if (after.some((m) => m.reply)) b.replied++;
    buckets.set(k, b);
  }
  hours.sort((a, b) => a - b);
  const mid = hours.length / 2;
  const median = hours.length
    ? hours.length % 2
      ? hours[Math.floor(mid)]!
      : (hours[mid - 1]! + hours[mid]!) / 2
    : null;
  return { buckets, sent, replied, median };
}

export function measuresSection(now = new Date()): string[] {
  const b = boardCounts();
  const p = postingsAfterWeek(now);
  const pe = people();
  const caps = loadConfig().caps;
  const by = Object.entries(spendBy(entries().filter((e) => e.ts >= monthStart(now).toISOString())));
  return [
    "## Measures",
    "",
    `1. Boards: ${b.checked} reading fine, ${b.off.length} failing${b.partial ? ` · ${b.partial} read through their own search (partial)` : ""}`,
    ...b.off.map((o) => `   - ${o}`),
    `2. Applied postings: ${p.total} · a week on, ${p.up} still up, ${p.gone} gone${p.unknown ? `, ${p.unknown} couldn't be checked` : ""}${p.waiting ? ` · ${p.waiting} not a week old` : ""}`,
    `3. People found: ${
      [...pe.buckets]
        .map(([k, v]) => `${k} ${v.people} (messaged ${v.sent}, replied ${v.replied})`)
        .join(" · ") || "none"
    } · bounces aren't recorded (Gmail reads only the job label and your contacts)`,
    `4. Messages sent: ${pe.sent} · replies ${pe.replied} (${pct(pe.replied, pe.sent)})${pe.median !== null ? ` · median ${pe.median.toFixed(1)} h to reply` : ""}`,
    "",
    "## Spend",
    "",
    `- This month: ${usd(monthSpend(now))} of ${usd(caps.month_usd)} (real money only)${
      by.length ? ` · ${by.map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}` : ""
    }`,
    "",
  ];
}

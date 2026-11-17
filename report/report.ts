// The bug report: what failed lately, plus the state needed to see why, and the four outside
// measures with this month's spend, as one Markdown page to paste into Claude Code. It names keys only as set or not set, and holds no profile text.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadFilters } from "../ats/filters.ts";
import { INSTALL_BROWSER } from "../ats/render.ts";
import { open } from "../core/db.ts";
import { ROOT } from "../core/features.ts";
import { inOfflineSpan, offlineSpans } from "../core/online.ts";
import { dataDir } from "../core/paths.ts";
import { readState } from "../core/state.ts";
import { EVENTS, type Failure, failures, redact } from "../core/trace.ts";
import { watchedCompanies } from "../intake/companies.ts";
import { status } from "../setup/state.ts";
import { firstLine, measuresSection } from "./measures.ts";

export type Problem = { area: string; what: string; count: number; last: Failure };

/**
 * Failures since `since`, one row per area and subject, newest first. Not problems: the events
 * logged beside them (core/trace.ts EVENTS), and a board's failed read when it has read well since.
 */
export function problems(since: Date): Problem[] {
  const by = new Map<string, Problem>();
  const spans = offlineSpans();
  for (const f of failures(since)) {
    // An event, or a network failure while there was no internet (jobsignal repair offline).
    if (EVENTS.has(f.area) || inOfflineSpan(f.ts, f.error, spans)) continue;
    const key = `${f.area}\u0000${f.what}`;
    const p = by.get(key);
    if (p) {
      p.count++;
      p.last = f;
    } else by.set(key, { area: f.area, what: f.what, count: 1, last: f });
  }
  // Map order is first-seen; the last failure seen sorts first, ties included.
  return [...by.values()]
    .reverse()
    .sort((a, b) => b.last.ts.localeCompare(a.last.ts))
    .filter((p) => !READS.has(p.area) || lastRead(p.what) <= p.last.ts);
}

// Areas of a board's read ("ats" and "directory-boards" from before jobsignal.db): the subject is a
// board's URL or its company's domain, and a good read since clears it.
const READS = new Set(["refresh", "ats", "directory-boards"]);
/** The last good read of the board at this URL, or of any board of the company at this domain. */
function lastRead(what: string): string {
  const r = open()
    .query(
      `SELECT max(b.last_read_at) AS at FROM boards b JOIN companies c ON c.id = b.company_id
       WHERE b.url = $what OR c.domain = $what`,
    )
    .get({ what }) as { at: string | null };
  return r.at ?? "";
}

const tail = (file: string, n: number) =>
  existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n") : "(no file)";

function lines(file: string): number {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

function version(): string {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function chromium(): Promise<string> {
  try {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath()) ? "installed" : `missing (${INSTALL_BROWSER})`;
  } catch (err) {
    return `unavailable: ${(err as Error).message.slice(0, 80)}`;
  }
}

/**
 * What this Mac lacks, as a problem beside the failures: Playwright's browser. Careers pages that
 * need it wait without counting as failed (intake/refresh.ts), so nothing else would say so.
 */
export async function setupProblems(now = new Date()): Promise<Problem[]> {
  if (!(await chromium()).startsWith("missing")) return [];
  const error = `Not installed: careers pages that need it wait. Run ${INSTALL_BROWSER}`;
  return [
    {
      area: "setup",
      what: "Chromium",
      count: 1,
      last: { ts: now.toISOString(), area: "setup", what: "Chromium", error },
    },
  ];
}

export async function bugReport(hours = 24, now = new Date()): Promise<string> {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const ps = problems(since);
  const s = await status();
  const f = loadFilters();
  const w = watchedCompanies();
  const boards = new Map<string, number>();
  for (const c of w) {
    const b = open()
      .query("SELECT provider FROM boards WHERE company_id = ? AND status = 'ok' LIMIT 1")
      .get(c.id) as { provider: string } | null;
    const k = b?.provider ?? (c.discovery === "none" ? "nothing found" : "not checked yet");
    boards.set(k, (boards.get(k) ?? 0) + 1);
  }
  const jobsFile = path.join(dataDir(), "sources", "jobs.json");
  const ran = existsSync(jobsFile)
    ? (JSON.parse(readFileSync(jobsFile, "utf8")) as Record<
        string,
        { lastRun?: string; error?: string | null; result?: string }
      >)
    : {};
  // jobs.json keeps a job taken out since, its last run and error with it: only jobs that still run
  // are listed.
  const { discoverJobs, discoverSources } = await import("../intake/run.ts");
  const names = new Set((await discoverJobs()).map((j) => j.name));
  const sources = new Set((await discoverSources()).map((x) => x.key));
  const jobs = Object.entries(ran).filter(([k]) => names.has(k));
  const out = [
    "# Job Signal bug report",
    "",
    `Made ${now.toISOString()} · app ${version()} · Bun ${Bun.version} · data folder ${dataDir()}`,
    `Covers the last ${hours} hours. Keys are listed as set or not; no profile text is included.`,
    "",
    `## What failed (${ps.length})`,
    "",
    ...(ps.length
      ? ps.flatMap((p) => [
          `### ${p.area} · ${p.what}${p.count > 1 ? ` · ${p.count}×` : ""}`,
          "",
          `Last at ${p.last.ts}: ${firstLine(p.last.error)}`,
          ...(p.last.context ? ["", "```json", JSON.stringify(p.last.context, null, 1), "```"] : []),
          ...(p.last.stack ? ["", "```", p.last.stack, "```"] : []),
          "",
        ])
      : ["Nothing failed.", ""]),
    "## Setup",
    "",
    `- Runner: ${s.runner}`,
    `- Keys set: ${
      s.keys
        .filter((k) => k.set)
        .map((k) => k.name)
        .join(", ") || "none"
    }`,
    `- Keys not set: ${
      s.keys
        .filter((k) => !k.set)
        .map((k) => k.name)
        .join(", ") || "none"
    }`,
    `- Chromium: ${await chromium()}`,
    `- Filters: locations ${JSON.stringify(f.locations ?? [])}, remote ${f.remote_ok ? "ok" : "no"}, titles ${JSON.stringify(f.title_include ?? [])}`,
    `- Positioning page: ${s.positioning ? "yes" : "no"} · CV PDF in me/: ${s.cv ? "yes" : "no"}`,
    "",
    "## Sources",
    "",
    // state.json keeps a source taken out of the code since: only sources that still exist are listed.
    ...Object.entries(readState().sources)
      .filter(([k]) => sources.has(k))
      .map(
        ([k, v]) =>
          `- ${k}: ${v.connected ? "connected" : "not connected"}${v.enabled === false ? " (off)" : ""} · last ran ${v.lastRun ?? "never"} · last ok ${v.lastOk ?? "never"}${v.stat ? ` · ${v.stat}` : ""}${v.failures ? ` · ${v.failures} failures: ${v.reason}` : ""}`,
      ),
    "",
    "## Jobs",
    "",
    ...jobs.map(
      ([k, v]) =>
        `- ${k}: last ran ${v.lastRun ?? "never"}${v.error ? ` · failed: ${v.error}` : v.result ? ` · ${v.result}` : ""}`,
    ),
    "",
    "## Waiting",
    "",
    `- Leads with no company yet (pending, need the small model): ${lines(path.join(dataDir(), "sources", "pending.jsonl"))}`,
    `- Watchlist: ${w.length} companies · ${[...boards].map(([k, n]) => `${k} ${n}`).join(" · ") || "empty"}`,
    "",
    ...measuresSection(now),
    "## Scheduler log (last 30 lines)",
    "",
    "```",
    tail(path.join(dataDir(), "logs", "com.jobsignal.tick.log"), 30),
    "```",
    "",
  ];
  // Last line of defence: nothing token-like leaves in a pasted report.
  return redact(out.join("\n"));
}

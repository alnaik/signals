// Job boards: how a link names a board, the isolated runner that reads them, and the boards
// table (ats/boards.csv) that names a company's board from its name. What a read does to
// the store is intake/refresh.ts; finding a company's board is intake/discover.ts.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../core/config.ts";
import { politeGet, robotsException } from "../core/http.ts";
import { event } from "../core/trace.ts";
import { parseCsv } from "../dropfolder/adapters.ts";
// @ts-expect-error plain JS module
import * as links from "./links.mjs";
// @ts-expect-error plain JS module
import { ycSlug } from "./providers/yc.mjs";

export type Job = {
  id: string;
  title: string;
  url: string;
  location: string;
  postedAt: string | null;
  updatedAt?: string | null;
  description?: string;
};

const RUNNER = path.join(import.meta.dir, "runner.mjs");
// Job-board hosts: a link on one names a board, not a company (Add, intake, detection hints).
// They live in ats/links.mjs, which the runner reads too.
export const ATS_HOSTS: string[] = links.ATS_HOSTS;
export const ATS_URL: RegExp = links.ATS_URL;
// The hosts board search asks the search index about (sources/board-search), one query each.
// Dover isn't one: its postings are an app shell, and the index has none.
export const SEARCH_HOSTS = [
  "job-boards.greenhouse.io",
  "boards.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "myworkdayjobs.com",
  "apply.workable.com",
  "jobs.smartrecruiters.com",
].filter((h) => ATS_URL.test(h));

// Boards named by their subdomain, and ADP's one host (ats/links.mjs).
const { ADP, SUBDOMAIN_BOARD } = links;
// Of those, boards whose page path (and query) is the board itself: only a posting tail is cut.
const PATH_BOARD = /\.(eightfold\.ai|oraclecloud\.com|taleo\.net|workforcenow\.adp\.com|icims\.com)$/i;

/** The board's company slug: jobs.ashbyhq.com/plaid/… → "plaid", acme.recruitee.com → "acme". */
export const boardSlug: (url: string) => string | null = links.boardSlug;

/** The board itself from any link on it: jobs.ashbyhq.com/acme/<posting> → jobs.ashbyhq.com/acme. */
export function boardRoot(url: string): string | null {
  try {
    const u = new URL(url);
    // Workday's locale segment (/en-US/) is optional: the board is the same without it.
    if (/myworkdayjobs\.com$/i.test(u.hostname))
      return `${u.origin}${u.pathname.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, "").replace(/\/job\/.*$/, "")}`.replace(
        /\/$/,
        "",
      );
    if (ADP.test(u.hostname)) {
      const cid = u.searchParams.get("cid");
      const ccId = u.searchParams.get("ccId");
      if (!cid) return null;
      return `${u.origin}${u.pathname}?cid=${cid}${ccId ? `&ccId=${ccId}` : ""}`;
    }
    if (PATH_BOARD.test(u.hostname)) return u.href.replace(/#.*$/, "").replace(/\/job\/[^?]*/, "");
    if (SUBDOMAIN_BOARD.test(u.hostname)) return `${u.origin}/`;
    const parts = u.pathname.split("/").filter(Boolean);
    // Greenhouse's embedded form names its board in ?for= (/embed/job_app?for=stripe&token=…).
    const embedded = /greenhouse\.io$/i.test(u.hostname) && parts[0] === "embed" && u.searchParams.get("for");
    if (embedded) return `${u.origin}/${embedded}`;
    // Dover's board is /<slug>/careers/<client id>.
    const keep = /app\.dover\.com$/i.test(u.hostname)
      ? 3
      : parts[0] === "jobs" || parts[0] === "embed"
        ? 2
        : 1;
    if (parts.length < keep) return parts.length ? `${u.origin}/${parts.join("/")}` : null;
    return `${u.origin}/${parts.slice(0, keep).join("/")}`;
  } catch {
    return null;
  }
}

/** A detected board as stored: an ATS link cut to its board; any other page (a careers site) as is. */
export const atsRoot = (url: string): string => (ATS_URL.test(url) && boardRoot(url)) || url;

// A big company's own job site (ats/providers), stored as its search page whatever link found it
// (jobs.apple.com/app/en-us/profile/info, a Google Careers link with tracking parameters); a YC
// company's jobs page whatever YC or Work at a Startup link found it.
const OWN_SITE: Record<string, (url: URL) => string> = {
  apple: () => "https://jobs.apple.com/en-us/search",
  microsoft: () => "https://apply.careers.microsoft.com/careers",
  "google-careers": (u) =>
    `https://www.google.com/about/careers/applications/jobs/results/?${new URLSearchParams({ company: u.searchParams.get("company") ?? "" })}`,
  yc: (u) => `https://www.ycombinator.com/companies/${ycSlug(u.href)}/jobs`,
};
/** A board as stored, by its provider: a careers page as is, a big company's site as its search page, else atsRoot. */
export function boardUrl(provider: string, url: string): string {
  if (provider === "careers-page") return url;
  const own = OWN_SITE[provider];
  if (own)
    try {
      return own(new URL(url));
    } catch {}
  return atsRoot(url);
}

const GENERIC = new Set([
  "inc",
  "llc",
  "ltd",
  "corp",
  "the",
  "labs",
  "lab",
  "app",
  "technologies",
  "software",
  "group",
]);

/** Words of a company name worth matching: "Tessera Labs, Inc." → ["tessera"]. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
}

/** Does the name share a word with any of these (a domain's labels, a board slug)? */
export function sharesWord(name: string, ...targets: string[]): boolean {
  const words = nameWords(name);
  if (!words.length) return true;
  const squashed = targets.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
  return words.some((w) => squashed.some((t) => t.includes(w) || (t.length >= 4 && w.includes(t))));
}

export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const LEGAL = /,?\s+(inc|llc|l\.l\.c|ltd|corp|corporation|co|company|gmbh|plc|pbc)\.?$/i;
/** "Brindle Learning, Inc." → "brindlelearning": every trailing legal suffix goes, and a parenthesis. */
export function bare(s: string): string {
  // "Amazon Web Services (AWS)" → "Amazon Web Services".
  let t = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  while (LEGAL.test(t)) t = t.replace(LEGAL, "").trim();
  return squash(t);
}
/** "acme.co.uk" → "acme.co": the domain without its last label. */
export const label = (domain: string) => domain.split(".").slice(0, -1).join(".");

/** Case, punctuation and a trailing location don't make a different role. */
export function sameTitle(title: string, location = ""): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  let t = norm(title);
  const loc = norm(location);
  for (const tail of [loc, loc.split(" ")[0] ?? "", "remote", "hybrid"]) {
    if (tail && t.endsWith(` ${tail}`)) t = t.slice(0, -tail.length).trim();
  }
  return t;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Where each provider puts a posting's own id in its link. */
const ID_IN_URL: Record<string, RegExp[]> = {
  amazon: [/amazon\.jobs\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d+)/i],
  greenhouse: [/[?&]gh_jid=(\d+)/, /greenhouse\.io\/[^/?#]+\/jobs\/(\d+)/],
  lever: [new RegExp(`lever\\.co/[^/?#]+/(${UUID})`, "i")],
  ashby: [new RegExp(`ashbyhq\\.com/[^/?#]+/(${UUID})`, "i")],
  dover: [new RegExp(`dover\\.com/apply/[^/?#]+/(${UUID})`, "i")],
  // The segment after the title slug's underscore: "Systems-Engineer_R0244308" → "R0244308".
  // A repost's "-1" stays: two postings of one requisition can be listed side by side.
  workday: [/\/job\/(?:[^/?#]+\/)*[^/?#_]+_([A-Za-z0-9][A-Za-z0-9._-]*\d[A-Za-z0-9._-]*)(?:[/?#]|$)/],
  eightfold: [/\/job\/(\d+)/, /[?&]pid=(\d+)/],
  oraclecloud: [/\/job\/(\d+)/],
  smartrecruiters: [/smartrecruiters\.com\/[^/?#]+\/(\d{6,})/],
  workable: [/workable\.com\/(?:[^/?#]+\/)?j\/([0-9A-F]{6,})/i],
  successfactors: [/\/job\/[^/?#]+\/(\d+)\/?/],
};

/**
 * A posting's id, the same however it was read: from its link by the provider's own pattern
 * (amazon.jobs/…/jobs/<id>/, Greenhouse …/jobs/<id>, Lever's and Ashby's uuids, Workday's
 * requisition, Eightfold's and Oracle's job number), else the id the reader gave. Snapshots
 * keyed some boards by link and the readers by number; this keeps one row per posting.
 */
export function postingId(provider: string, url: string, id: string): string {
  for (const re of ID_IN_URL[provider] ?? []) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  return id;
}

/**
 * An Ashby posting in Ashby's embed view: jobs.ashbyhq.com/<slug>/<id>?embed=js. It still answers
 * where the company turned the hosted pages off (they answer 404), with the same form. Any other
 * link as it is.
 */
export function ashbyEmbedView(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "jobs.ashbyhq.com" || u.pathname.split("/").filter(Boolean).length < 2) return url;
    u.searchParams.set("embed", "js");
    return u.href;
  } catch {
    return url;
  }
}

/** "jobs.acme.co.uk" → "acme.co.uk": the name a company registered. */
export function registrable(host: string): string {
  const p = host
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const two = p.length > 2 && p.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(p.at(-2)!);
  return p.slice(two ? -3 : -2).join(".");
}

type Validators = { etag?: string; lastModified?: string };

/** HTTP requests the runner has made in this process (robots.txt included). */
export const runnerRequests = { count: 0 };

/**
 * A deadline for the runner calls made under it (discovery's budget): when its signal aborts,
 * a runner going is stopped and answers with what came back so far, and one not yet started
 * answers nothing. Work under it checks `pastDeadline()` before writing what it found.
 */
export const deadline = new AsyncLocalStorage<AbortSignal>();
export const pastDeadline = () => !!deadline.getStore()?.aborted;

/**
 * What a step of discovery leaves at its deadline, traced (logs/failures.jsonl, area "deadline"):
 * which step and which company, so the work thrown away there can be counted.
 */
export function leftAtDeadline(
  step: string,
  companies: { id: number; name: string }[],
  what = "left for the next tick",
): void {
  for (const c of companies) event("deadline", step, `${c.name} (${c.id}): ${what}`, { company: c.id });
}

// The runner process, swappable in tests.
let run: typeof runRunner = (mode, companies, onResult, o) => runRunner(mode, companies, onResult, o);
export function setRunner(fn: typeof run): void {
  run = fn;
}
/**
 * Run the runner (or a test's stand-in) and collect its results. `onResult` sees each one once,
 * as it comes, or at the end for a stand-in that only returns them.
 */
export async function runBoards(
  mode: "detect" | "scan",
  companies: RunnerCompany[],
  onResult?: (r: RunnerResult) => void | Promise<void>,
  o: RunnerOptions = {},
): Promise<RunnerResult[]> {
  const seen = new Set<string>();
  const results = await run(
    mode,
    companies,
    onResult &&
      (async (r) => {
        seen.add(r.domain);
        await onResult(r);
      }),
    o,
  );
  if (onResult) for (const r of results) if (!seen.has(r.domain)) await onResult(r);
  return results;
}

// The plain-HTML read of a page, swappable in tests.
let readPage: (
  url: string,
  v?: Validators & { accept?: string; maxBytes?: number },
) => Promise<{ text: string; notModified?: boolean } & Validators> = (url, v = {}) =>
  politeGet(url, { accept: "text/html", ...v });
export function setPageReader(fn: typeof readPage): void {
  readPage = fn;
}
export const getPage = (url: string, v?: Validators & { accept?: string; maxBytes?: number }) =>
  readPage(url, v);

export type RunnerCompany = {
  domain: string; // the key results come back under (a domain, or a board's id)
  site?: string; // detection: the company's site, when the key isn't it
  name: string;
  method?: string; // with `links`: how they were found (default "rendered page")
  ats?: { provider: string; careers_url: string };
  hint?: string;
  after?: string; // a board named in a lead's text: tried only when the site finds nothing
  links?: string[];
  page?: string; // the rendered page the links came from
  html?: string; // with `links`: that page's rendered DOM
  pages?: string[]; // detection: these pages (a careers site, a posting), their links and scripts only
  validators?: Validators; // the board's last read: a 304 is "unchanged"
  search?: string[]; // read through the board's own search for these terms
  searchAbove?: number; // with search: only if the board says it has more roles than this
  full?: boolean; // with posting text (discovery's confirming read)
  deadlineMs?: number; // a read's or a detection's time limit (default 120s)
};
/** workers: boards or companies at once (default 8). */
export type RunnerOptions = { workers?: number };
export type RunnerResult = {
  domain: string;
  ok: boolean;
  error?: string;
  jobs?: Job[];
  complete?: boolean; // false: a search that stopped at its page cap
  order?: number[][]; // a search newest first: each term's results in order, as indices into jobs
  searched?: boolean; // read through its search (a scan with searchAbove decides itself)
  boardSize?: number; // the count its search gave, when searchAbove asked for it
  unchanged?: boolean; // the board answered 304
  boardCount?: number; // how many roles the board says it has
  provider?: string; // the reader that read it (a scan whose provider the link named)
  validators?: Validators;
  detect?: Record<string, unknown>;
};

/**
 * Spawn the runner with a bare environment (no API keys can leak into vendored code). It prints
 * one line per company as each finishes; `onResult` sees each then, the return value all of them.
 */
export async function runRunner(
  mode: "detect" | "scan",
  companies: RunnerCompany[],
  onResult?: (r: RunnerResult) => void | Promise<void>,
  o: RunnerOptions = {},
): Promise<RunnerResult[]> {
  const signal = deadline.getStore();
  if (companies.length === 0 || signal?.aborted) return [];
  const cfg = loadConfig().polling;
  const proc = Bun.spawn([process.execPath, RUNNER], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: "/nonexistent",
      CAREER_OPS_ROOT: "/nonexistent",
      CAREER_OPS_HTTP_TIMEOUT_MS: "15000",
    },
    stdin: new Blob([
      JSON.stringify({
        mode,
        companies,
        ...(o.workers ? { workers: o.workers } : {}),
        userAgent: cfg.user_agent,
        minIntervalMs: 1000 / cfg.per_host_rps,
        robotsExceptions: loadConfig().robots.exceptions.map((x) => x.prefix),
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => proc.kill();
  signal?.addEventListener("abort", stop, { once: true });
  const err = new Response(proc.stderr).text();
  const results: RunnerResult[] = [];
  let buf = "";
  const decoder = new TextDecoder();
  let done = false;
  const take = async (line: string) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as RunnerResult & {
      done?: boolean;
      robotsExceptions?: string[];
      requests?: number;
    };
    if (msg.done) {
      for (const url of msg.robotsExceptions ?? []) robotsException(url);
      runnerRequests.count += msg.requests ?? 0;
      done = true;
      return;
    }
    results.push(msg);
    await onResult?.(msg);
  };
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      await take(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
    if (done) break;
  }
  signal?.removeEventListener("abort", stop);
  // Every answer is in. A read that hit its deadline was answered "timed out" but may still be
  // paging in the runner, which would hold this up until it ends (minutes): stop it. Stopped at
  // the caller's deadline: what came back so far.
  if (done || signal?.aborted) {
    proc.kill();
    return results;
  }
  await take(buf);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ATS runner failed: ${(await err).trim().split("\n").slice(-3).join(" ")}`);
  return results;
}

/** Boards a lead's text names: "Apply at https://jobs.ashbyhq.com/somana.tech/…" → that board. */
export function textBoards(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:https?:\/\/)?[\w.-]+\.[a-z]{2,}\/[^\s"'<>()]*/gi)) {
    const raw = m[0].replace(/[.,;:!?…]+$/, "");
    const url = /^https?:/i.test(raw) ? raw : `https://${raw}`;
    if (!ATS_URL.test(url)) continue;
    const root = boardRoot(url);
    if (root && !out.includes(root)) out.push(root);
  }
  return out;
}

// The boards table (ats/boards.csv, shipped with the app; `jobsignal boards export` writes it from
// an install's boards): companies and their public job boards as Job Signal found them, one a
// line: name, website, provider, board link. A lookup, not a work list: only a company a signal
// named is looked up, and a row counts only once a read says it's the company's: a job board by
// its confirming read here (fromTable), a careers page by discovery's own checks (discover.ts).
export type TableRow = { name: string; website: string; provider: string; url: string };
export type Board = {
  provider: string;
  slug: string; // Workday: tenant/site
  root: string; // the board, as boardRoot cuts it
  name?: string; // the company's name
  website?: string; // the company's own host, when its domain was proven
};
export const TABLE_FILE = path.join(import.meta.dir, "boards.csv");
let rows: TableRow[] | null = null;
/** The table's rows: the shipped file, read once; a test gives its own (core/testing.ts: none). */
export function tableRows(): TableRow[] {
  if (!rows) {
    const [head, ...lines] = parseCsv(readFileSync(TABLE_FILE, "utf8"));
    const at = (name: string) => head!.indexOf(name);
    rows = lines.map((r) => ({
      name: r[at("name")] ?? "",
      website: r[at("website")] ?? "",
      provider: r[at("provider")] ?? "",
      url: r[at("url")] ?? "",
    }));
  }
  return rows;
}
export function setTable(given: TableRow[] | null): void {
  rows = given;
}
/** The table's job boards, keyed provider:slug. */
export function readBoards(): Record<string, Board> {
  const out: Record<string, Board> = {};
  for (const r of tableRows()) {
    if (r.provider === "careers-page") continue;
    const key = boardKey(r.provider, r.url);
    out[key] = {
      provider: r.provider,
      slug: key.slice(r.provider.length + 1),
      root: r.url,
      ...(r.name ? { name: r.name } : {}),
      ...(r.website ? { website: r.website } : {}),
    };
  }
  return out;
}
/** The careers page the table gives this website (its own host, www or not), if any. */
export function tableCareersPage(domain: string): string | null {
  const site = domain.toLowerCase().replace(/^www\./, "");
  return tableRows().find((r) => r.provider === "careers-page" && r.website === site)?.url ?? null;
}
const TABLE_READS = 4; // candidates read per company: its site's first, then its name's
const TABLE_READ_MS = 20_000; // a confirming read that takes longer counts as no answer

// Readers' hosts that serve every company, the company named in the path (or query): keyed by host
// alone, every Gem board would be one board (Groq's took CloudRaft's, DeepSeek's, Moonshot's roles).
const TENANT_IN_PATH: [RegExp, (p: string[], u: URL) => string | false | null | undefined][] = [
  [/^jobs\.gem\.com$/, (p) => p[0]], // jobs.gem.com/<board>
  [/(^|\.)mokahr\.com$/, (p) => p[1]], // app.mokahr.com/social-recruitment/<org>/<site>
  [/^join\.com$/, (p) => p[0] === "companies" && p[1]], // join.com/companies/<slug>
  [/^jobs\.jobvite\.com$/, (p) => p[0]], // jobs.jobvite.com/<slug>
  [/^www\.comeet\.co$/, (p) => p[3]], // www.comeet.co/careers-api/2.0/company/<uid>/positions
  [/^secure\.collage\.co$/, (p) => p[1]], // secure.collage.co/jobs/<site>
  [/^careers\.pageuppeople\.com$/, (p) => p[0]], // careers.pageuppeople.com/<tenant>/<site>/<lang>
  [/^(www\.)?applitrack\.com$/, (p) => p[0]], // www.applitrack.com/<slug>/onlineapp
  [/^www\.(governmentjobs|schooljobs)\.com$/, (p) => p[0] === "careers" && p[1]], // …/careers/<agency>
  [/^jobs\.redroverk12\.com$/, (p) => p[0] === "org" && p[1]], // jobs.redroverk12.com/org/<id>
  [/\.myworkdaysite\.com$/, (p) => p[0] === "recruiting" && p[1] && `${p[1]}/${p[2] ?? ""}`], // …/recruiting/<tenant>/<site>
  [/^app\.eightfold\.ai$/, (_, u) => u.searchParams.get("domain")], // app.eightfold.ai/careers?domain=<domain>
];

/** One board however its link is written: provider and slug (Workday: tenant/site), else the host. */
export function boardKey(provider: string, url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const tenant = TENANT_IN_PATH.find(([re]) => re.test(host))?.[1](
      u.pathname.split("/").filter(Boolean),
      u,
    );
    if (tenant) return `${provider}:${host}/${tenant}`.toLowerCase();
    // One company's roles on Google Careers: the company filter is the board.
    if (provider === "google-careers")
      return `${provider}:${(u.searchParams.get("company") ?? "").toLowerCase()}`;
    // One host for every YC company: the company is the board.
    if (provider === "yc") return `${provider}:${ycSlug(url) ?? u.pathname}`;
    if (/myworkdayjobs\.com$/i.test(u.hostname)) {
      const site = new URL(boardRoot(url)!).pathname.split("/").filter(Boolean)[0] ?? "";
      return `${provider}:${u.hostname.split(".")[0]}/${site}`.toLowerCase();
    }
    if (ATS_URL.test(u.hostname)) return `${provider}:${boardSlug(url) ?? u.hostname}`.toLowerCase();
    return `${provider}:${u.hostname.replace(/^www\./, "")}`.toLowerCase();
  } catch {
    return `${provider}:${url}`;
  }
}

/** The table by every name a board answers to: its name, its slug (archer56 → archer too), its company's host. */
function tableIndex(table: Record<string, Board>): Map<string, Board[]> {
  const by = new Map<string, Board[]>();
  const put = (k: string, b: Board) => {
    if (!k) return;
    const list = by.get(k) ?? [];
    if (!list.includes(b)) list.push(b);
    by.set(k, list);
  };
  for (const b of Object.values(table)) {
    const head = b.slug.split("/")[0] ?? "";
    put(squash(head), b);
    put(squash(head.replace(/\d+$/, "")), b);
    if (b.name) put(bare(b.name), b);
    if (b.website) put(`site:${b.website}`, b);
  }
  return by;
}

/** Boards whose name or slug is the company's name or its domain's label, or whose site is the domain. */
export function tableCandidates(by: Map<string, Board[]>, name: string, domain: string): Board[] {
  const lab = squash(label(domain).split(".").at(-1) ?? "");
  const out = new Set<Board>();
  for (const k of [`site:${domain}`, bare(name), lab]) for (const b of (k && by.get(k)) || []) out.add(b);
  return [...out];
}
export const tableLookup = (table = readBoards()) => {
  const by = tableIndex(table);
  return (name: string, domain: string) => tableCandidates(by, name, domain);
};

export type Seen = { title: string; location?: string };
export type TableHit = { board: Board; jobs: Job[]; boardCount?: number };

/**
 * Workday's list carries no posting text, so a board named unlike the company (Medtronic's) can't
 * say whose it is. One posting's detail can: does it name the domain?
 */
async function workdayNames(job: Job | undefined, domain: string): Promise<boolean> {
  if (!job) return false;
  try {
    const u = new URL(job.url);
    const parts = u.pathname.split("/").filter(Boolean);
    const at = parts.indexOf("job");
    if (at < 1) return false;
    const tenant = u.hostname.split(".")[0];
    const detail = `${u.origin}/wday/cxs/${tenant}/${parts[at - 1]}/${parts.slice(at).join("/")}`;
    return (await readPage(detail, { accept: "application/json" })).text.toLowerCase().includes(domain);
  } catch {
    return false;
  }
}

/**
 * A company's board from the table. Its candidates (at most 4, its site's first) are read once
 * each; one counts only when a posting has a title the company was seen with, or the postings
 * name the company's domain. Of several, one with a seen title wins, then the most roles.
 */
export async function fromTable(
  companies: { key: string; name: string; domain: string | null; seen: Seen[] }[],
): Promise<Map<string, TableHit>> {
  const out = new Map<string, TableHit>();
  const table = companies.length ? readBoards() : {};
  if (!Object.keys(table).length) return out;
  const lookup = tableLookup(table);
  const cands = new Map(companies.map((c) => [c.key, lookup(c.name, c.domain ?? "").slice(0, TABLE_READS)]));
  const boards = new Map<string, Board>();
  for (const list of cands.values()) for (const b of list) boards.set(`${b.provider}:${b.slug}`, b);
  if (!boards.size) return out;
  // The board's key stands in for the company: one read per board, whichever companies it may be.
  const read = new Map(
    (
      await run(
        "scan",
        [...boards].map(([key, b]) => ({
          domain: key,
          name: b.name ?? b.slug,
          ats: { provider: b.provider, careers_url: b.root },
          full: true,
          deadlineMs: TABLE_READ_MS,
        })),
        undefined,
        { workers: 4 },
      )
    )
      .filter((r) => r.ok && r.jobs)
      .map((r) => [r.domain, r]),
  );
  for (const c of companies) {
    const want = new Set(c.seen.map((s) => sameTitle(s.title, s.location)));
    const kept: (TableHit & { titled: boolean })[] = [];
    for (const b of cands.get(c.key) ?? []) {
      const r = read.get(`${b.provider}:${b.slug}`);
      if (!r?.jobs) continue;
      const titled = r.jobs.some((j) => want.has(sameTitle(j.title, j.location)));
      const site = b.website ? registrable(b.website) : null;
      const named =
        (!!c.domain &&
          (r.jobs.some((j) => `${j.url} ${j.description ?? ""}`.toLowerCase().includes(c.domain!)) ||
            (!!site && site === registrable(c.domain)) ||
            (!titled && b.provider === "workday" && (await workdayNames(r.jobs[0], c.domain))))) ||
        false;
      if (titled || named) kept.push({ board: b, jobs: r.jobs, boardCount: r.boardCount, titled });
    }
    const pool = kept.some((k) => k.titled) ? kept.filter((k) => k.titled) : kept;
    const best = pool.sort((a, b) => b.jobs.length - a.jobs.length)[0];
    if (best) out.set(c.key, { board: best.board, jobs: best.jobs, boardCount: best.boardCount });
  }
  return out;
}

/**
 * The hash of a job list: the sorted (id, updated time) pairs, or (id, title, location) when the
 * board gives no update time. The same hash as last read means nothing changed.
 */
export function listHash(jobs: Job[]): string {
  const rows = jobs.map((j) => (j.updatedAt ? [j.id, j.updatedAt] : [j.id, j.title, j.location])).sort();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

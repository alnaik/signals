// A thread's roles, its status word and everything the board shows are pure functions of
// its log. This is what lets the index be rebuilt from folders.
import type { Entry } from "./log.ts";
import { isRunNote, type RoleStatus, type ThreadStatus } from "./vocab.ts";

export type Channel = {
  channel: string;
  value: string;
  confidence: "verified" | "pattern" | "guessed";
  source?: string;
  url?: string;
};

export type Fact = {
  id: string;
  n: number;
  group: string;
  text: string;
  source?: Entry["source"];
  ts: string;
  actor: string;
  used: boolean;
  failed: boolean;
  late: boolean; // new: from a watched search, or added by a provider after the run
};

// One line of the research block, with the fact numbers it rests on. A line with no fact,
// or resting on a fact whose link broke, is uncited and shown greyed.
export type Cited = { text: string; facts: number[]; uncited: boolean };
export type Research = {
  ts: string;
  problem: Cited;
  person: Cited & { name: string; role: string };
  proof: Cited & { budget: string };
  uncited: number;
};

export type Role = {
  key: string; // the posting's url, or its title when it has none
  title: string;
  location: string;
  url?: string;
  sourceTag: string;
  status: RoleStatus;
  since: string;
  reposted?: string;
};

export type Summary = {
  id: string;
  company: string;
  status: ThreadStatus | null;
  statusSince: string;
  closeReason: string | null;
  tonight: boolean; // researching, next in line behind a run going (the log's word: "tonight")
  needsYou: boolean;
  finished: boolean; // applied, never worked and nothing else going on: shown under Applied
  dropped: boolean; // every role dismissed or gone, one dismissed, never worked, nothing else going on: shown under Dismissed
  ran: "no person found" | "researched" | "run stopped" | "no website found" | null; // how the last Work run ended, shown when there's no status
  roles: Role[];
  lastTs: string;
  contact: { name: string; role: string } | null;
  problem: string | null; // the research block's Problem line
};

export type Detail = Summary & {
  facts: Fact[];
  channels: Channel[];
  research: Research | null;
  entries: Entry[];
};

// Closes written before the redesign; they still close the thread they're in.
const OLD_CLOSES: Record<string, string> = { hired: "hired", close_gone_quiet: "gone quiet" };

/** A url with its host as threads name it: lowercase, no www. */
function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.href;
  } catch {
    return url;
  }
}

// A contact the free gather wrote (worker/gather.ts) carries the person's confidence word, and
// its name comes from a fact it added. Contacts from before the redesign have no confidence:
// the old model run wrote the name from recall, sometimes "Unknown".
export function isGathered(d: Record<string, unknown>): boolean {
  const name = String(d.name ?? "").trim();
  return (
    ["verified", "pattern", "guessed"].includes(String(d.confidence)) &&
    !!name &&
    name.toLowerCase() !== "unknown"
  );
}

export function derive(log: Entry[], now = new Date()): Detail {
  const first = log[0];
  const start = first?.ts ?? now.toISOString();
  const s: Detail = {
    id: "",
    company: "",
    status: null,
    statusSince: start,
    closeReason: null,
    tonight: false,
    needsYou: false,
    finished: false,
    dropped: false,
    ran: null,
    roles: [],
    lastTs: start,
    contact: null,
    problem: null,
    facts: [],
    channels: [],
    research: null,
    entries: log,
  };

  // Where the conversation is: nothing yet, you wrote, they replied, or it's over.
  let phase: { word: "sent" | "replied" | "closed"; ts: string } | null = null;
  let researching: string | null = null; // Work pressed and no run has finished since
  let worked = false; // Work was pressed or a run ended, whoever it found: the thread stays in the list
  let lastRun: "done" | "stopped" | "no website" | null = null; // how the last worker run ended
  let stopped = 0; // runs that stopped early since; the second one leaves it to you
  let contactAt = start;
  let workerDoneAt: string | null = null;
  const roles = new Map<string, Role>();
  const failed = new Set<string>();
  let block: Entry | null = null;

  // A key from another read may name the posting's host with www. (Weave's gone notes on 2026-10-28).
  const role = (key: string | undefined) =>
    key
      ? (roles.get(key) ?? [...roles.values()].find((r) => r.url && bareUrl(r.url) === bareUrl(key)))
      : undefined;
  const setRole = (key: string | undefined, status: RoleStatus, ts: string) => {
    const r = role(key);
    if (r && r.status !== status) Object.assign(r, { status, since: ts });
  };
  const close = (reason: string, ts: string) => {
    phase = { word: "closed", ts };
    s.closeReason = reason;
  };

  for (const e of log) {
    s.lastTs = e.ts;
    const d = e.data ?? {};
    switch (e.kind) {
      case "signal": {
        if (d.company && !s.company) s.company = d.company;
        const title = d.title ?? "";
        if (d.kind !== "posting" && !title) break; // a post or bookmark: in the timeline only
        const key = e.source?.url ?? title.toLowerCase();
        if (!key || roles.has(key)) break;
        const location = d.location ?? (e.source?.quote ?? "").split(" · ").slice(2).join(" · ");
        roles.set(key, {
          key,
          title: title || "a role",
          location,
          ...(e.source?.url ? { url: e.source.url } : {}),
          sourceTag: d.source_tag ?? d.source ?? "",
          status: "apply",
          since: e.ts,
          ...(d.reposted ? { reposted: d.reposted } : {}),
        });
        break;
      }
      case "decision":
        switch (d.action) {
          case "apply":
            setRole(d.url, "apply", e.ts);
            if (phase?.word === "closed") {
              phase = null; // choosing a role at a closed company opens the thread again
              s.closeReason = null;
            }
            break;
          case "applied":
            setRole(d.url, "applied", e.ts);
            break;
          case "drop":
            if (d.url) setRole(d.url, "dismissed", e.ts);
            else close([d.reason, d.text].filter(Boolean).join(": ") || "dropped", e.ts);
            break;
          case "work":
            worked = true;
            researching = e.ts;
            stopped = 0;
            s.tonight = !!d.tonight;
            break;
          case "mark_sent":
            if (phase?.word !== "closed") phase = { word: "sent", ts: e.ts };
            break;
          case "got_reply":
            if (phase?.word !== "closed") phase = { word: "replied", ts: e.ts };
            break;
          case "close":
            close(String(d.reason ?? "").trim() || "closed", e.ts);
            break;
          case "no":
            close([d.reason, d.text].filter(Boolean).join(": ") || "no", e.ts);
            break;
          default:
            if (OLD_CLOSES[d.action]) close(OLD_CLOSES[d.action]!, e.ts);
        }
        break;
      case "note":
        // A final stop (it never got going) or the second stop leaves it to you.
        if (isRunNote(e, "run_done") || (isRunNote(e, "run_incomplete") && (d.final || ++stopped >= 2)))
          researching = null;
        if (isRunNote(e, "run_done")) workerDoneAt = e.ts;
        if (isRunNote(e, "run_done") || isRunNote(e, "run_incomplete")) {
          worked = true;
          lastRun = isRunNote(e, "run_done")
            ? "done"
            : d.text === "no website found"
              ? "no website"
              : "stopped";
        }
        if (d.event === "gone") setRole(d.url, "gone", e.ts);
        if (d.event === "linkcheck" && d.fact) {
          if (d.result === "failed") failed.add(d.fact);
          else failed.delete(d.fact);
        }
        break;
      case "sent":
        // A past application (imported) is an applied role, not a message.
        if (d.channel === "application") for (const r of roles.values()) setRole(r.key, "applied", e.ts);
        else if (phase?.word !== "closed") phase = { word: "sent", ts: e.ts };
        break;
      case "reply":
        if (phase?.word !== "closed") phase = { word: "replied", ts: e.ts };
        break;
      case "contact":
        if (!isGathered(d)) break; // from before the redesign: a Timeline line only
        s.contact = { name: d.name ?? "", role: d.role ?? "" };
        s.channels = d.channels ?? [];
        contactAt = e.ts;
        break;
      case "fact":
        s.facts.push({
          id: e.id,
          n: s.facts.length + 1,
          group: d.group ?? "product",
          text: d.text,
          source: e.source,
          ts: e.ts,
          actor: e.actor,
          used: false,
          failed: false,
          late: !!d.new || (workerDoneAt !== null && e.actor !== "worker" && e.actor !== "you"),
        });
        break;
      case "research":
        if (d.problem) block = e; // a research entry from before the redesign is a timeline line
        break;
      // Hypotheses, talking points, proof plans and problem tags from before the redesign
      // stay in the log and show only in the Timeline.
    }
  }

  // The status word: the conversation first, then the research, then who it found.
  const p = phase as { word: "sent" | "replied" | "closed"; ts: string } | null;
  if (p) [s.status, s.statusSince] = [p.word, p.ts];
  else if (researching) [s.status, s.statusSince] = ["researching", researching];
  else if (s.contact?.name) [s.status, s.statusSince] = ["person found", contactAt];
  if (s.status !== "closed") s.closeReason = null;
  if (s.status !== "researching") s.tonight = false;
  s.roles = [...roles.values()];
  s.needsYou =
    s.status !== "closed" &&
    (s.roles.some((r) => r.status === "apply") || s.status === "person found" || s.status === "replied");
  // Finished: applied, every other role dismissed or gone, and no Work run, conversation or person.
  // A Work run that found no one still keeps it in the list. Choosing another role brings it back.
  s.finished =
    s.status === null &&
    !worked &&
    s.roles.some((r) => r.status === "applied") &&
    s.roles.every((r) => r.status !== "apply");
  // Dropped: no role applied or waiting, at least one dismissed, and no Work run, conversation or person.
  s.dropped =
    s.status === null &&
    !worked &&
    s.roles.some((r) => r.status === "dismissed") &&
    s.roles.every((r) => r.status === "dismissed" || r.status === "gone");

  // Facts: which are failed, which the research block cites.
  for (const f of s.facts) f.failed = failed.has(f.id) || !f.source;
  if (block) {
    const byN = new Map(s.facts.map((f) => [f.n, f]));
    const cite = (l: { text?: string; facts?: number[] } | undefined): Cited => {
      const facts = (l?.facts ?? []).filter((n) => byN.has(n));
      for (const n of facts) byN.get(n)!.used = true;
      return { text: l?.text ?? "", facts, uncited: !facts.length || facts.some((n) => byN.get(n)!.failed) };
    };
    const d = block.data;
    s.research = {
      ts: block.ts,
      problem: cite(d.problem),
      person: { ...cite(d.person), name: d.person?.name ?? "", role: d.person?.role ?? "" },
      proof: { ...cite(d.proof), budget: d.proof?.budget ?? "" },
      uncited: 0,
    };
    s.research.uncited = [s.research.problem, s.research.person, s.research.proof].filter(
      (l) => l.uncited,
    ).length;
    s.problem = s.research.problem.text || null;
  }
  // With no status word, how the last run ended. A contact nothing verified (old runs: "Unknown",
  // or a name from the model's recall) counts as no one; a research block naming someone the
  // gather didn't confirm (a commit author) is shown in the Drawer, so the word doesn't deny it.
  if (s.status === null && lastRun)
    s.ran =
      lastRun === "no website"
        ? "no website found"
        : lastRun === "stopped"
          ? "run stopped"
          : s.research?.person.name
            ? "researched"
            : "no person found";
  return s;
}

export function summarize(id: string, log: Entry[], now = new Date()): Summary {
  const d = derive(log, now);
  const { facts, channels, research, entries, ...summary } = d;
  return { ...summary, id, company: summary.company || id };
}

export function detail(id: string, log: Entry[], now = new Date()): Detail {
  const d = derive(log, now);
  return { ...d, id, company: d.company || id };
}

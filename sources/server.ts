// The Sources screen's server half: each source in one of four states (On, Needs you, Paused,
// Off), the five steps' numbers, a step's section, and the retries and fixes it offers.
import { existsSync, mkdirSync } from "node:fs";
import { pdfs } from "../apply/me.ts";
import { loadConfig } from "../core/config.ts";
import { open } from "../core/db.ts";
import { politeGet } from "../core/http.ts";
import { setSecret } from "../core/keychain.ts";
import { backgroundToday } from "../core/ledger.ts";
import { backgroundLeft, claudeSignedIn, connection } from "../core/model.ts";
import { paths } from "../core/paths.ts";
import { readState } from "../core/state.ts";
import { backlogLines } from "../dropfolder/backlog.ts";
import { inboxCount } from "../inbox/query.ts";
import { askAfterNextRead, batchStatus, startBatch, stopBatch, waitingNow } from "../intake/batch.ts";
import { sourceDay, sourceEveryHours } from "../intake/due.ts";
import { discoverSources } from "../intake/run.ts";
import { checkLogin } from "../mail/imap.ts";
import { isAvailable, loadProviders, PRICE_NOTE } from "../providers/registry.ts";
import type { Handler, ServerFeature } from "../server/types.ts";
import { setSourceEnabled, setSourceValue, useFirst } from "../setup/state.ts";
import { ACCEPT, feedUrls, parseFeed, SUGGESTED } from "./feeds/index.ts";
import { FUNDS, picks } from "./funds/index.ts";
import { user as githubUser, USER, userExists } from "./github-stars/index.ts";
import { PASSWORD } from "./job-mail/index.ts";
import {
  costOf,
  funnel,
  items,
  notACompany,
  progress,
  queuedFrom,
  reasons,
  retryAll,
  retryOne,
  SOURCE_NAMES,
  STEPS,
  type Step,
  setByHand,
  sourceName,
  stopAll,
  undoNot,
} from "./pipeline.ts";

export type TileState = "on" | "needs" | "paused" | "off";
export type Tile = {
  key: string;
  name: string;
  what: string;
  state: TileState;
  broke?: boolean; // "Needs you" after it had worked: shown red, its status saying what broke
  status: string;
  companies: number | null; // named, each once, by the source of its first signal
  signals: number | null; // brought in, every one
  src: string | null; // the signals' source key, for the map
  enabled: boolean;
  waiting?: { id: number; line: string }[]; // the drop folder's big files, waiting for a yes
};

// What each source brings, in plain words, the source key its signals carry, and what it needs
// before it can run.
const ABOUT: Record<string, { what: string; src: string | null; name?: string; needs: string }> = {
  "job-mail": {
    what: "Job alert emails (LinkedIn, Grok and others), from a spare mailbox or a Gmail label.",
    src: "job-mail",
    needs: "needs a spare mailbox or Gmail connected",
  },
  "x-bookmarks": { what: "Posts you bookmark on X.", src: "x", needs: "needs X connected" },
  hn: { what: "The monthly “Who is hiring” thread.", src: "hn", name: "Hacker News", needs: "" },
  "board-search": {
    what: "A weekly web search for job boards in your cities.",
    src: "board-search",
    needs: "needs a web search connected",
  },
  "form-d": {
    what: "New US funding filings (SEC Form D) by companies in your state.",
    src: "form-d",
    name: "Funding filings",
    needs: "needs your email in About you",
  },
  funds: {
    what: "The companies a venture fund backs that are hiring, from the fund's job site.",
    src: "funds",
    needs: "tick a fund",
  },
  feeds: {
    what: "Newsletters and blogs (RSS or Atom). With a model: every hiring company an entry names. Without: only its links to a job board or a named company's site.",
    src: "feeds",
    needs: "add a feed",
  },
  "github-stars": {
    what: "The companies behind the GitHub repositories you star: an organisation with its own website, never a person's repository.",
    src: "github-stars",
    name: "GitHub stars",
    needs: "add your GitHub username",
  },
  gmail: {
    what: "Replies to your applications, read from Gmail.",
    src: null,
    name: "Gmail replies",
    needs: "needs Gmail connected",
  },
};
const HIDDEN = new Set(["board-poll"]); // off, and not offered

const fmt = (n: number) => n.toLocaleString("en-US");
const when = (key: string, s: string) =>
  sourceDay(key) !== undefined
    ? `weekly, ${String(loadConfig().source[key]?.day).replace(/^./, (c) => c.toUpperCase())}`
    : sourceEveryHours(key)
      ? `every ${sourceEveryHours(key)} hours`
      : s === "every_tick"
        ? "every 15 minutes"
        : s === "every_6h"
          ? "every 6 hours"
          : s === "nightly"
            ? "nightly"
            : s.replace("_", " ");

/** Every source as a tile, needs-you first. */
export async function tiles(): Promise<Tile[]> {
  const state = readState().sources;
  const f = funnel();
  const companies = (src: string | null) => (src ? (f.bySource[src]?.named ?? 0) : null);
  const signals = (src: string | null) => (src ? (f.bySource[src]?.signals ?? 0) : null);
  const out: Tile[] = [];
  for (const s of await discoverSources()) {
    if (HIDDEN.has(s.key)) continue;
    const st = state[s.key];
    const about = ABOUT[s.key] ?? { what: "", src: s.key, needs: "" };
    const enabled = st?.enabled ?? !s.off;
    const connected = await s.connected();
    const paused = connected && enabled ? s.paused?.() : undefined;
    let state_: TileState = "on";
    let status = `On · ${when(s.key, s.schedule)}${st?.stat ? ` · last run ${st.stat}` : ""}`;
    // It worked once (a run went through): a stop now is a break, said in one line.
    const broke = !!st?.lastOk;
    const lacks = about.needs
      ? about.needs.startsWith("needs ")
        ? `it ${about.needs}`
        : about.needs
      : "it isn't connected any more";
    if (!enabled) [state_, status] = ["off", "Off · switched off"];
    else if (!connected)
      [state_, status] = broke
        ? ["needs", `Stopped working: ${lacks}`]
        : // Never connected, but its signals came in another way (X's one-time export): said so.
          signals(about.src)
          ? [
              "off",
              `Off · ${fmt(signals(about.src)!)} signals already in; ${
                about.needs.startsWith("needs ")
                  ? `new ones need ${about.needs.slice(6)}`
                  : `for new ones, ${about.needs || "set it up"}`
              }`,
            ]
          : ["off", `Off · ${about.needs || "not set up"}`];
    else if ((st?.failures ?? 0) >= 3)
      [state_, status] = [
        "needs",
        `${broke ? "Stopped working: the" : "The"} last ${st!.failures} reads failed${st?.reason ? ` (${st.reason})` : ""}`,
      ];
    else if (paused) [state_, status] = ["paused", paused];
    out.push({
      key: s.key,
      name: (about.src && SOURCE_NAMES[about.src]) || about.name || s.name,
      what: about.what,
      state: state_,
      ...(state_ === "needs" && broke ? { broke: true } : {}),
      status,
      companies: companies(about.src),
      signals: signals(about.src),
      src: about.src,
      enabled,
    });
  }
  // The drop folder: anything dropped, its big files parked until you say sort.
  const waiting = backlogLines().filter((b) => b.sort);
  out.push({
    key: "drop",
    name: "Files",
    what: "Anything you drop in the drop folder: exports, CSVs, lists of links.",
    state: waiting.length ? "needs" : "on",
    status: waiting.length ? waiting.map((b) => b.line).join("; ") : "On · read as files land",
    companies: companies("drop"),
    signals: signals("drop"),
    src: "drop",
    enabled: true,
    waiting: waiting.map((b) => ({ id: b.id, line: b.line })),
  });
  out.push({
    key: "hand",
    name: SOURCE_NAMES.hand!,
    what: "A company you type in yourself.",
    state: "on",
    status: "Always on",
    companies: companies("hand"),
    signals: null,
    src: "hand",
    enabled: true,
  });
  const rank: Record<TileState, number> = { needs: 0, on: 1, paused: 2, off: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state]);
}

// The web lookups: one is picked, the rest are extras behind it, each with its price line.
const LOOKUPS = new Set(["contextdev", "parallel", "exa", "firecrawl"]);

export async function lookups() {
  const all = (await loadProviders()).filter((p) => LOOKUPS.has(p.name));
  const order = loadConfig().providers.search ?? [];
  const connected = all.filter(isAvailable).map((p) => p.name);
  const first = order.find((n) => connected.includes(n)) ?? null;
  return {
    providers: all.map((p) => ({
      name: p.name,
      label: p.label,
      free: p.price ?? "",
      connected: connected.includes(p.name),
      key: p.key ?? null,
    })),
    first,
    note: PRICE_NOTE,
  };
}

/**
 * The rail's block: how many sources are on, the ones that need you by name, and what came in
 * today (since local midnight), as signals and as new companies.
 */
export async function summary(now = new Date()) {
  const ts = await tiles();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  const n = (sql: string) => (open().query(sql).get(since) as { n: number }).n;
  return {
    on: ts.filter((t) => t.state === "on").length,
    total: ts.length,
    needs: ts
      .filter((t) => t.state === "needs")
      .map((t) => ({ key: t.key, name: t.name, status: t.status, broke: !!t.broke })),
    today: {
      signals: n("SELECT count(*) AS n FROM signals WHERE received_at >= ?"),
      companies: n("SELECT count(*) AS n FROM companies WHERE created_at >= ? AND dismissed_at IS NULL"),
    },
  };
}

/** The model, as the screen says it: what runs it, or what is missing. */
export function model() {
  const on = connection();
  const s = claudeSignedIn();
  const day = backgroundLeft();
  return {
    on,
    // The small model's background calls today; on the subscription, against its day limit.
    today: backgroundToday(),
    limit: day?.limit ?? null,
    line:
      on === "subscription"
        ? `The small model runs on your Claude Code subscription${s.plan ? ` (${s.plan})` : ""}.`
        : on === "api-key"
          ? "The small model runs on your Anthropic API key."
          : null,
  };
}

const isStep = (s: unknown): s is Step => STEPS.includes(s as Step);
const post =
  (fn: (b: Record<string, unknown>) => unknown): Handler =>
  async (req) => {
    try {
      const out = await fn(await req.json());
      return Response.json(typeof out === "string" ? { toast: out } : (out ?? { ok: true }));
    } catch (err) {
      return Response.json({ toast: (err as Error).message }, { status: 400 });
    }
  };
const step = (b: Record<string, unknown>): Step => {
  if (!isStep(b.step)) throw new Error("Unknown step");
  return b.step;
};

export const feature: ServerFeature = {
  name: "sources",
  routes: {
    "/api/sources": {
      GET: async () => {
        const f = funnel();
        return Response.json({
          tiles: await tiles(),
          funnel: f,
          inbox: inboxCount(),
          names: Object.fromEntries(Object.keys(f.bySource).map((k) => [k, sourceName(k)])),
          lookups: await lookups(),
          model: model(),
          // Companies waiting for their board, a batch run that finds them now, and how many a
          // dropped file brought.
          batch: { waiting: await waitingNow(), run: batchStatus(), fromFiles: queuedFrom("drop") },
          funds: FUNDS.map((f) => ({ key: f.key, name: f.name, picked: picks().includes(f.key) })),
          github: githubUser() || null,
          // What Start here offers when first run skipped it: a CV and the positioning page.
          me: { cv: pdfs().length > 0, positioning: existsSync(paths.me("positioning.md")) },
          feeds: {
            urls: feedUrls(),
            suggested: SUGGESTED.map((s) => ({ ...s, added: feedUrls().includes(s.url) })),
          },
        });
      },
    },
    "/api/sources/summary": { GET: async () => Response.json(await summary()) },
    "/api/sources/step": {
      GET: (req) => {
        const u = new URL(req.url);
        const s = u.searchParams.get("step");
        if (!isStep(s)) return Response.json({ toast: "Unknown step" }, { status: 400 });
        const reason = u.searchParams.get("reason") || null;
        const src = u.searchParams.get("source") || undefined;
        const after = u.searchParams.get("after") || undefined;
        const limit = Number(u.searchParams.get("limit")) || 10;
        const rs = reasons(s, src);
        return Response.json({
          reasons: rs,
          // The list's whole length, for "10 of 371".
          total: rs.filter((r) => !reason || r.k === reason).reduce((a, r) => a + r.n, 0),
          items: items(s, { reason: reason ?? undefined, src, after, limit }),
          // A further page needs only its items.
          ...(after ? {} : { fix: costOf(s, reason, src), progress: progress(s) }),
        });
      },
    },
    "/api/sources/retry": { POST: post((b) => retryOne(step(b), Number(b.id))) },
    "/api/sources/retry-all": {
      POST: post((b) =>
        retryAll(
          step(b),
          b.reason ? String(b.reason) : null,
          new Date(),
          b.source ? String(b.source) : undefined,
        ),
      ),
    },
    "/api/sources/stop": { POST: post((b) => stopAll(step(b))) },
    "/api/sources/batch": { POST: post(() => startBatch()) },
    "/api/sources/batch/stop": { POST: post(() => stopBatch()) },
    "/api/sources/batch/after-next-read": {
      POST: post((b) => {
        askAfterNextRead(!!b.on);
        return { ok: true };
      }),
    },
    "/api/sources/hand": { POST: post((b) => setByHand(step(b), Number(b.id), String(b.value ?? ""))) },
    "/api/sources/not": { POST: post((b) => notACompany(step(b), Number(b.id))) },
    "/api/sources/undo": {
      POST: post((b) => undoNot(step(b), Number(b.id), typeof b.prev === "number" ? b.prev : undefined)),
    },
    "/api/sources/switch": {
      POST: post((b) => {
        setSourceEnabled(String(b.key), String(b.name ?? b.key), !!b.enabled);
        // Board search is off until config says on: the tick writes it there too.
        if (b.key === "board-search") setSourceValue("board-search", "on", !!b.enabled);
        return b.enabled ? "Switched on" : "Switched off";
      }),
    },
    "/api/sources/drop-folder": {
      POST: post(() => {
        mkdirSync(paths.drop(), { recursive: true });
        Bun.spawn(["open", paths.drop()], { stdout: "ignore", stderr: "ignore" });
        return { ok: true };
      }),
    },
    "/api/sources/fund": {
      POST: post((b) => {
        const key = String(b.key);
        if (!FUNDS.some((f) => f.key === key)) throw new Error("Unknown fund");
        const now = picks().filter((k) => k !== key);
        if (b.on) now.push(key);
        setSourceValue("funds", "picks", now);
        // Ticking a fund is switching the source on; the last untick switches it off.
        setSourceEnabled("funds", "Fund portals", now.length > 0);
        return b.on ? "Ticked: its hiring companies come in at the next weekly read" : "Unticked";
      }),
    },
    "/api/sources/job-mail": {
      POST: post(async (b) => {
        const login = {
          host: String(b.host ?? "")
            .trim()
            .toLowerCase(),
          port: Number(b.port) || 993,
          user: String(b.user ?? "").trim(),
          password: String(b.password ?? "").trim(),
        };
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(login.host))
          throw new Error("The mail server is a name like imap.fastmail.com");
        if (!login.user || !login.password)
          throw new Error("The address and the app password are both needed");
        // Saved only once the mailbox opens read-only with them.
        const wrong = await checkLogin(login);
        if (wrong) throw new Error(`Couldn't open the mailbox: ${wrong}`);
        setSecret(PASSWORD, login.password);
        setSourceValue("job-mail", "imap_host", login.host);
        setSourceValue("job-mail", "imap_user", login.user);
        if (login.port !== 993) setSourceValue("job-mail", "imap_port", login.port);
        setSourceEnabled("job-mail", "Job mail", true);
        return "Connected: the mailbox is read every 6 hours, read-only";
      }),
    },
    "/api/sources/feed": {
      POST: post(async (b) => {
        const url = String(b.url ?? "").trim();
        const now = feedUrls().filter((u) => u !== url);
        if (b.on) {
          if (!/^https:\/\/[^/\s]+\.[^/\s]+/.test(url))
            throw new Error("A feed's address starts with https://");
          // Added only once it reads as a feed (robots.txt respected).
          const page = await politeGet(url, { accept: ACCEPT });
          if (!parseFeed(page.text, url).length)
            throw new Error("No entries there: is it the feed's own address?");
          now.push(url);
        }
        setSourceValue("feeds", "urls", now);
        setSourceEnabled("feeds", "Feeds", now.length > 0);
        return b.on ? "Added: its new entries are read within 6 hours" : "Removed";
      }),
    },
    "/api/sources/github-stars": {
      POST: post(async (b) => {
        const name = String(b.user ?? "")
          .trim()
          .replace(/^@/, "")
          .replace(/^https?:\/\/github\.com\//i, "")
          .replace(/\/.*$/, "");
        if (!name) {
          setSourceValue("github-stars", "user", "");
          setSourceEnabled("github-stars", "GitHub stars", false);
          return "Removed";
        }
        if (!USER.test(name)) throw new Error("A GitHub username is letters, digits and dashes");
        if (!(await userExists(name))) throw new Error(`GitHub has no user named ${name}`);
        setSourceValue("github-stars", "user", name);
        setSourceEnabled("github-stars", "GitHub stars", true);
        return "Added: your stars are read within 6 hours, a few dozen at a time";
      }),
    },
    "/api/sources/lookup": {
      POST: post(async (b) => {
        await useFirst(String(b.name));
        return "Saved: used first for web search and page reading";
      }),
    },
  },
};

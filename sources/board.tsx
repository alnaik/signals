// The Sources screen: each source as a tile in one of four states with its illustrated guide,
// the map of how a signal becomes roles (click a source to follow it, a step or a dashed box to
// open its section), and one step's section at a time: what it does, what stopped there and why,
// what is stuck, newest first, and the fix for all of them, with its cost on the button.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ago, safeHref, shortDate } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";

type TileState = "on" | "needs" | "paused" | "off";
type Tile = {
  key: string;
  name: string;
  what: string;
  state: TileState;
  broke?: boolean; // Needs you after it had worked: red
  status: string;
  companies: number | null;
  signals: number | null;
  src: string | null;
  enabled: boolean;
  waiting?: { id: number; line: string }[];
};
type Counts = { signals: number; named: number; website: number; board: number; roles: number };
type Data = {
  tiles: Tile[];
  funnel: Counts & {
    openRoles: number;
    bySource: Record<string, Counts>;
    stopped: Record<Step, number>;
    stoppedBy: Record<string, { signal: number; named: number }>;
  };
  inbox: number;
  names: Record<string, string>;
  lookups: {
    providers: { name: string; label: string; free: string; connected: boolean; key: string | null }[];
    first: string | null;
    note: string;
  };
  model: {
    on: "subscription" | "api-key" | null;
    line: string | null;
    today: number;
    limit: number | null;
  };
  batch: { waiting: number; run: BatchRun | null; fromFiles: number };
  funds: { key: string; name: string; picked: boolean }[];
  github: string | null;
  me: { cv: boolean; positioning: boolean };
  feeds: { urls: string[]; suggested: { url: string; name: string; added: boolean }[] };
};
// A batch run: every company waiting has its job board looked for now (intake/batch.ts).
type BatchRun = {
  started: string;
  total: number;
  done: number;
  boards: number;
  on: string;
  ended?: string;
  why?: string;
  running: boolean;
  partway: boolean; // its process died (the Mac restarted, a crash): Resume starts it again
  stopping: boolean;
};
type Step = "signal" | "named" | "website" | "board" | "roles";
type Post = {
  source: string;
  author: string | null;
  url: string | null;
  kind: string | null;
  at: string | null;
  title: string | null;
  text: string;
};
type BoardLine = {
  url: string;
  provider: string;
  broken: boolean;
  readAt: string | null;
  error: string | null;
  roles: number | null;
};
type Item = {
  id: number;
  cursor: string;
  label: string;
  source: string;
  reason: string;
  why: string;
  at: string | null;
  waiting: string | null;
  running: boolean;
  post?: Post;
  company?: {
    website: string | null;
    careers: string | null;
    note: string | null;
    noteAt: string | null;
    signals: number;
    latest: Post | null;
    boards: BoardLine[];
  };
};
const PAGE = 10; // stuck items a page
type Section = {
  reasons: { k: string; l: string; n: number }[];
  total: number;
  items: Item[];
  fix: { n: number; cost: string; how: string; checks: number; left: number | null; limit: number | null };
  progress: { total: number; left: number; stoppable: boolean } | null;
};

const fmt = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString("en-US"));
const STATE_WORD: Record<TileState, string> = { on: "On", needs: "Needs you", paused: "Paused", off: "Off" };

// ---------------------------------------------------------------------------------------------
// Drawings for the guides: line art, the accent in signal orange.

const ILL: Record<string, ReactNode> = {
  label: (
    <>
      <rect x="6" y="16" width="48" height="34" />
      <path d="M6 17 30 36 54 17" />
      <path className="a" d="M64 24h26v14H64l-6-7z" />
      <text x="67" y="34">
        Jobs
      </text>
    </>
  ),
  connect: (
    <>
      <rect x="4" y="18" width="36" height="26" />
      <path d="M4 19 22 33 40 19" />
      <path className="a" d="M44 31h12" strokeDasharray="3 3" />
      <rect x="60" y="12" width="32" height="38" />
      <path className="a" d="M67 31l5 5 11-11" />
    </>
  ),
  browser: (
    <>
      <rect x="4" y="6" width="88" height="52" />
      <path d="M4 16h88" />
      <circle cx="10" cy="11" r="1.5" />
      <circle cx="16" cy="11" r="1.5" />
      <path d="M26 11h40" />
      <path className="a" d="M38 26h7a4 4 0 0 1 8 0h7v8a4 4 0 0 1 0 8v8H38z" />
    </>
  ),
  export: (
    <>
      <path d="M8 14h36M8 28h36M8 42h36" />
      <path className="a" d="M48 9v9l3-2 3 2V9M48 37v9l3-2 3 2v-9" />
      <path d="M66 32h16l6 6v18H66z" />
      <path d="M82 32v6h6" />
      <path className="a" d="M77 6v18m-5-5 5 5 5-5" />
    </>
  ),
  drop: (
    <>
      <path d="M6 28h24l4 5h56v25H6z" />
      <path className="a w" d="M40 2h14l5 5v17H40z" />
      <path className="a" d="M54 2v5h5" />
      <path d="M34 8v10M66 8v10" strokeDasharray="2 3" />
    </>
  ),
  at: (
    <>
      <rect x="16" y="4" width="64" height="34" />
      <path d="M16 5 48 27 80 5" />
      <rect className="a" x="8" y="44" width="80" height="16" />
      <text className="ta" x="13" y="56">
        you@…
      </text>
    </>
  ),
  key: (
    <>
      <circle cx="24" cy="32" r="13" />
      <circle cx="24" cy="32" r="4" />
      <path className="a" d="M37 32h48M74 32v9M82 32v6" />
    </>
  ),
  pin: (
    <>
      <path className="a" d="M48 6c-9 0-15 6-15 14 0 10 15 24 15 24s15-14 15-24c0-8-6-14-15-14z" />
      <circle cx="48" cy="20" r="5" />
      <path d="M14 52h68M26 58h44" />
    </>
  ),
  thread: (
    <>
      <path d="M8 10h56M8 16h36" />
      <path d="M20 28h56M20 34h30" />
      <path d="M32 46h56M32 52h34" />
      <path className="a" d="M14 26v10" />
    </>
  ),
  sort: (
    <>
      <rect x="4" y="20" width="26" height="30" />
      <path d="M8 16h26v30" />
      <path d="M36 35h12m-4-4 4 4-4 4" />
      <rect className="a" x="58" y="6" width="32" height="22" />
      <path className="a" d="M67 17l4 4 9-9" />
      <rect x="58" y="36" width="32" height="22" />
      <path d="M69 42l10 10M79 42 69 52" />
    </>
  ),
  globe: (
    <>
      <circle cx="36" cy="32" r="22" />
      <ellipse cx="36" cy="32" rx="9" ry="22" />
      <path d="M14 32h44M18 20h36M18 44h36" />
      <circle className="a w" cx="72" cy="46" r="11" />
      <path className="a" d="M72 41v10M67 46h10" />
    </>
  ),
  flow: (
    <>
      <rect x="4" y="22" width="20" height="20" />
      <rect x="38" y="22" width="20" height="20" />
      <rect className="a" x="72" y="22" width="20" height="20" />
      <path d="M24 32h12M58 32h12" />
    </>
  ),
  check: (
    <>
      <rect x="34" y="16" width="30" height="30" />
      <path className="a" d="M41 31l6 6 11-11" />
    </>
  ),
};
export const Ill = ({ k }: { k: string }) => (
  <svg className="ill" viewBox="0 0 96 64" aria-hidden="true" focusable="false">
    {ILL[k]}
  </svg>
);

// A dropped file that brought this many companies offers a batch run on its tile.
const MANY = 20;

/**
 * How many companies wait for their job board, and "Find their boards now": a batch run that looks
 * for all of them in one go, beside the regular reads. While it runs, how far it has got and Stop;
 * after, how it ended; Resume when it stopped partway. Only this button (and the Files tile's, and
 * first run's tick box) starts one.
 */
function FindBoards({ d, act, reload }: { d: Data; act: Actions; reload: () => Promise<void> }) {
  const b = d.batch;
  const r = b.run;
  const running = !!r?.running;
  // While it runs its numbers move: asked again every few seconds.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [running, reload]);
  const start = async () => {
    await act.post("/api/sources/batch", {});
    await reload();
  };
  if (r?.running)
    return (
      <div className="batch">
        <p>
          <strong>Finding boards:</strong> {fmt(r.done)} of {fmt(r.total)} companies looked at ·{" "}
          {fmt(r.boards)} board{r.boards === 1 ? "" : "s"} found.
        </p>
        {r.on && <p className="muted">Now: {r.on}</p>}
        <div className="row">
          {r.stopping ? (
            <span className="muted">Stopping after the companies in hand…</span>
          ) : (
            <button
              type="button"
              className="small"
              onClick={async () => {
                await act.post("/api/sources/batch/stop", {});
                await reload();
              }}
            >
              Stop
            </button>
          )}
          <span className="muted">
            The regular reads go on meanwhile. It ends by itself when none are left, or at a daily limit.
          </span>
        </div>
      </div>
    );
  const recent = r?.ended && Date.now() - Date.parse(r.ended) < 86_400_000;
  if (!b.waiting && !recent) return null;
  return (
    <div className="batch">
      {r?.partway ? (
        <p>
          The last run to find boards stopped partway, at {fmt(r.done)} of {fmt(r.total)} companies (the Mac
          restarted, or it stopped on an error).
        </p>
      ) : (
        recent && (
          <p className="muted">
            Last run: {fmt(r!.done)} companies looked at, {fmt(r!.boards)} board{r!.boards === 1 ? "" : "s"}{" "}
            found. {r!.why}
          </p>
        )
      )}
      {b.waiting > 0 && (
        <>
          <p>
            {fmt(b.waiting)} compan{b.waiting === 1 ? "y is" : "ies are"} waiting to have their job board
            looked for. The regular reads look at a few every 15 minutes.
          </p>
          <div className="row">
            <button type="button" className="small" onClick={start}>
              {r?.partway ? "Resume" : "Find their boards now"}
            </button>
            <span className="muted">
              Looks for all of them now, in one go, inside your daily limits on web searches and background
              checks. You can stop it.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** "Fix them all" on the subscription: the checks it takes against what's left of today's. */
function checksLine(f: { checks: number; left: number | null; limit: number | null }): string {
  const left = f.left ?? 0;
  const head = `Needs up to ${fmt(f.checks)} background check${f.checks === 1 ? "" : "s"}; ${fmt(left)} left today.`;
  if (f.checks <= left) return head;
  const days = f.limit ? Math.ceil((f.checks - left) / f.limit) : 0;
  return `${head} The rest continue ${days <= 1 ? "tomorrow" : `over the next ${days} days`}.`;
}

type GStep = { i: string; t: string; p: ReactNode; c?: ReactNode };

/** A source's guide: what it does and its steps, each with a drawing and, where it takes one, a control. */
function guide(t: Tile, ctx: Ctx, act: Actions, d: Data): { intro: ReactNode; steps: GStep[] } {
  // Straight to the section or the key's row it names.
  const settings = (what: string, at: string) => (
    <button type="button" className="link" onClick={() => ctx.page("settings", { at })}>
      {what}
    </button>
  );
  const sw = <Switch t={t} act={act} />;
  switch (t.key) {
    case "hn":
      return {
        intro: "Nothing to connect: Hacker News is public.",
        steps: [
          {
            i: "thread",
            t: "The monthly thread is read",
            p: "Each month a “Who is hiring” thread opens. Every post in it is read, people offering themselves left out.",
          },
          {
            i: "pin",
            t: "Only your places and titles count",
            p: (
              <>
                Posts for places you didn't pick still name a company, but their roles stay out of your Inbox.
                Change them in {settings("Settings > About you", "set-about")}.
              </>
            ),
            c: sw,
          },
        ],
      };
    case "x-bookmarks":
      return {
        intro:
          "Steps 1 and 2 keep new bookmarks coming. To bring in bookmarks you made before, do steps 3 to 5 once.",
        steps: [
          {
            i: "key",
            t: "Add the X app's key in Settings",
            p: (
              <>
                In the X developer console, make an app (Native App, OAuth 2.0) and set a spend limit: X
                charges per post read. Paste its Client ID in {settings("Settings > Keys", "key-x_client_id")}
                .
              </>
            ),
          },
          {
            i: "connect",
            t: "Connect X",
            p: "Press Connect X and sign in to X in the browser tab that opens.",
            c: (
              <>
                <ConnectButton service="x" name="X" again={t.state === "on"} act={act} />
                {sw}
              </>
            ),
          },
          {
            i: "browser",
            t: "Install the export add-on",
            p: "In your browser, install the add-on called “twitter-web-exporter”.",
          },
          {
            i: "export",
            t: "Export your bookmarks",
            p: "Open your bookmarks on X, press the add-on's Export button and save the file.",
          },
          {
            i: "drop",
            t: "Drop the file in the drop folder",
            p: "A big file waits under Files until you say yes to sorting it.",
            c: <DropButton act={act} />,
          },
        ],
      };
    case "job-mail":
      return {
        intro: (
          <>
            Recommended: a spare mailbox that only gets job mail. Never give Job Signal your main mailbox's
            password. Already on Gmail? Its read-only label works too: see{" "}
            <button type="button" className="link" onClick={() => act.show("gmail")}>
              Gmail replies' steps
            </button>
            , with alerts under the Job Signal label.
          </>
        ),
        steps: [
          {
            i: "at",
            t: "Make a spare mailbox",
            p: "A new address used only for job mail, at any provider that offers app passwords (Fastmail, iCloud, Gmail with 2-step verification).",
          },
          {
            i: "connect",
            t: "Send job mail there",
            p: "Sign up for alerts (LinkedIn, Wellfound, newsletters) with it, or forward them from your main mailbox with a filter. Forwarded mail is read as the original.",
          },
          {
            i: "key",
            t: "Make an app password",
            p: "In the spare mailbox's security settings, make an app password for “Job Signal”. Not your main mailbox's password, and not its login password.",
          },
          {
            i: "check",
            t: "Connect it",
            p: "Read-only: mail is never sent, moved, marked or deleted. LinkedIn and Grok mail have their own readers; other senders need the model.",
            c: <JobMailForm act={act} />,
          },
        ],
      };
    case "gmail":
      return {
        intro: "Read from your Gmail with a read-only connection: Job Signal never sends.",
        steps: [
          {
            i: "label",
            t: "Make a label for job mail",
            p: "In Gmail, make a label named Job Signal and a filter that puts alert emails under it.",
          },
          {
            i: "key",
            t: "Add Gmail's two keys",
            p: (
              <>
                Follow docs/gmail-setup.md for a Desktop client, then paste its ID and secret in{" "}
                {settings("Settings > Keys", "key-gmail_client_id")}.
              </>
            ),
          },
          {
            i: "connect",
            t: "Connect Gmail",
            p: "Press Connect Gmail and allow read-only access in the browser tab that opens.",
            c: (
              <>
                <ConnectButton service="gmail" name="Gmail" again={t.state === "on"} act={act} />
                {sw}
              </>
            ),
          },
        ],
      };
    case "form-d":
      return {
        intro:
          "The SEC asks everyone who reads its filings for a contact email. It goes with each request to the SEC, and nowhere else.",
        steps: [
          {
            i: "at",
            t: "Your email",
            p: <>Type it once in {settings("Settings > About you", "set-about")}.</>,
          },
          {
            i: "pin",
            t: "Your state",
            p: "A state in your places (“Colorado”, or “Denver, CO”) brings companies there that just raised money.",
          },
          {
            i: "check",
            t: "It runs nightly",
            p: "New filings are read each night; companies that raised $1M or more come in.",
            c: sw,
          },
        ],
      };
    case "board-search":
      return {
        intro: "Searches the web each week for job postings in your cities on the job boards companies use.",
        steps: [
          {
            i: "key",
            t: "Connect a web search",
            p: (
              <>
                Pick one in the{" "}
                <button type="button" className="link" onClick={() => act.show("lookup")}>
                  Search and page reading
                </button>{" "}
                tile: each search uses one of your monthly searches.
              </>
            ),
          },
          {
            i: "pin",
            t: "It searches your cities",
            p: <>For your titles in the places you set in {settings("Settings > About you", "set-about")}.</>,
          },
          {
            i: "check",
            t: "Switch it on",
            p: "It has its own share of searches a month and picks up where it stopped.",
            c: sw,
          },
        ],
      };
    case "funds":
      return {
        intro:
          "A fund's job site lists the companies it backs. Tick a fund: its companies that are hiring come in once a week, each once.",
        steps: [
          {
            i: "check",
            t: "Tick a fund",
            p: "Only funds whose job sites allow reading are here. Y Combinator and the funds whose job sites run on Consider or Getro (Sequoia, Accel and others) aren't: their terms forbid reading by a program.",
            c: <FundTicks d={d} act={act} />,
          },
          {
            i: "globe",
            t: "Their websites are checked",
            p: "The fund names each company's website; it counts once the company's own homepage names it.",
          },
          {
            i: "pin",
            t: "Your titles and places pick the roles",
            p: (
              <>
                Each company's board is found and read; roles that fit {settings("About you", "set-about")} go
                to your Inbox.
              </>
            ),
          },
        ],
      };
    case "feeds":
      return {
        intro: d.model.on
          ? "A model is connected: the small model names the hiring companies in each new entry, with their websites when the entry links them."
          : "No model connected: only links to a company's job board, or to a website the link's own text names, come in. With a model, the small model names every hiring company an entry is about.",
        steps: [
          {
            i: "globe",
            t: "Add a feed",
            p: "Paste its address (RSS or Atom). Most newsletters have one: a Substack's is its address with /feed.",
            c: <FeedAdd d={d} act={act} />,
          },
          {
            i: "check",
            t: "Or start with this one",
            p: "Off until you add it.",
            c: (
              <>
                {d.feeds.suggested.map((s) => (
                  <button
                    key={s.url}
                    type="button"
                    disabled={s.added}
                    onClick={async () => {
                      await act.post("/api/sources/feed", { url: s.url, on: true });
                      act.reload();
                    }}
                  >
                    {s.added ? `${s.name}: added` : `Add ${s.name}`}
                  </button>
                ))}
              </>
            ),
          },
          {
            i: "pin",
            t: "Your titles and places pick the roles",
            p: (
              <>
                Each company's board is found and read; roles that fit {settings("About you", "set-about")} go
                to your Inbox.
              </>
            ),
          },
        ],
      };
    case "github-stars":
      return {
        intro:
          "Your public stars on GitHub: a repository an organisation owns, with a website of its own, brings that company in, with the repository as the reason. People's repositories, foundations, universities and lists are left out.",
        steps: [
          {
            i: "at",
            t: "Your GitHub username",
            p: "No key needed: your stars are public. Read once in full, a few dozen at a time, then only new ones.",
            c: <GithubUser d={d} act={act} />,
          },
          {
            i: "key",
            t: "Optional: a GitHub token",
            p: (
              <>
                GitHub allows 60 requests an hour without one, which makes the first read slow. A token in{" "}
                {settings("Settings > Keys", "key-github")} raises it to 5,000.
              </>
            ),
          },
          {
            i: "check",
            t: d.model.on ? "The model checks each one" : "Only clear companies",
            p: d.model.on
              ? "The small model is asked whether each organisation is a company that hires; when unsure, it's left out."
              : "No model connected: only organisations whose website is their own .com, .ai or similar come in.",
          },
        ],
      };
    case "drop":
      return {
        intro: "For anything without its own source: exports, spreadsheets saved as CSV, lists of links.",
        steps: [
          {
            i: "drop",
            t: "Drop a file in the drop folder",
            p: "Any export, CSV or list of links; one link or company per line works too.",
            c: <DropButton act={act} />,
          },
          {
            i: "sort",
            t: "Say yes to sorting a big one",
            p: "A file of more than 150 posts waits for you, as sorting it takes the small model. It shows under Signal in, below.",
          },
        ],
      };
    case "hand":
      return {
        intro: "Know a company already? Add it yourself.",
        steps: [
          {
            i: "globe",
            t: "Paste a link",
            p: "The company's website, its careers page, or one of its job postings.",
            c: <HandAdd act={act} />,
          },
          {
            i: "flow",
            t: "It goes through the same steps",
            p: "It's on your Watchlist at once, and in your Inbox when it has roles that fit.",
          },
        ],
      };
    default:
      return { intro: "", steps: [{ i: "check", t: t.name, p: t.what, c: sw }] };
  }
}

export type Actions = {
  // `quiet`: the caller says what happened itself, on the row, instead of a toast.
  post: (url: string, body: unknown, quiet?: boolean) => Promise<Record<string, unknown>>;
  reload: () => void;
  show: (tile: string) => void; // opens a tile's guide and brings it into view
};

/** Sign in to X or Gmail from here: the browser opens once, the answer comes as a toast. */
function ConnectButton({
  service,
  name,
  again,
  act,
}: {
  service: string;
  name: string;
  again: boolean;
  act: Actions;
}) {
  return (
    <button type="button" className="small" onClick={() => act.post("/api/setup/connect", { service })}>
      {again ? `Connect ${name} again` : `Connect ${name}`}
    </button>
  );
}

function Switch({ t, act }: { t: Tile; act: Actions }) {
  if (["drop", "hand", "funds", "feeds", "github-stars"].includes(t.key)) return null;
  return (
    <label className="tick">
      <input
        type="checkbox"
        checked={t.enabled}
        onChange={async (e) => {
          await act.post("/api/sources/switch", { key: t.key, name: t.name, enabled: e.target.checked });
          act.reload();
        }}
      />{" "}
      {t.enabled ? "On: untick to switch it off" : "Off: tick to switch it on"}
    </label>
  );
}

function FundTicks({ d, act }: { d: Data; act: Actions }) {
  return (
    <fieldset className="ticks">
      <legend>Funds</legend>
      {d.funds.map((f) => (
        <label key={f.key} className="tick">
          <input
            type="checkbox"
            checked={f.picked}
            onChange={async (e) => {
              await act.post("/api/sources/fund", { key: f.key, on: e.target.checked });
              act.reload();
            }}
          />
          {f.name}
        </label>
      ))}
    </fieldset>
  );
}

export function JobMailForm({ act }: { act: Actions }) {
  const [f, setF] = useState({ host: "", user: "", password: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const field = (k: keyof typeof f, label: string, type: string, ph: string) => (
    <>
      <label htmlFor={`jm-${k}`}>{label}</label>
      <input
        id={`jm-${k}`}
        type={type}
        placeholder={ph}
        autoComplete="off"
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
    </>
  );
  return (
    <form
      className="ctl"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg("Opening the mailbox…");
        const r = await act.post("/api/sources/job-mail", f);
        setMsg(r.error ? String(r.toast ?? "Couldn't connect") : null);
        if (!r.error) {
          setF({ host: "", user: "", password: "" });
          act.reload();
        }
      }}
    >
      {field("host", "Mail server (IMAP)", "text", "imap.fastmail.com")}
      {field("user", "Spare mailbox address", "email", "jobs@example.com")}
      {field("password", "Its app password", "password", "app password")}
      <button type="submit" className="primary" disabled={!f.host || !f.user || !f.password}>
        Connect
      </button>
      {msg && <p className="msg">{msg}</p>}
    </form>
  );
}

function GithubUser({ d, act }: { d: Data; act: Actions }) {
  const [v, setV] = useState(d.github ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (user: string) => {
    setMsg("Checking…");
    const r = await act.post("/api/sources/github-stars", { user });
    setMsg(r.error ? String(r.toast ?? "Couldn't save it") : null);
    if (!r.error) act.reload();
  };
  return (
    <>
      <label htmlFor="src-gh">GitHub username</label>
      <input id="src-gh" placeholder="octocat" value={v} onChange={(e) => setV(e.target.value)} />
      <button
        type="button"
        className="primary"
        disabled={!v.trim() || v.trim() === d.github}
        onClick={() => save(v)}
      >
        Save
      </button>
      {d.github && (
        <button
          type="button"
          className="link"
          onClick={() => {
            setV("");
            save("");
          }}
        >
          Remove
        </button>
      )}
      {msg && <p className="msg">{msg}</p>}
    </>
  );
}

function FeedAdd({ d, act }: { d: Data; act: Actions }) {
  const [v, setV] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <label htmlFor="src-feed">Feed address</label>
      <input
        id="src-feed"
        type="url"
        placeholder="https://example.substack.com/feed"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button
        type="button"
        className="primary"
        disabled={!v.trim()}
        onClick={async () => {
          setMsg("Reading it…");
          const r = await act.post("/api/sources/feed", { url: v.trim(), on: true });
          setMsg(r.error ? String(r.toast ?? "Couldn't add it") : null);
          if (!r.error) {
            setV("");
            act.reload();
          }
        }}
      >
        Add feed
      </button>
      {msg && <p className="msg">{msg}</p>}
      {d.feeds.urls.map((u) => (
        <p key={u} className="ok">
          <span className="mono">{u}</span>
          <button
            type="button"
            className="link"
            onClick={async () => {
              await act.post("/api/sources/feed", { url: u, on: false });
              act.reload();
            }}
          >
            Remove
          </button>
        </p>
      ))}
    </>
  );
}

function DropButton({ act }: { act: Actions }) {
  return (
    <button type="button" onClick={() => act.post("/api/sources/drop-folder", {})}>
      Show the drop folder
    </button>
  );
}

function HandAdd({ act }: { act: Actions }) {
  const [v, setV] = useState("");
  const [ask, setAsk] = useState<string | null>(null);
  // What came of it, kept in the tile: a toast alone is gone before it's read.
  const [msg, setMsg] = useState<string | null>(null);
  const go = async (confirm = false) => {
    const r = await act.post("/api/watchlist/add", {
      input: v.trim(),
      ...(confirm ? { confirm: true } : {}),
    });
    setMsg(r.toast ? String(r.toast) : null);
    if (r.ask) return setAsk(String(r.ask));
    setAsk(null);
    if (r.company) {
      setV("");
      act.reload();
    }
  };
  return (
    <>
      <label htmlFor="src-hand">Company link</label>
      <input
        id="src-hand"
        type="url"
        placeholder="https://cursor.com"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button type="button" className="primary" disabled={!v.trim()} onClick={() => go()}>
        Add company
      </button>
      {ask && (
        <p className="msg">
          {ask}{" "}
          <button type="button" className="link" onClick={() => go(true)}>
            Add it anyway
          </button>
        </p>
      )}
      {msg && !ask && <p className="msg">{msg}</p>}
    </>
  );
}

function TileCard({
  t,
  open,
  toggle,
  ctx,
  act,
  d,
}: {
  t: Tile;
  open: boolean;
  toggle: () => void;
  ctx: Ctx;
  act: Actions;
  d: Data;
}) {
  const g = open ? guide(t, ctx, act, d) : null;
  const label = open
    ? "Hide steps"
    : t.state === "off"
      ? "Set up"
      : t.state === "needs"
        ? "Fix this"
        : t.key === "hand"
          ? "Add a company"
          : "How it works";
  return (
    <article
      id={`tile-${t.key}`}
      className={`card${open ? " open" : ""}${t.state === "off" ? " is-off" : ""}`}
    >
      <div className="card-head">
        <i className={`mark ${t.broke ? "fail" : t.state}`} aria-hidden="true" />
        <h3>{t.name}</h3>
      </div>
      {t.signals || t.companies ? (
        <p className="cnum mono">
          {t.signals ? `${fmt(t.signals)} signals · ` : ""}
          {fmt(t.companies ?? 0)} companies
        </p>
      ) : null}
      <p className="what">{t.what}</p>
      <p className={`status ${t.broke ? "fail" : t.state}`}>
        <span className="vh">{STATE_WORD[t.state]}: </span>
        {t.status}
      </p>
      <div className="card-actions">
        <button type="button" aria-expanded={open} onClick={toggle}>
          {label}
        </button>
        {t.waiting?.map((b) => (
          <button
            key={b.id}
            type="button"
            className="primary"
            onClick={async () => {
              await act.post(`/api/backlogs/${b.id}/sort`, {});
              act.reload();
            }}
          >
            Sort now
          </button>
        ))}
        {t.key === "drop" && d.batch.fromFiles > MANY && !d.batch.run?.running && (
          <button
            type="button"
            className="primary"
            title={`${fmt(d.batch.fromFiles)} companies from your files are waiting for their job board`}
            onClick={async () => {
              await act.post("/api/sources/batch", {});
              act.reload();
            }}
          >
            Find their boards now
          </button>
        )}
      </div>
      {t.key === "drop" && d.batch.fromFiles > MANY && !d.batch.run?.running && (
        <p className="what">
          {fmt(d.batch.fromFiles)} companies from your files are waiting for their job board.
        </p>
      )}
      {g && (
        <div className="guide">
          {g.intro && <p className="intro">{g.intro}</p>}
          <ol
            className="gsteps"
            style={{ gridTemplateColumns: `repeat(${Math.max(2, g.steps.length)}, minmax(0, 1fr))` }}
          >
            {g.steps.map((s, i) => (
              <li key={s.t} className="gstep">
                <span className="gn">Step {i + 1}</span>
                <Ill k={s.i} />
                <h4>{s.t}</h4>
                <p>{s.p}</p>
                {s.c && <div className="ctl">{s.c}</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

/** Search and page reading: pick one, each with its free allowance; the others are extras behind it. */
function LookupTile({
  d,
  ctx,
  act,
  open,
  toggle,
}: {
  d: Data["lookups"];
  ctx: Ctx;
  act: Actions;
  open: boolean;
  toggle: () => void;
}) {
  const first = d.providers.find((p) => p.name === d.first);
  const state: TileState = first ? "on" : "off";
  return (
    <article id="tile-lookup" className={`card${open ? " open" : ""}${state === "off" ? " is-off" : ""}`}>
      <div className="card-head">
        <i className={`mark ${state}`} aria-hidden="true" />
        <h3>Search and page reading</h3>
      </div>
      <p className="what">Web search and page reading for finding websites and boards: pick one.</p>
      <p className={`status ${state}`}>
        {first
          ? `On · ${first.label} first`
          : "Off · none connected: websites and boards are found without the web search"}
      </p>
      <div className="card-actions">
        <button type="button" aria-expanded={open} onClick={toggle}>
          {open ? "Hide" : first ? "Change" : "Pick one"}
        </button>
      </div>
      {open && (
        <div className="guide">
          <p className="intro">
            One is enough. Its key goes in{" "}
            <button type="button" className="link" onClick={() => ctx.page("settings", { at: "set-keys" })}>
              Settings &gt; Keys
            </button>
            ; once saved, it's used. The others, connected too, are extras tried after it.
          </p>
          <p className="intro">{d.note}</p>
          <ul className="picks">
            {d.providers.map((p) => (
              <li key={p.name}>
                <label className="tick">
                  <input
                    type="radio"
                    name="lookup-first"
                    disabled={!p.connected}
                    checked={p.name === d.first}
                    onChange={async () => {
                      await act.post("/api/sources/lookup", { name: p.name });
                      act.reload();
                    }}
                  />
                  <strong>{p.label}</strong>
                </label>
                <span className="muted">
                  {p.free}
                  {p.connected ? (
                    " · connected"
                  ) : p.key ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="link"
                        onClick={() => ctx.page("settings", { at: `key-${p.key}` })}
                      >
                        add its key
                      </button>
                    </>
                  ) : (
                    " · no key yet"
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// The map

const STEPS: { k: Step | "inbox"; label: string; name: string; does: string }[] = [
  {
    k: "signal",
    label: "Step 1",
    name: "Signal in",
    does: "A post, alert email, thread entry or search result that might name a hiring company.",
  },
  {
    k: "named",
    label: "Step 2",
    name: "Company named",
    does: "Which company a signal is about: rules for alert emails, the small model for free-form posts.",
  },
  {
    k: "website",
    label: "Step 3",
    name: "Website proven",
    does: "The company's real website, with proof: it names the company, or the post links it.",
  },
  {
    k: "board",
    label: "Step 4",
    name: "Board found",
    does: "The company's careers page or job board, on its site or the board it links.",
  },
  {
    k: "roles",
    label: "Step 5",
    name: "Roles read",
    does: "Every open role on each board, read every 6 hours.",
  },
  { k: "inbox", label: "End", name: "Inbox", does: "Companies with roles that fit your titles and places." },
];

function MapView({
  d,
  sel,
  setSel,
  panel,
  setPanel,
  ctx,
}: {
  d: Data;
  sel: string | null;
  setSel: (s: string | null) => void;
  panel: Step | null;
  setPanel: (s: Step | null) => void;
  ctx: Ctx;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<{ w: number; h: number; paths: { d: string; c: string }[] }>({
    w: 0,
    h: 0,
    paths: [],
  });
  const f = d.funnel;
  const srcs = Object.entries(f.bySource)
    .filter(([, c]) => c.signals || c.named)
    .sort((a, b) => b[1].named - a[1].named);
  // Red on the map: a source that worked and stopped; one never set up isn't a failure.
  // A source's mark on the map is its tile's: one state, red if it worked and stopped.
  const markOf = (k: string) => {
    const t = d.tiles.find((x) => x.src === k);
    return t ? (t.broke ? "fail" : t.state) : "on";
  };
  const c: Counts = sel ? (f.bySource[sel] ?? { signals: 0, named: 0, website: 0, board: 0, roles: 0 }) : f;
  const vals = [c.signals, c.named, c.website, c.board, c.roles, sel ? null : d.inbox];
  const units = [
    "signals",
    "companies named",
    "with a proven website",
    "with a job board found",
    sel ? "companies with open roles" : `open roles, from ${fmt(f.roles)} companies`,
    sel ? "not split by source" : "companies in your Inbox",
  ];
  if (!sel) vals[4] = f.openRoles;
  // Steps 1 and 2 count posts, not companies: split by source on their own.
  const stopped = sel ? (f.stoppedBy[sel] ?? { signal: 0, named: 0 }) : f.stopped;
  const drops: { t: ReactNode; p: boolean }[] = [
    {
      t: (
        <>
          <b>{fmt(stopped.signal)}</b> signals wait for you to sort them
        </>
      ),
      p: stopped.signal > 0,
    },
    {
      t: (
        <>
          <b>{fmt(stopped.named)}</b> signals named no company
        </>
      ),
      p: stopped.named > 0,
    },
    {
      t: (
        <>
          <b>{fmt(c.named - c.website)}</b> companies have no proven website yet
        </>
      ),
      p: c.named > c.website,
    },
    {
      t: (
        <>
          <b>{fmt(c.website - c.board)}</b> companies have a website but no job board found
        </>
      ),
      p: c.website > c.board,
    },
    {
      t: (
        <>
          <b>{fmt(c.board - c.roles)}</b> companies' boards list no open roles
        </>
      ),
      p: c.board > c.roles,
    },
    { t: "Roles that don't fit your titles and places stay out on purpose: change them", p: false },
  ];

  useLayoutEffect(() => {
    const host = inner.current;
    if (!host) return;
    const draw = () => {
      const r0 = host.getBoundingClientRect();
      const rel = (el: Element) => {
        const r = el.getBoundingClientRect();
        return {
          l: r.left - r0.left,
          t: r.top - r0.top,
          r: r.right - r0.left,
          b: r.bottom - r0.top,
          h: r.height,
        };
      };
      const steps = [...host.querySelectorAll(".step")].map(rel);
      const dropEls = [...host.querySelectorAll(".drop")].map(rel);
      if (!steps.length) return;
      const ay = steps[0]!.t + 44;
      const paths: { d: string; c: string }[] = [];
      const head = (x: number, y: number) => ({
        d: `M${x - 6} ${y - 4} L${x} ${y} L${x - 6} ${y + 4}`,
        c: "w-step",
      });
      for (const b of host.querySelectorAll<HTMLElement>(".msrc")) {
        const r = rel(b);
        const sx = r.r;
        const sy = r.t + r.h / 2;
        const tx = steps[0]!.l - 1;
        let cls = "w-src";
        if (d.tiles.some((t) => t.broke && t.src === b.dataset.src)) cls += " fail";
        if (sel) cls += b.dataset.src === sel ? " hot" : " dim";
        paths.push({ d: `M${sx} ${sy} C ${sx + 30} ${sy}, ${tx - 30} ${ay}, ${tx} ${ay}`, c: cls });
      }
      paths.push(head(steps[0]!.l - 1, ay));
      for (let i = 0; i < steps.length - 1; i++) {
        paths.push({ d: `M${steps[i]!.r} ${ay} H${steps[i + 1]!.l - 1}`, c: "w-step" });
        paths.push(head(steps[i + 1]!.l - 1, ay));
      }
      dropEls.forEach((dr, i) => {
        const k = STEPS[i]!.k;
        const cls = `w-drop${k === panel ? " hot" : ""}`;
        if (i === 0) paths.push({ d: `M${steps[0]!.l + 16} ${steps[0]!.b} V${dr.t}`, c: cls });
        else {
          const gx = (steps[i - 1]!.r + steps[i]!.l) / 2;
          paths.push({ d: `M${gx} ${ay} V${dr.t + 14} H${dr.l}`, c: cls });
        }
      });
      setWires({ w: r0.width, h: r0.height, paths });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
  }, [sel, panel, d]);

  // The Inbox goes to the Inbox; what it keeps out is your titles and places, in About you.
  const openStep = (k: Step | "inbox") => {
    if (k === "inbox") ctx.page("inbox");
    else setPanel(panel === k ? null : k);
  };
  return (
    <div className={`map${sel ? " has-sel" : ""}`}>
      {sel && (
        <div className="follow">
          <span>
            Following <strong>{d.names[sel] ?? sel}</strong> only: the numbers are this source's own.
          </span>
          <button type="button" onClick={() => setSel(null)}>
            Show all sources
          </button>
        </div>
      )}
      <div className="map-inner" ref={inner}>
        <svg
          className="wires"
          width={wires.w}
          height={wires.h}
          viewBox={`0 0 ${wires.w} ${wires.h}`}
          aria-hidden="true"
          focusable="false"
        >
          {wires.paths.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: redrawn whole each time
            <path key={i} className={p.c} d={p.d} />
          ))}
        </svg>
        <div className="msrc-col">
          <h3>Sources</h3>
          {srcs.map(([k, n]) => (
            <button
              key={k}
              type="button"
              className="msrc"
              data-src={k}
              aria-pressed={sel === k}
              onClick={() => setSel(sel === k ? null : k)}
            >
              <i className={`mark ${markOf(k)}`} aria-hidden="true" />
              <span className="nm">
                {d.names[k] ?? k}
                {/* Signals in, like step 1; a source with none (by hand) counts its companies. */}
                <span className="ct">
                  {n.signals ? `${fmt(n.signals)} signals` : `${fmt(n.named)} companies`}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="stages">
          {STEPS.map((st, i) => {
            const on = st.k !== "inbox" && st.k === panel;
            return (
              <div className="stage" key={st.k}>
                <button
                  type="button"
                  className={`step${i === 5 ? " end" : ""}`}
                  aria-expanded={on}
                  onClick={() => openStep(st.k)}
                >
                  <span className="k">
                    {sel ? `${d.names[sel] ?? sel} · ` : ""}
                    {st.label}
                  </span>
                  <span className="sn">{st.name}</span>
                  <span className="big">{fmt(vals[i])}</span>
                  <span className="unit">{units[i]}</span>
                  <span className="does">{st.does}</span>
                </button>
                <button
                  type="button"
                  className={`drop${drops[i]!.p ? " problem" : ""}`}
                  aria-expanded={on}
                  onClick={() =>
                    st.k === "inbox" ? ctx.page("settings", { at: "set-about" }) : setPanel(st.k)
                  }
                >
                  <span className="dk">{i === 5 ? "Kept out" : "Stopped here"}</span>
                  {drops[i]!.t}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A step's section: the same four parts for every step

const SECTION: Record<Step, { n: string; title: string; does: string; hand: { l: string; ph: string } }> = {
  signal: {
    n: "Step 1 of 5",
    title: "Signal in",
    does: "A signal is anything that might name a hiring company: a post you bookmarked, an alert email, an entry in the Hacker News thread, a search result. Sources bring them in by themselves.",
    hand: { l: "Company name", ph: "Company name" },
  },
  named: {
    n: "Step 2 of 5",
    title: "Company named",
    does: "Which company each signal is about. Rules read alert emails; the small model reads free-form posts and checks they are about hiring.",
    hand: { l: "Company name", ph: "Company name" },
  },
  website: {
    n: "Step 3 of 5",
    title: "Website proven",
    does: "The company's real website, with proof: the site names the company, or the post links it.",
    hand: { l: "Company website", ph: "example.com" },
  },
  board: {
    n: "Step 4 of 5",
    title: "Board found",
    does: "The company's careers page or job board: first on its own website, then the board its pages link to, then a web search.",
    hand: { l: "Careers page or job board", ph: "example.com/careers" },
  },
  roles: {
    n: "Step 5 of 5",
    title: "Roles read",
    does: "Every open role on each board, every 6 hours. Roles that fit your titles and places go to your Inbox; the rest stay out on purpose.",
    hand: { l: "Careers page or job board", ph: "example.com/careers" },
  },
};
const SPLIT: Record<Step, keyof Counts> = {
  signal: "signals",
  named: "named",
  website: "website",
  board: "board",
  roles: "roles",
};

// When something happened: "Oct 29, 2 weeks ago".
const when = (at: string | null) => (at ? `${shortDate(at)}, ${ago(at)}` : "date not stored");
// A post is long when it won't fit three lines.
const isLong = (t: string) => t.length > 240 || t.split("\n").length > 3;
// A and B in the list's order (newest first): whether A comes before B.
const before = (a: string, b: string) => {
  const [ka, ia] = [a.slice(0, a.lastIndexOf("|")), Number(a.slice(a.lastIndexOf("|") + 1))];
  const [kb, ib] = [b.slice(0, b.lastIndexOf("|")), Number(b.slice(b.lastIndexOf("|") + 1))];
  return ka > kb || (ka === kb && ia > ib);
};

/** A signal, whole: who posted it, where and when, all of its text, and the way to the original. */
function PostView({ p, open, toggle }: { p: Post; open: boolean; toggle: () => void }) {
  const href = safeHref(p.url ?? undefined);
  // An HN or alert title is the text's first line: shown once.
  const title = p.title && !p.text.startsWith(p.title.slice(0, 40)) ? p.title : null;
  const text = p.text || (title ? "" : "No text stored.");
  return (
    <div className="post">
      <p className="post-h">
        <span className={p.author ? "who" : "who none"}>{p.author ?? "Poster not stored"}</span>
        {" · "}
        {p.source} · {when(p.at)}
        {" · "}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {p.kind === "posting" ? "Open the posting" : "Open the post"} ↗
          </a>
        ) : (
          <span className="none">No link stored</span>
        )}
      </p>
      {title && <p className="post-t">{title}</p>}
      {text && <p className={`post-x${open ? "" : " clamp"}`}>{text}</p>}
      {isLong(p.text) && (
        <button type="button" className="link" aria-expanded={open} onClick={toggle}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function BoardLines({ boards }: { boards: BoardLine[] }) {
  if (!boards.length) return null;
  return (
    <ul className="blines">
      {boards.map((b) => (
        <li key={b.url}>
          <a href={safeHref(b.url)} target="_blank" rel="noreferrer">
            {b.url.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
          {b.broken ? " · stopped working" : ""}
          {" · "}
          {b.readAt ? `read ${ago(b.readAt)}` : "not read yet"}
          {b.readAt && b.roles !== null ? ` · ${fmt(b.roles)} open roles` : ""}
          {b.error && <span className="err"> · last error: {b.error}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A company stuck at a step: its links, why it stopped, and what named it. */
function CompanyView({
  it,
  step,
  open,
  toggle,
}: {
  it: Item;
  step: Step;
  open: boolean;
  toggle: () => void;
}) {
  const c = it.company!;
  const host = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return (
    <div className="co">
      <p className="post-h">
        <span className="who">{it.label}</span>
        {" · "}
        {c.website ? (
          <a href={safeHref(c.website)} target="_blank" rel="noreferrer">
            {host(c.website)} ↗
          </a>
        ) : (
          <span className="none">no website known</span>
        )}
        {c.careers && (
          <>
            {" · "}
            <a href={safeHref(c.careers)} target="_blank" rel="noreferrer">
              careers page ↗
            </a>
          </>
        )}
      </p>
      {step !== "roles" && c.note && (
        <p className={`note-x${open ? "" : " clamp2"}`}>
          {it.waiting ? "What the last look found" : `Last look${c.noteAt ? ` (${ago(c.noteAt)})` : ""}`}:{" "}
          {c.note}
        </p>
      )}
      <BoardLines boards={c.boards} />
      {open && (
        <div className="named-by">
          <p className="nb-h">
            Named by {c.signals === 1 ? "1 signal" : `${fmt(c.signals)} signals`}
            {c.latest && c.signals > 1 ? "; the latest:" : c.latest ? ":" : ""}
          </p>
          {c.latest ? (
            <PostView p={c.latest} open toggle={() => {}} />
          ) : (
            <p className="none">No signal names it: it was added by hand or from a list.</p>
          )}
        </div>
      )}
      <button type="button" className="link" aria-expanded={open} onClick={toggle}>
        {open ? "Less" : step === "roles" ? "What named it" : "The whole note and what named it"}
      </button>
    </div>
  );
}

type Line = { key: number; text: string; undo?: () => Promise<void> };

function StepSection({
  step,
  d,
  src,
  close,
  act,
}: {
  step: Step;
  d: Data;
  src: string | null;
  close: () => void;
  act: Actions;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [s, setS] = useState<Section | null>(null);
  const [list, setList] = useState<Item[]>([]);
  const want = useRef(PAGE);
  const [more, setMore] = useState(false);
  const [handOpen, setHandOpen] = useState<number | null>(null);
  const [hand, setHand] = useState("");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<number, string>>({});
  const [said, setSaid] = useState<Record<number, { t: string; bad?: boolean }>>({});
  const [lines, setLines] = useState<Line[]>([]);
  // Rows you tried again or set by hand whose read is still to come: followed until it's done.
  const watched = useRef(new Map<number, Item>());
  // Opened from the map below the fold: brought into view.
  const top = useRef<HTMLElement>(null);
  const loaded = !!s;
  useEffect(() => {
    if (loaded) top.current?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const say = useCallback((text: string, undo?: () => Promise<void>) => {
    const key = Date.now() + Math.random();
    setLines((l) => [{ key, text, ...(undo ? { undo } : {}) }, ...l].slice(0, 5));
    setTimeout(() => setLines((l) => l.filter((x) => x.key !== key)), 15_000);
  }, []);
  const query = useCallback(
    (extra: Record<string, string>) =>
      new URLSearchParams({ step, ...(reason ? { reason } : {}), ...(src ? { source: src } : {}), ...extra }),
    [step, reason, src],
  );
  // The list as far as you've walked it, asked again whole: whatever left makes room for the next.
  const load = useCallback(async () => {
    const out = (await (
      await fetch(`/api/sources/step?${query({ limit: String(want.current) })}`)
    ).json()) as Section;
    setS(out);
    setList(out.items);
    // What came of the reads being followed.
    const last = out.items.at(-1)?.cursor;
    for (const [id, was] of watched.current) {
      const now = out.items.find((i) => i.id === id);
      if (!now) {
        if (last && before(last, was.cursor)) continue; // further down the list now, not gone
        watched.current.delete(id);
        say(`${was.label}: done, it moved on to the next step`);
      } else if (!now.running && !now.waiting) {
        watched.current.delete(id);
        setSaid((x) => ({ ...x, [id]: { t: `Tried again, still stuck: ${now.why}`, bad: true } }));
      }
    }
    return out;
  }, [query, say]);
  useEffect(() => {
    want.current = PAGE;
    watched.current.clear();
    void load();
  }, [load]);
  // The tick and other screens change the list: asked again when the board says so.
  useEffect(() => {
    const on = () => void load();
    window.addEventListener("inbox.changed", on);
    return () => window.removeEventListener("inbox.changed", on);
  }, [load]);
  // While a retry or a read you started is going, asked again every few seconds.
  const following = list.some((i) => i.running || (i.waiting && watched.current.has(i.id)));
  useEffect(() => {
    const every = s?.progress?.left ? 5000 : following ? 10_000 : 0;
    if (!every) return;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [s?.progress, following, load]);

  const showMore = async () => {
    const last = list.at(-1);
    if (!last) return;
    setMore(true);
    const out = (await (
      await fetch(`/api/sources/step?${query({ after: last.cursor, limit: String(PAGE) })}`)
    ).json()) as Section;
    setMore(false);
    want.current = list.length + PAGE;
    setList((l) => [...l, ...out.items.filter((i) => !l.some((x) => x.id === i.id))]);
    setS((x) => (x ? { ...x, reasons: out.reasons, total: out.total } : x));
  };

  const P = SECTION[step];
  const total = s?.total ?? 0;
  const all = s?.reasons.reduce((a, r) => a + r.n, 0) ?? 0;
  const max = Math.max(1, ...(s?.reasons.map((r) => r.n) ?? [1]));
  const picked = s?.reasons.find((r) => r.k === reason);
  const split = Object.entries(d.funnel.bySource)
    .map(([k, c]) => [k, c[SPLIT[step]]] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const toggle = (k: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  /** One item's action: said on its row while it goes; a row that leaves says so above the list. */
  const itemAct = async (it: Item, url: string, doing: string, body: Record<string, unknown> = {}) => {
    setBusy((x) => ({ ...x, [it.id]: doing }));
    setSaid(({ [it.id]: _, ...x }) => x);
    const r = await act.post(url, { step, id: it.id, ...body }, true);
    setBusy(({ [it.id]: _, ...x }) => x);
    if (r.error) {
      setSaid((x) => ({ ...x, [it.id]: { t: String(r.toast ?? "That didn't work"), bad: true } }));
      return null;
    }
    const out = await load();
    act.reload();
    const now = out.items.find((i) => i.id === it.id);
    if (!now) say(`${it.label}: ${r.toast}`);
    else {
      setSaid((x) => ({ ...x, [it.id]: { t: String(r.toast) } }));
      if (now.running || now.waiting) watched.current.set(it.id, now);
    }
    return r;
  };
  const notCompany = async (it: Item) => {
    // Out of the list at once; the next one takes its place when the list comes back.
    setList((l) => l.filter((x) => x.id !== it.id));
    const r = await act.post("/api/sources/not", { step, id: it.id }, true);
    if (r.error) {
      say(`${it.label}: ${r.toast}`);
      await load();
      return;
    }
    say(`Removed ${it.label}`, async () => {
      await act.post("/api/sources/undo", { step, id: it.id, prev: r.prev }, true);
      await load();
      act.reload();
    });
    await load();
    act.reload();
  };

  return (
    <section className="panel" aria-labelledby="panelTitle" ref={top}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">{P.n}</p>
          <h2 id="panelTitle">{P.title}</h2>
        </div>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
      <div className="panel-body">
        <div>
          <div className="blk">
            <h3>
              <span className="pn">1</span>What this step does
            </h3>
            <p>{P.does}</p>
            <p className="split">
              By source:{" "}
              {split.map(([k, n], i) => (
                <span key={k}>
                  {i > 0 && " · "}
                  {d.names[k] ?? k} <span className="mono">{fmt(n)}</span>
                </span>
              ))}
            </p>
          </div>
          <div className="blk">
            <h3>
              <span className="pn">2</span>Stopped here
              {src ? `, from ${d.names[src] ?? src}` : ""}
            </h3>
            <ul className="reasons">
              <li>
                <button
                  type="button"
                  className="reason"
                  aria-pressed={!reason}
                  onClick={() => setReason(null)}
                >
                  <span className="mono">{fmt(all)}</span>
                  <span>all reasons</span>
                </button>
              </li>
              {s?.reasons.map((r) => (
                <li key={r.k}>
                  <button
                    type="button"
                    className="reason"
                    aria-pressed={reason === r.k}
                    onClick={() => setReason(r.k)}
                  >
                    <span className="mono">{fmt(r.n)}</span>
                    <span>{r.l}</span>
                    <span className="rb" aria-hidden="true">
                      <i style={{ width: `${Math.max(2, Math.round((r.n / max) * 100))}%` }} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div>
          <div className="blk">
            <h3>
              <span className="pn">3</span>Stuck here, newest first
            </h3>
            {lines.length > 0 && (
              <ul className="gone">
                {lines.map((l) => (
                  <li key={l.key}>
                    {l.text}
                    {l.undo && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="link"
                          onClick={async () => {
                            setLines((x) => x.filter((y) => y.key !== l.key));
                            await l.undo!();
                          }}
                        >
                          Undo
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {s && list.length === 0 ? (
              <p className="muted">Nothing stuck here{picked ? " for this reason" : ""}.</p>
            ) : (
              <ul className="items">
                {list.map((it) => {
                  const msg = busy[it.id]
                    ? { t: busy[it.id]! }
                    : it.running
                      ? { t: "Reading it now…" }
                      : (said[it.id] ?? (it.waiting ? { t: it.waiting } : null));
                  return (
                    <li key={it.id} className="item">
                      {it.post ? (
                        <PostView
                          p={it.post}
                          open={opened.has(`t${it.id}`)}
                          toggle={() => toggle(`t${it.id}`)}
                        />
                      ) : (
                        <CompanyView
                          it={it}
                          step={step}
                          open={opened.has(`c${it.id}`)}
                          toggle={() => toggle(`c${it.id}`)}
                        />
                      )}
                      <p className="it-m">
                        Stopped: {it.why}
                        {it.company ? ` · first came from ${it.source}` : ""}
                      </p>
                      {msg && <p className={`it-s${"bad" in msg && msg.bad ? " bad" : ""}`}>{msg.t}</p>}
                      <div className="it-a">
                        <button
                          type="button"
                          className="small"
                          disabled={!!busy[it.id] || it.running}
                          onClick={() =>
                            itemAct(
                              it,
                              "/api/sources/retry",
                              step === "named" ? "Reading it again with the small model…" : "Lining it up…",
                            )
                          }
                        >
                          Try again
                        </button>
                        <button
                          type="button"
                          className="small"
                          aria-expanded={handOpen === it.id}
                          disabled={!!busy[it.id] || it.running}
                          onClick={() => {
                            setHandOpen(handOpen === it.id ? null : it.id);
                            setHand("");
                          }}
                        >
                          Set by hand
                        </button>
                        <button
                          type="button"
                          className="small"
                          disabled={!!busy[it.id] || it.running}
                          onClick={() => notCompany(it)}
                        >
                          Not a company
                        </button>
                      </div>
                      {handOpen === it.id && (
                        <form
                          className="it-f"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const r = await itemAct(it, "/api/sources/hand", "Saving…", { value: hand });
                            if (r) setHandOpen(null);
                          }}
                        >
                          <div>
                            <label htmlFor={`hand-${it.id}`}>{P.hand.l}</label>
                            <input
                              id={`hand-${it.id}`}
                              placeholder={P.hand.ph}
                              value={hand}
                              onChange={(e) => setHand(e.target.value)}
                            />
                          </div>
                          <button type="submit" className="small primary" disabled={!hand.trim()}>
                            Save
                          </button>
                          <button type="button" className="small" onClick={() => setHandOpen(null)}>
                            Cancel
                          </button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {s && list.length > 0 && (
              <div className="showing">
                <span>
                  Showing {fmt(list.length)} of {fmt(total)}
                  {picked ? `: ${picked.l}` : ""}. {list.length < total ? "" : "That's all of them."}
                  {!picked && s.reasons.length > 1 ? " Pick a reason to see only those." : ""}
                </span>
                {list.length < total && (
                  <button type="button" className="small" disabled={more} onClick={showMore}>
                    {more ? "Loading…" : `Show ${fmt(Math.min(PAGE, total - list.length))} more`}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="blk">
            <h3>
              <span className="pn">4</span>Fix them all
            </h3>
            <div className="bulk">
              {s?.progress ? (
                <>
                  <p>
                    {s.progress.left
                      ? `Trying again: ${fmt(s.progress.total - s.progress.left)} of ${fmt(s.progress.total)} done, ${fmt(s.progress.left)} to go. It goes on by itself; you can leave this screen.`
                      : `Tried again: all ${fmt(s.progress.total)} done.`}
                  </p>
                  {s.progress.left > 0 && s.progress.stoppable && (
                    <button
                      type="button"
                      onClick={async () => {
                        await act.post("/api/sources/stop", { step });
                        await load();
                      }}
                    >
                      Stop
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p>{s?.fix.how}</p>
                  {s && s.fix.left !== null && s.fix.checks > 0 && (
                    <p className="muted">{checksLine(s.fix)}</p>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={!s?.fix.n}
                    onClick={async () => {
                      await act.post("/api/sources/retry-all", { step, reason, source: src });
                      await load();
                      act.reload();
                    }}
                  >
                    Try again for all {fmt(s?.fix.n ?? 0)} · {s?.fix.cost}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

// Dismissed "Start here", remembered in this browser.
const START_GONE = "jobsignal.start-here.gone";

/**
 * "Start here": what first run left skipped, each opening where it's done: a model, a web search,
 * your own signals (job mail or X bookmarks), your CV, your positioning page. Never a fund, which
 * stays off until you tick one yourself. Gone once nothing is left, or once hidden.
 */
function StartHere({ d, ctx, act }: { d: Data; ctx: Ctx; act: Actions }) {
  const [gone, setGone] = useState(() => localStorage.getItem(START_GONE) === "1");
  const state = (k: string) => d.tiles.find((t) => t.key === k)?.state;
  const search = d.lookups.providers.some((p) => p.connected);
  const mine = ["job-mail", "x-bookmarks", "gmail"].some((k) => state(k) === "on");
  const todo: { text: string; button: string; go: () => void }[] = [];
  if (!d.model.on)
    todo.push({
      text: "Connect a model, so posts are sorted and careers pages are read: sign in to Claude Code, or add an Anthropic API key.",
      button: "Connect a model",
      go: () => ctx.page("settings", { at: "set-model" }),
    });
  if (!search)
    todo.push({
      text: "Pick a search provider, so each company's website and job board can be looked up. Each one has a free allowance.",
      button: "Pick one",
      go: () => act.show("lookup"),
    });
  if (!mine)
    todo.push({
      text: "Bring in your job mail (alerts from LinkedIn and others) or your X bookmarks: the companies in them come to your Inbox.",
      button: "Set up job mail",
      go: () => act.show("job-mail"),
    });
  if (!d.me.cv)
    todo.push({
      text: "Add your CV, for when you apply: the form filler uses it.",
      button: "Add your CV",
      go: () => ctx.page("settings", { at: "set-applying" }),
    });
  if (!d.me.positioning)
    todo.push({
      text: "Write your positioning page: Work reads it when it looks into a company for you.",
      button: "Write it",
      go: () => ctx.page("settings", { at: "set-positioning" }),
    });
  if (gone || !todo.length) return null;
  return (
    <section className="start-here" aria-labelledby="startTitle">
      <div className="sec-h">
        <h2 id="startTitle">Start here</h2>
        <button
          type="button"
          className="link faint"
          onClick={() => {
            localStorage.setItem(START_GONE, "1");
            setGone(true);
          }}
        >
          Hide this
        </button>
      </div>
      <ol>
        {todo.map((t) => (
          <li key={t.button}>
            <span>{t.text}</span>
            <button type="button" className="small" onClick={t.go}>
              {t.button}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Sources({ ctx, tile }: { ctx: Ctx; tile?: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [panel, setPanel] = useState<Step | null>(null);
  const reload = useCallback(async () => {
    const r = await fetch("/api/sources").catch(() => null);
    if (r?.ok) setD((await r.json()) as Data);
  }, []);
  useEffect(() => {
    void reload();
    // A tick or a read changes the numbers: asked again when the board says so.
    const on = () => void reload();
    window.addEventListener("inbox.changed", on);
    return () => window.removeEventListener("inbox.changed", on);
  }, [reload]);
  const act: Actions = {
    post: async (url, body, quiet) => {
      const r = await ctx.post(url, body);
      const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (out.toast && !quiet) ctx.toast(String(out.toast));
      return r.ok ? out : { ...out, error: true };
    },
    reload: () => void reload(),
    show: (k) => {
      setOpen((o) => new Set(o).add(k));
      setTimeout(() => document.getElementById(`tile-${k}`)?.scrollIntoView({ block: "center" }), 50);
    },
  };
  // Opened from the rail on one source: its tile open and in view, once.
  const shown = useRef(false);
  useEffect(() => {
    if (!d || !tile || shown.current) return;
    shown.current = true;
    setOpen((o) => new Set(o).add(tile));
    setTimeout(() => document.getElementById(`tile-${tile}`)?.scrollIntoView({ block: "center" }), 50);
  }, [d, tile]);
  if (!d)
    return (
      <main className="srcs">
        <div className="pagehead">
          <h1>Sources</h1>
          <p className="muted">Loading your sources…</p>
        </div>
      </main>
    );
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <main className="srcs">
      <div className="pagehead">
        <h1>Sources</h1>
        <p>Where your signals come from, and what happens to each one on its way to your Inbox.</p>
        <p className="pointer">
          Spend, who pays and keys are in{" "}
          <button type="button" className="link" onClick={() => ctx.page("settings")}>
            Settings
          </button>
          .
        </p>
      </div>
      <FindBoards d={d} act={act} reload={reload} />
      {d.model.on && (
        <p
          className={`pointer${d.model.limit !== null && d.model.today >= d.model.limit ? " held-text" : ""}`}
        >
          {d.model.limit !== null && d.model.today >= d.model.limit ? (
            <>
              Today's limit of {fmt(d.model.limit)} background checks is used; the rest continue tomorrow.
              Change it in{" "}
              <button
                type="button"
                className="link"
                onClick={() => ctx.page("settings", { at: "set-spend" })}
              >
                Settings
              </button>
              .
            </>
          ) : d.model.limit !== null ? (
            `Background model checks today: ${fmt(d.model.today)} of ${fmt(d.model.limit)} a day on your Claude subscription. Work you start yourself doesn't count.`
          ) : (
            `Background model checks today: ${fmt(d.model.today)}, on your API key, inside your spend limits.`
          )}
        </p>
      )}
      {!d.model.on && (
        <p className="nomodel">
          No model connected: posts aren't sorted, careers pages aren't read by the model, boards found by
          search aren't picked and Work doesn't run. Sign in to Claude Code, or add an Anthropic API key in{" "}
          <button
            type="button"
            className="link"
            onClick={() => ctx.page("settings", { at: "key-anthropic" })}
          >
            Settings &gt; Keys
          </button>
          .
        </p>
      )}
      <StartHere d={d} ctx={ctx} act={act} />
      <section className="src-sec" aria-labelledby="srcTitle">
        <div className="sec-h">
          <div>
            <h2 id="srcTitle">Your sources</h2>
            <p>Things that need you come first. Each source has its own steps to connect it.</p>
          </div>
          <Legend />
        </div>
        <div className="cards">
          {d.tiles.map((t) => (
            <TileCard
              key={t.key}
              t={t}
              open={open.has(t.key)}
              d={d}
              toggle={() => toggle(t.key)}
              ctx={ctx}
              act={act}
            />
          ))}
          <LookupTile
            d={d.lookups}
            ctx={ctx}
            act={act}
            open={open.has("lookup")}
            toggle={() => toggle("lookup")}
          />
        </div>
      </section>
      <section className="map-sec" aria-labelledby="mapTitle">
        <div className="sec-h">
          <h2 id="mapTitle">How a signal becomes roles</h2>
          <p>
            Click a step or a dashed box to see what stopped there. Click a source to follow only that one.
          </p>
        </div>
        <MapView d={d} sel={sel} setSel={setSel} panel={panel} setPanel={setPanel} ctx={ctx} />
        <div className="map-foot">
          <Legend />
          <span className="legend">Dashed box: where things stopped</span>
        </div>
        {panel && (
          <StepSection key={panel} step={panel} d={d} src={sel} close={() => setPanel(null)} act={act} />
        )}
      </section>
    </main>
  );
}

function Legend() {
  return (
    <div className="legend">
      {/* Four states; Needs you is red when the source had worked and stopped. */}
      {(["on", "needs", "paused", "off"] as TileState[]).map((s) => (
        <span key={s}>
          <i className={`mark ${s}`} aria-hidden="true" />
          {s === "needs" && <i className="mark fail" aria-hidden="true" />}
          {s === "needs" ? "Needs you (red: it had worked)" : STATE_WORD[s]}
        </span>
      ))}
    </div>
  );
}

type Summary = {
  on: number;
  total: number;
  needs: { key: string; name: string; status: string; broke: boolean }[];
  today: { signals: number; companies: number };
};

/**
 * The rail's block on Threads: the sources that need you, each straight to its tile, then how
 * many are on and what came in today. Nothing needing you: two quiet lines.
 */
function SourcesRail({ ctx }: { ctx: Ctx }) {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    // A failed answer (in the bug report) leaves the block as it was: it never takes the page down.
    const load = async () => {
      const r = await fetch("/api/sources/summary").catch(() => null);
      if (r?.ok) setS((await r.json()) as Summary);
    };
    void load();
    for (const e of ["inbox.changed", "rail.changed"]) window.addEventListener(e, load);
    return () => {
      for (const e of ["inbox.changed", "rail.changed"]) window.removeEventListener(e, load);
    };
  }, []);
  if (!s) return null;
  const today =
    s.today.signals || s.today.companies
      ? `Today: ${fmt(s.today.signals)} new signal${s.today.signals === 1 ? "" : "s"} · ${fmt(s.today.companies)} new compan${s.today.companies === 1 ? "y" : "ies"}`
      : "Nothing new today yet";
  return (
    <section className="src-rail">
      <div className="label">Sources</div>
      {s.needs.length > 0 && (
        <ul className="needs">
          {s.needs.map((n) => (
            <li key={n.key}>
              <i className={`mark ${n.broke ? "fail" : "needs"}`} aria-hidden="true" />
              <div>
                <button type="button" className="link" onClick={() => ctx.page("sources", { tile: n.key })}>
                  {n.name}
                </button>
                <span className="why">{n.status}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {fmt(s.on)} of {fmt(s.total)} on
        {s.needs.length ? ` · ${s.needs.length} need${s.needs.length === 1 ? "s" : ""} you` : ""}. {today}.
      </p>
      <button type="button" className="link" onClick={() => ctx.page("sources")}>
        Open Sources
      </button>
    </section>
  );
}

const sources: BoardFeature = {
  name: "sources",
  order: 40,
  rail: (ctx) => <SourcesRail ctx={ctx} />,
  pages: { sources: (ctx, p) => <Sources ctx={ctx} tile={p.tile} /> },
};

export default sources;

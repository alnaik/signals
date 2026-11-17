import { useCallback, useEffect, useRef, useState } from "react";
import { startApply } from "../apply/board.tsx";
import { age, ago, roleHref, safeHref, statusWord } from "../board/format.ts";
import { SectionHead } from "../board/Queue.tsx";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy, ModeBadge, RoleText, State } from "../board/ui.tsx";
import type { Summary } from "../core/derive.ts";
import { workCompany } from "../decisions/board.tsx";
import type { RoleView } from "../inbox/query.ts";
import type { BoardState } from "./add.ts";

type Company = {
  id: number;
  domain: string | null;
  thread: string;
  name: string;
  board: BoardState;
  fit: number;
  lastRead: string | null;
  threadState: Pick<Summary, "status" | "statusSince" | "closeReason" | "tonight" | "ran" | "id"> | null;
  adding: string | null;
  fresh: number; // new roles that fit, first seen this week, not chosen yet
  funding: { form: string; date: string; url: string } | null;
};

/** Live Add progress lines, by company id, from the server's stream. */
export function useAdding(): Record<string, string> {
  const [lines, setLines] = useState<Record<string, string>>({});
  useEffect(() => {
    const on = (e: Event) => {
      const p = (e as CustomEvent<{ domain: string; line: string | null }>).detail;
      setLines((l) => {
        const next = { ...l };
        if (p.line === null) delete next[p.domain];
        else next[p.domain] = p.line;
        return next;
      });
    };
    window.addEventListener("add.progress", on);
    return () => window.removeEventListener("add.progress", on);
  }, []);
  return lines;
}

function useJson<T>(url: string): [T | null, () => Promise<void>] {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(url);
    setData(r.ok ? await r.json() : null);
  }, [url]);
  useEffect(() => {
    load();
    window.addEventListener("watchlist.changed", load);
    window.addEventListener("inbox.changed", load);
    return () => {
      window.removeEventListener("watchlist.changed", load);
      window.removeEventListener("inbox.changed", load);
    };
  }, [load]);
  return [data, load];
}

async function send(ctx: Ctx, url: string, body: unknown) {
  const res = await ctx.post(url, body);
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  if (out.toast) ctx.toast(out.toast);
  return { ok: res.ok, out };
}

/** Paste a website, a careers page, a board URL, a posting or a name. */
export function AddBox({ ctx, compact = false }: { ctx: Ctx; compact?: boolean }) {
  const [input, setInput] = useState("");
  const [ask, setAsk] = useState<{ ask: string; input: string } | null>(null);
  const go = async (confirm = false, what = input) => {
    const { ok, out } = await send(ctx, "/api/watchlist/add", { input: what, confirm });
    if (out.ask) return setAsk({ ask: out.ask, input: what });
    setAsk(null);
    if (ok && out.company) {
      setInput("");
      ctx.page("company", { c: String(out.company) });
    }
  };
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <input
        aria-label="Add a company"
        placeholder={compact ? "Add a company" : "Website, careers page, board URL, posting or name"}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && input.trim() && go()}
        style={{ width: compact ? 120 : 380 }}
      />
      {/* In the top bar, Add shows once something is typed (Enter adds too): room for one line. */}
      {(!compact || input.trim()) && (
        <button
          type="button"
          className={compact ? "" : "primary"}
          disabled={!input.trim()}
          onClick={() => go()}
        >
          Add
        </button>
      )}
      {ask && (
        <span className="reason-row">
          <span className="muted">{ask.ask}</span>
          <button type="button" className="small primary" onClick={() => go(true, ask.input)}>
            Yes
          </button>
          <button type="button" className="small link" onClick={() => setAsk(null)}>
            no
          </button>
        </span>
      )}
    </span>
  );
}

function boardLine(b: BoardState): string {
  if (!b.provider && b.email) return `applies by email · ${b.email}`;
  if (!b.provider)
    return b.problem
      ? `No job board yet: ${b.problem}`
      : "No job board yet: paste the page that lists its roles";
  if (b.provider === "careers-page") return `careers page · ${b.url}`;
  return `${b.provider}${b.partial ? " (partial: read through its search)" : ""} · ${b.url}`;
}

function WatchlistPage({ ctx }: { ctx: Ctx }) {
  const [data] = useJson<{ companies: Company[] }>("/api/watchlist");
  const adding = useAdding();
  if (!data) return null;
  return (
    <main className="queue">
      <section>
        <div style={{ padding: "12px 0" }}>
          <AddBox ctx={ctx} />
        </div>
        <SectionHead count={data.companies.length} label="Watchlist" />
        {data.companies.length === 0 && (
          <div className="empty" style={{ paddingLeft: 0 }}>
            Nothing watched yet. Add a company above.
          </div>
        )}
        {data.companies.map((c) => {
          const line = adding[String(c.id)] ?? c.adding;
          return (
            <div
              key={c.id}
              className="row"
              style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}
              onClick={() => ctx.page("company", { c: String(c.id) })}
            >
              <div
                className="l1"
                style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}
              >
                <span style={{ fontWeight: 600, fontSize: 17 }}>{c.name}</span>
                {c.fresh > 0 && <span className="held-text">{c.fresh} new this week</span>}
                <span
                  className={`faint${c.board.provider ? "" : " held-text"}`}
                  style={{ overflowWrap: "anywhere" }}
                >
                  {line ?? boardLine(c.board)}
                </span>
                <span className="muted">
                  {c.fit} role{c.fit === 1 ? "" : "s"} fit
                </span>
                {c.lastRead && <span className="faint">read {age(c.lastRead)}</span>}
              </div>
              <div className="actions">
                {!c.board.provider && !c.board.email && !line && (
                  <button
                    type="button"
                    className="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      send(ctx, `/api/companies/${c.id}/refresh`, {});
                    }}
                  >
                    Try again
                  </button>
                )}
                <button
                  type="button"
                  className="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    send(ctx, `/api/watchlist/${c.id}/remove`, {});
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}

function BoardUrl({ ctx, c }: { ctx: Ctx; c: Company }) {
  const [url, setUrl] = useState("");
  return (
    <div className="reason-row">
      <input
        aria-label="Board URL"
        placeholder="Paste the page that lists their roles"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{ flex: "1 1 280px" }}
      />
      <button
        type="button"
        className="small primary"
        disabled={!url.trim()}
        onClick={async () => {
          // A pasted board for this company: Add again, starting from that URL.
          await send(ctx, "/api/watchlist/add", {
            input: c.domain ?? c.name,
            name: c.name,
            board: url,
            confirm: true,
          });
          setUrl("");
        }}
      >
        Read it
      </button>
    </div>
  );
}

/** A role that fits on the company's board, with what you did with it; its text loads on click. */
function RoleRow({ r, act }: { r: RoleView; act: (action: "apply" | "dismiss") => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null | undefined>(undefined);
  const toggle = async () => {
    setOpen(!open);
    if (text === undefined) {
      setText(null);
      const res = await fetch(`/api/roles/${r.id}/text`);
      setText(res.ok ? ((await res.json()).text ?? "") : "");
    }
  };
  const choosable = r.state === "new" || r.state === "archived";
  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <div
        className="row quiet"
        style={{ gridTemplateColumns: "minmax(0,1fr) auto", borderBottom: 0, cursor: "pointer" }}
        onClick={toggle}
      >
        <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
          <a
            href={roleHref(r.url)}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 15, fontWeight: 500 }}
            onClick={(e) => e.stopPropagation()}
          >
            {r.title}
          </a>
          <span className="muted">{r.location || "location unknown"}</span>
          <ModeBadge mode={r.mode} />
          <span className="faint">{r.posted_at ? `posted ${ago(r.at)}` : `seen ${ago(r.at)}`}</span>
          {!choosable && <State state={r.state} />}
          <span className="faint">{open ? "▾" : "▸"}</span>
        </div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {choosable && (
            <>
              <button type="button" className="small primary" onClick={() => act("apply")}>
                Apply
              </button>
              <button type="button" className="small" onClick={() => act("dismiss")}>
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>
      {open &&
        (text ? (
          <RoleText text={text} />
        ) : (
          <div className="faint" style={{ padding: "6px 0" }}>
            {text === null ? "reading…" : "No text on the board for this role: open the posting."}
          </div>
        ))}
    </div>
  );
}

function CompanyPage({ ctx, id }: { ctx: Ctx; id: string }) {
  const [c, load] = useJson<Company & { roles: RoleView[]; next: string | null; held: number }>(
    `/api/watchlist/${encodeURIComponent(id)}`,
  );
  const [more, setMore] = useState<RoleView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  // A reload of the company (a role chosen, a change elsewhere) keeps the pages "more roles"
  // opened: they are fetched again, as many roles as were shown; another company starts over.
  const shown = useRef({ id: c?.id, n: 0 });
  shown.current.n = more.length;
  useEffect(() => {
    const upto = shown.current.id === c?.id ? shown.current.n : 0;
    shown.current.id = c?.id;
    let stale = false;
    (async () => {
      const got: RoleView[] = [];
      let at = c?.next ?? null;
      while (c && at && got.length < upto) {
        const r = await fetch(`/api/watchlist/${c.id}?cursor=${encodeURIComponent(at)}`);
        if (!r.ok) break;
        const body = await r.json();
        got.push(...body.roles);
        at = body.next;
      }
      if (stale) return;
      setMore(got);
      setNext(at);
    })();
    return () => {
      stale = true;
    };
  }, [c]);
  const adding = useAdding();
  if (!c) return <main className="queue" />;
  const line = adding[String(c.id)] ?? c.adding;
  const roles = [...c.roles, ...more];
  const role = async (r: RoleView, action: "apply" | "dismiss") => {
    const { ok, out } = await send(ctx, `/api/roles/${r.id}`, { action });
    await load();
    await ctx.refetch();
    if (ok && action === "apply" && out.thread) {
      ctx.open(out.thread);
      if (out.url) await startApply(ctx, out.thread, out.url);
    }
  };
  const loadMore = async () => {
    const r = await fetch(`/api/watchlist/${c.id}?cursor=${encodeURIComponent(next ?? "")}`);
    if (!r.ok) return;
    const body = await r.json();
    setMore((m) => [...m, ...body.roles]);
    setNext(body.next);
  };
  return (
    <main className="queue">
      <section>
        <div
          style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", padding: "12px 0" }}
        >
          <span style={{ fontWeight: 600, fontSize: 18 }}>{c.name}</span>
          {c.domain && <span className="faint">{c.domain}</span>}
          {c.threadState && (
            <button type="button" className="small" onClick={() => ctx.open(c.thread)}>
              Thread{statusWord(c.threadState) ? ` · ${statusWord(c.threadState)}` : ""}
            </button>
          )}
          {/* No open role and no thread yet: Work opens one for a cold message. */}
          {!c.threadState && roles.length === 0 && !line && (
            <button type="button" className="small primary" onClick={() => workCompany(ctx, c.id)}>
              Work
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="small"
            onClick={() => send(ctx, `/api/companies/${c.id}/refresh`, {})}
          >
            {c.board.provider ? "Refresh" : "Try again"}
          </button>
          <button type="button" className="small link" onClick={() => ctx.page("watchlist")}>
            Watchlist
          </button>
        </div>
        <div className="muted" style={{ overflowWrap: "anywhere" }}>
          {line ?? boardLine(c.board)}
          {!line && c.board.email && (
            <>
              {" "}
              <Copy text={c.board.email} onCopied={() => ctx.toast("Copied")} />
            </>
          )}
          {!line && !c.board.provider && c.board.careers && (
            <>
              {" · "}
              <a href={safeHref(c.board.careers)} target="_blank" rel="noreferrer">
                careers page
              </a>
            </>
          )}
          {c.lastRead && !line && <span className="faint"> · read {age(c.lastRead)}</span>}
        </div>
        {c.funding && (
          <div className="muted">
            <a href={safeHref(c.funding.url)} target="_blank" rel="noreferrer">
              Form {c.funding.form} filed {c.funding.date}
            </a>
          </div>
        )}
        {!line && !c.board.provider && <BoardUrl ctx={ctx} c={c} />}
      </section>
      <section>
        <SectionHead count={c.fit} label="Roles that fit" />
        {roles.length === 0 && !line && (
          <div className="empty" style={{ paddingLeft: 0 }}>
            {!c.board.provider
              ? "No board read yet."
              : c.held
                ? `0 of ${c.held} pass your filters.`
                : "The last read found no open roles."}
          </div>
        )}
        {roles.map((r) => (
          <RoleRow key={r.id} r={r} act={(action) => role(r, action)} />
        ))}
        {next && (
          <button type="button" className="small link" onClick={loadMore}>
            more roles
          </button>
        )}
      </section>
    </main>
  );
}

/** Watch on a company's page: also after applying, and for a company with no website yet. */
function WatchButton({ id, ctx }: { id: string; ctx: Ctx }) {
  // Read again whenever the watchlist changes (watched or dropped on another page), never stale.
  const [state, load] = useJson<{ known: boolean; watched: boolean }>(
    `/api/threads/${encodeURIComponent(id)}/watch`,
  );
  if (!state?.known) return null;
  if (state.watched)
    return (
      <button type="button" className="quiet">
        Watching
      </button>
    );
  return (
    <button
      type="button"
      onClick={async () => {
        const res = await ctx.post(`/api/threads/${encodeURIComponent(id)}/watch`, {});
        const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
        ctx.toast(out.toast);
        if (res.ok) await load();
      }}
    >
      Watch
    </button>
  );
}

const watchlist: BoardFeature = {
  name: "watchlist",
  order: 6,
  footer: (d, ctx) => <WatchButton key={d.id} id={d.id} ctx={ctx} />,
  topBar: (ctx) => <AddBox ctx={ctx} compact />,
  pages: {
    watchlist: (ctx) => <WatchlistPage ctx={ctx} />,
    company: (ctx, p) => <CompanyPage key={p.c} ctx={ctx} id={p.c ?? ""} />,
  },
};

export default watchlist;

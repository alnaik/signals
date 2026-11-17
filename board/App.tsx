import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer } from "./Drawer.tsx";
import { boardDate } from "./format.ts";
import { Queue } from "./Queue.tsx";
import { hasRail, Rail } from "./Rail.tsx";
import { type Ctx, registry } from "./slots.ts";
import { useBoard } from "./store.ts";

type Page = { key: string; params: Record<string, string> };

/**
 * The open page and thread live in the address, so a refresh comes back to them: a thread opened
 * over a page rides along as its `thread` parameter (#/inbox?city=…&thread=…).
 */
function fromHash(): { page: Page | null; thread: string | null } {
  const [p = "", q = ""] = location.hash.slice(1).split("?");
  const [key, id] = p.split("/").filter(Boolean);
  if (key === "thread" && id) return { page: null, thread: decodeURIComponent(id) };
  const { thread = null, ...params } = Object.fromEntries(new URLSearchParams(q));
  return { page: key ? { key, params } : null, thread: key ? thread : null };
}

function toHash(page: Page | null, thread: string | null): string {
  if (page) {
    const q = new URLSearchParams({ ...page.params, ...(thread ? { thread } : {}) }).toString();
    return `#/${page.key}${q ? `?${q}` : ""}`;
  }
  return thread ? `#/thread/${encodeURIComponent(thread)}` : "";
}

export function App() {
  const board = useBoard();
  const { data, rows, layout, openId, detail, updated, open, store } = board;
  const [toast, setToast] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    // Long enough to read: a short "Saved" goes quickly, a reason with a next step stays (60 ms a
    // character, 10 seconds at most).
    const ms = Math.min(10_000, Math.max(1400, String(msg ?? "").length * 60));
    setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  }, []);

  // The list the open thread sat in when the drawer opened, frozen by the layout.
  const section = useMemo(() => {
    if (!openId) return null;
    for (const ids of [layout.open, layout.closed, layout.applied]) if (ids.includes(openId)) return ids;
    return null;
  }, [layout, openId]);

  const next = useCallback(() => {
    open(null).then(() => store.refetchAll(true));
  }, [open, store]);

  const ctx: Ctx = useMemo(
    () => ({
      toast: showToast,
      // A thread opens over the page you're on (Apply in the Inbox, on the Watchlist), which stays
      // as it was underneath: closing it puts you back where you were.
      open: (id) => {
        open(id);
      },
      next,
      page: (key, params = {}) => {
        open(null);
        setPage(key ? { key, params } : null);
      },
      refetch: async (id) => (id ? store.refetchThread(id) : store.refetchAll(true)),
      post: (url, body) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    }),
    [showToast, open, next, store],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: read the address once, on load
  useEffect(() => {
    const h = fromHash();
    if (h.page) setPage(h.page);
    if (h.thread) open(h.thread);
  }, []);
  useEffect(() => {
    history.replaceState(null, "", toHash(page, openId) || location.pathname + location.search);
  }, [page, openId]);
  // An address typed or a link followed (#/sources), and Back: the screen follows it.
  useEffect(() => {
    const onHash = () => {
      const h = fromHash();
      setPage(h.page);
      open(h.thread);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [open]);

  useEffect(() => {
    const stops = registry.map((f) => f.connect?.(store)).filter((s): s is () => void => !!s);
    return () => {
      for (const s of stops) s();
    };
  }, [store]);

  useEffect(() => {
    const onToast = (e: Event) => showToast(String((e as CustomEvent).detail));
    window.addEventListener("toast", onToast);
    return () => window.removeEventListener("toast", onToast);
  }, [showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openId && ctx.open(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, ctx]);

  if (!data) return null;

  const toastEl = toast && (
    <div className="toast" role="status">
      {toast}
    </div>
  );
  for (const f of registry) {
    const gate = f.gate?.(ctx);
    if (gate)
      return (
        <div className="page">
          {gate}
          {toastEl}
        </div>
      );
  }

  const working = data.agents.filter((a) => a.status === "working").length;
  const pageRender = page && registry.map((f) => f.pages?.[page.key]).find(Boolean);

  return (
    <div className="page">
      <div className="frame">
        <div className="topbar-rule" />
        <header className="topbar">
          <button type="button" className="title" onClick={() => ctx.page(null)}>
            Signal Board
          </button>
          <span className="date">{boardDate()}</span>
          <span className={`live${working ? "" : " idle"}`} title={board.live ? "live" : "offline"}>
            <span className="sq" />
            {working ? `${working} agent${working > 1 ? "s" : ""} working` : "idle"}
          </span>
          <span className="spacer" />
          <div className="segmented" role="group" aria-label="Screen">
            <button type="button" aria-pressed={!page} onClick={() => ctx.page(null)}>
              Threads
            </button>
            <button type="button" aria-pressed={page?.key === "inbox"} onClick={() => ctx.page("inbox")}>
              Inbox {data.inbox}
            </button>
            {/* Companies a signal named with nothing that fits: no count, it isn't a to-do list. */}
            {registry.some((f) => f.pages?.signals) && (
              <button
                type="button"
                aria-pressed={page?.key === "signals"}
                onClick={() => ctx.page("signals")}
              >
                Signals
              </button>
            )}
            <button
              type="button"
              aria-pressed={page?.key === "watchlist" || page?.key === "company"}
              onClick={() => ctx.page("watchlist")}
            >
              Watchlist
            </button>
            {/* A screen like the three before it, so it sits with them. */}
            {registry.some((f) => f.pages?.sources) && (
              <button
                type="button"
                aria-pressed={page?.key === "sources"}
                onClick={() => ctx.page("sources")}
              >
                Sources
              </button>
            )}
          </div>
          {/* Actions first (Add, Look up), then the page links, close together: one line at 1,180 px. */}
          <div className="topbar-tools">
            {registry.map((f) => (
              <span key={f.name} style={{ display: "contents" }}>
                {f.topBar?.(ctx)}
              </span>
            ))}
          </div>
        </header>
        {registry.map((f) => (
          <span key={f.name} style={{ display: "contents" }}>
            {f.margin?.(ctx)}
          </span>
        ))}
        {pageRender ? (
          <div className="subpage">{pageRender(ctx, page!.params)}</div>
        ) : (
          <div className={`layout${hasRail() ? "" : " wide"}`}>
            <Queue layout={layout} rows={rows} openId={openId} ctx={ctx} />
            {hasRail() && <Rail ctx={ctx} />}
          </div>
        )}
      </div>
      {detail && openId && (
        <Drawer
          d={detail}
          updated={updated}
          // "n of N" counts the Threads list, so only on Threads.
          position={section && !page ? { n: section.indexOf(openId) + 1, of: section.length } : null}
          ctx={ctx}
        />
      )}
      {toastEl}
    </div>
  );
}

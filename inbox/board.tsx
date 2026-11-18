import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startApply } from "../apply/board.tsx";
import { age, ago, roleHref, safeHref, shortDate } from "../board/format.ts";
import { SectionHead } from "../board/Queue.tsx";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy, EmptyHint, ModeBadge, RoleText, Tag } from "../board/ui.tsx";
import { work, workCompany } from "../decisions/board.tsx";
import { useAdding } from "../watchlist/board.tsx";
import { FoundLines } from "./found.tsx";
import type { InboxCompany, RoleView } from "./query.ts";
import { ReviewLine, ReviewTitles } from "./titles.tsx";

export type Filters = { source: string | null; remote: boolean; metro: string | null; q?: string };
const qs = (f: Filters, cursor?: string | null) => {
  const p = new URLSearchParams();
  if (f.source) p.set("source", f.source);
  if (f.remote) p.set("remote", "1");
  if (f.metro) p.set("metro", f.metro);
  if (f.q) p.set("q", f.q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
};

function Btn({ label, onClick, primary }: { label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      className={primary ? "small primary" : "small"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

/** Live progress of Refresh all, from the server's stream. */
function useRefreshing(): { line: string | null; said: string | null } {
  const [s, set] = useState<{ line: string | null; said: string | null }>({ line: null, said: null });
  useEffect(() => {
    const on = (e: Event) => {
      const p = (
        e as CustomEvent<{ done?: number; total?: number | null; line: string | null; said?: string }>
      ).detail;
      set({
        line: p.line === null ? null : `${p.done ?? 0}${p.total ? ` of ${p.total}` : ""} · ${p.line}`,
        said: p.said ?? null,
      });
    };
    window.addEventListener("refresh.progress", on);
    return () => window.removeEventListener("refresh.progress", on);
  }, []);
  return s;
}

/** One role inside an open company; its text loads the first time it's opened. */
export function RoleRow({
  r,
  watched,
  act,
}: {
  r: RoleView;
  watched: boolean;
  act: (id: number, action: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null | undefined>(undefined);
  const toggle = async () => {
    setOpen(!open);
    if (text === undefined) {
      setText(null);
      const res = await fetch(`/api/roles/${r.id}/text`);
      const body = res.ok ? await res.json() : { text: null };
      setText(body.text ?? "");
    }
  };
  return (
    <div style={{ borderTop: "1px solid var(--line)" }}>
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
          <span className="muted" title={r.location || undefined}>
            {r.place || (r.mode && r.mode !== "unknown" ? "" : r.location || "location unknown")}
          </span>
          <ModeBadge mode={r.mode} />
          {/* A search finds roles in any state: one you decided on says so. */}
          {(r.state === "applied" || r.state === "dismissed") && <Tag>{r.state}</Tag>}
          {!r.fits && (
            <span className={r.near ? "held-text" : "faint"}>{r.why ?? "doesn't pass your filters"}</span>
          )}
          <span className="faint">{r.posted_at ? `posted ${ago(r.at)}` : `seen ${ago(r.at)}`}</span>
          {r.reposted && <span className="faint">reposted · first seen {shortDate(r.reposted)}</span>}
          <span className="faint">{open ? "▾" : "▸"}</span>
        </div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <Btn label="Apply" primary onClick={() => act(r.id, "apply")} />
          {!watched && <Btn label="Apply + Watch" onClick={() => act(r.id, "apply_watch")} />}
          <Btn label="Dismiss" onClick={() => act(r.id, "dismiss")} />
          <Btn label="Work on it" onClick={() => act(r.id, "work")} />
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

/** A company's new roles, a page at a time; in "Everything else", all its open roles. */
function Roles({
  c,
  filters,
  act,
}: {
  c: InboxCompany;
  filters: Filters;
  act: (id: number, action: string) => void;
}) {
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  // "Everything else": all its open roles; a signal's company with none new: those that fit.
  const view = c.held !== undefined ? "&view=all" : c.roles === 0 && c.fit > 0 ? "&view=fit" : "";
  // From `cursor`, one page; from the top, pages until `upto` roles (as many as were shown).
  const load = useCallback(
    async (cursor: string | null, upto = 0) => {
      const got: RoleView[] = [];
      let at = cursor;
      do {
        const res = await fetch(
          `/api/companies/${c.id}/roles?${qs({ ...filters, source: null }, at)}${view}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { roles: RoleView[]; next: string | null };
        got.push(...body.roles);
        at = body.next;
      } while (!cursor && at && got.length < upto);
      setRoles((prev) => (cursor ? [...prev, ...got] : got));
      setNext(at);
    },
    [c.id, filters, view],
  );
  // Reload when the company's count changes (a role chosen, a read added some), keeping the
  // pages "more roles" opened; new filters start from the top.
  const shown = useRef({ load, n: 0 });
  shown.current.n = roles.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: c.roles and c.hitRoles are the trigger
  useEffect(() => {
    const same = shown.current.load === load;
    shown.current.load = load;
    load(null, same ? shown.current.n : 0);
  }, [load, c.roles, c.hitRoles]);
  return (
    <div style={{ paddingLeft: 16, paddingBottom: 8 }}>
      {roles.map((r) => (
        <RoleRow key={r.id} r={r} watched={c.watched} act={act} />
      ))}
      {next && (
        <button type="button" className="small link" onClick={() => load(next)}>
          more roles
        </button>
      )}
    </div>
  );
}

/** What named the company: the newest signal from each source ("LinkedIn alert: Senior Engineer"). */
function Signals({ c, showTag }: { c: InboxCompany; showTag: boolean }) {
  return (
    <>
      {c.signals.slice(0, 3).map((s) => (
        <a
          key={s.source}
          href={safeHref(s.url)}
          target="_blank"
          rel="noreferrer"
          className="muted"
          onClick={(e) => e.stopPropagation()}
          title={`${s.tag} · ${shortDate(s.at)}`}
        >
          {showTag ? `${s.tag}${s.title ? `: ${s.title.slice(0, 90)}` : ""}` : (s.title ?? s.tag)}
        </a>
      ))}
    </>
  );
}

function boardWord(c: InboxCompany): string | null {
  if (c.board?.status === "broken") return "board failed: looking again";
  if (c.board) return null;
  if (c.discovery === "none") return "no board found";
  // Its careers site was found, on a platform no reader here reads: open it there.
  if (c.discovery === "unreadable")
    return c.careers_url ? "board can't be read here ·" : "board can't be read here";
  // robots.txt refuses readers on its careers page or the board it names.
  if (c.discovery === "blocked")
    return c.careers_url ? "its site refuses readers ·" : "its site refuses readers";
  return "looking for its board";
}

/** A company is the row; its roles open behind a click. */
function CompanyRow({
  c,
  last,
  filters,
  line,
  act,
  actCompany,
  copied,
}: {
  c: InboxCompany;
  last?: boolean; // the company you last acted on: an arrow in the margin, so you find your place
  filters: Filters;
  line?: string;
  act: (id: number, action: string) => void;
  actCompany: (action: string) => void;
  copied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const word = boardWord(c);
  // In "Everything else", any open role opens it; with a search, the roles that matched; a signal's
  // company with nothing new, the roles that fit it.
  const opens = (c.held ?? (c.roles || c.fit)) > 0 || (c.hitRoles ?? 0) > 0;
  return (
    <div style={{ borderBottom: "1px solid var(--line)", position: "relative" }}>
      {last && (
        <span className="last-here" title="You were last here" aria-hidden="true">
          →
        </span>
      )}
      <div
        className="row"
        style={{ gridTemplateColumns: "minmax(0,1fr) auto", borderBottom: 0 }}
        onClick={() => opens && setOpen(!open)}
      >
        <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
          {c.link ? (
            <a
              href={safeHref(c.link)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 17, fontWeight: 600 }}
              onClick={(e) => e.stopPropagation()}
              title={c.link === c.board?.url ? `${c.name}'s board` : `${c.name}'s careers page`}
            >
              {c.name}
            </a>
          ) : (
            <span style={{ fontSize: 17, fontWeight: 600 }}>{c.name}</span>
          )}
          {c.domain && <span className="faint">{c.domain}</span>}
          {c.watched && (
            <span className="held-text">{c.week > 0 ? `Watched · ${c.week} new this week` : "Watched"}</span>
          )}
          {c.dismissed && <span className="faint">Dismissed</span>}
          {c.hitRoles !== undefined ? (
            c.hitRoles > 0 && (
              <span className="muted">
                {c.hitRoles} role{c.hitRoles === 1 ? "" : "s"} found · {c.hitFits ?? 0} fit
              </span>
            )
          ) : c.held !== undefined ? (
            <span className="muted">
              {c.held
                ? `${c.roles} of ${c.held} open role${c.held === 1 ? "" : "s"} fit${c.roles === 1 ? "s" : ""}`
                : "no open roles"}
            </span>
          ) : c.roles > 0 ? (
            <span className="muted">
              {c.roles} role{c.roles === 1 ? "" : "s"}
            </span>
          ) : (
            c.fit > 0 && (
              <span className="muted">
                {c.fit} role{c.fit === 1 ? "" : "s"} that fit, seen before
              </span>
            )
          )}
          {c.partial && (
            <span className="held-text" title="A big board: read through its own search for your titles">
              partial
            </span>
          )}
          <span className="faint">{age(c.at)}</span>
          {c.hits && c.hits.length > 0 && (
            <span className="muted">
              matches: {c.hits.slice(0, 2).join(", ")}
              {c.hits.length > 2 ? `, +${c.hits.length - 2}` : ""}
            </span>
          )}
          {word && <span className="faint">{word}</span>}
          {word && c.careers_url && (
            <a
              href={safeHref(c.careers_url)}
              target="_blank"
              rel="noreferrer"
              className="faint"
              onClick={(e) => e.stopPropagation()}
            >
              {c.discovery === "unreadable" || c.discovery === "blocked"
                ? "open careers page"
                : "careers page"}
            </a>
          )}
          {c.funding && (
            <a
              href={safeHref(c.funding.url)}
              target="_blank"
              rel="noreferrer"
              className="faint"
              onClick={(e) => e.stopPropagation()}
            >
              Form D filed {c.funding.date}
            </a>
          )}
          <Signals c={c} showTag={!filters.source} />
          {line && <span className="held-text">{line}</span>}
          {opens && <span className="faint">{open ? "▾" : "▸"}</span>}
        </div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {c.email && !c.roles && (
            <>
              {/* Applies by email: Apply opens the thread (Work, then Mark sent); nothing is sent for you. */}
              <span className="faint">applies by email · {c.email}</span>
              <Copy text={c.email} onCopied={copied} />
              <Btn label="Apply" primary onClick={() => actCompany("apply_email")} />
            </>
          )}
          {/* No role: Work opens the thread for a cold message and starts the research. */}
          {!c.roles && <Btn label="Work" primary={!c.email} onClick={() => actCompany("work")} />}
          <Btn label="Refresh" onClick={() => actCompany("refresh")} />
          {c.watched ? (
            // Watched: Clear takes its new roles out of the Inbox; it stays watched.
            <Btn label="Clear" onClick={() => actCompany("dismiss")} />
          ) : (
            <>
              <Btn label="Watch" onClick={() => actCompany("watch")} />
              <Btn label="Dismiss" onClick={() => actCompany("dismiss")} />
            </>
          )}
        </div>
      </div>
      {open && opens && <Roles c={c} filters={filters} act={act} />}
    </div>
  );
}

/** Companies 50 at a time from `path`: the Inbox, or "Everything else". */
export function useCompanies<T extends { id: number } = InboxCompany>(path: string, filters: Filters) {
  const [companies, setCompanies] = useState<T[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [sources, setSources] = useState<{ source: string; tag: string }[]>([]);
  const [metros, setMetros] = useState<string[]>([]);
  // Companies a change brought in above where you are: shown only when asked.
  const [arrived, setArrived] = useState(0);
  const shown = useRef<T[] | null>(null);
  shown.current = companies;
  // Only the latest request's answer is shown: one that comes back after a newer one was asked is
  // for filters no longer chosen.
  const latest = useRef(0);
  const load = useCallback(
    async (cursor: string | null = null) => {
      const n = ++latest.current;
      const r = await fetch(`${path}?${qs(filters, cursor)}`);
      if (!r.ok || n !== latest.current) return;
      const body = await r.json();
      if (n !== latest.current) return;
      setCompanies((prev) => {
        if (!cursor) return body.companies;
        const have = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...(body.companies as T[]).filter((c) => !have.has(c.id))];
      });
      setNext(body.next);
      if (!cursor) setArrived(0);
      took(body, setCount, setSources, setMetros);
    },
    [path, filters],
  );
  // A tick, a read or a Work run changed the lists: what's shown is updated where it stands, in
  // the order you have it, with the pages you opened and the rows you opened; a company that left
  // goes. One that came in above where you are isn't put in: the list says how many came.
  const refresh = useCallback(async () => {
    const have = shown.current;
    if (!have) return load();
    const n = ++latest.current;
    const fresh: T[] = [];
    let first: Page<T> | null = null;
    let cursor: string | null = null;
    // A page past what's shown, so a company new ones pushed down isn't taken for gone.
    do {
      const r: Response = await fetch(`${path}?${qs(filters, cursor)}`);
      if (!r.ok || n !== latest.current) return;
      const body: Page<T> = await r.json();
      first ??= body;
      fresh.push(...body.companies);
      cursor = body.next;
    } while (cursor && fresh.length < have.length + 50);
    if (n !== latest.current || !first) return;
    const byId = new Map(fresh.map((c) => [c.id, c]));
    const known = new Set(have.map((c) => c.id));
    const lastShown = fresh.reduce((at, c, i) => (known.has(c.id) ? i : at), -1);
    setCompanies(have.flatMap((c) => (byId.has(c.id) ? [byId.get(c.id)!] : [])));
    setArrived(fresh.slice(0, lastShown + 1).filter((c) => !known.has(c.id)).length);
    took(first, setCount, setSources, setMetros);
  }, [path, filters, load]);
  useEffect(() => {
    load();
    const changed = () => refresh();
    window.addEventListener("inbox.changed", changed);
    return () => window.removeEventListener("inbox.changed", changed);
  }, [load, refresh]);
  // After a choice only that company is fetched again: it changes in place, or leaves.
  const [last, setLast] = useState<number | null>(null);
  const reloadCompany = async (id: number) => {
    setLast(id);
    const r = await fetch(`${path}/companies/${id}?${qs(filters)}`);
    const c = r.ok ? ((await r.json()).company as T | null) : null;
    setCompanies((prev) => (prev ?? []).flatMap((x) => (x.id !== id ? [x] : c ? [c] : [])));
    if (!c && companies?.some((x) => x.id === id)) setCount((n) => n - 1);
  };
  return { companies, next, count, sources, metros, load, reloadCompany, arrived, last };
}

type Page<T = InboxCompany> = {
  companies: T[];
  next: string | null;
  count?: number;
  sources?: { source: string; tag: string }[];
  metros?: string[];
};
/** What a list's first page says of the whole list. */
function took(
  body: Omit<Page, "companies" | "next">,
  setCount: (n: number) => void,
  setSources: (s: { source: string; tag: string }[]) => void,
  setMetros: (m: string[]) => void,
) {
  if (body.count !== undefined) setCount(body.count); // the first page's only
  setSources(body.sources ?? []);
  setMetros(body.metros ?? []);
}
type List = ReturnType<typeof useCompanies<InboxCompany>>;

// The city chosen stays chosen across visits and reloads, in this browser.
const CITY_KEY = "jobsignal.inbox.metro";
const savedCity = (): string | null => {
  try {
    return localStorage.getItem(CITY_KEY);
  } catch {
    return null;
  }
};

const thousands = (x: number) => x.toLocaleString("en-US");

/**
 * Under the Inbox's switches too: the companies you dismissed, and the roles that fit you that were
 * open there when you did (their boards aren't read after). Cleared, as much as what you applied to.
 */
function DismissedLine() {
  const [c, setC] = useState<{ companies: number; roles: number } | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/inbox/dismissed")
        .then((r) => (r.ok ? r.json() : null))
        .then(setC)
        .catch(() => {});
    load();
    window.addEventListener("inbox.changed", load);
    window.addEventListener("watchlist.changed", load);
    return () => {
      window.removeEventListener("inbox.changed", load);
      window.removeEventListener("watchlist.changed", load);
    };
  }, []);
  if (!c?.companies) return null;
  const one = c.companies === 1;
  return (
    <div className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
      {thousands(c.companies)} {one ? "company" : "companies"} dismissed: {thousands(c.roles)}{" "}
      {c.roles === 1 ? "role that fits you was" : "roles that fit you were"} open there when you did
    </div>
  );
}

function InboxPage({ ctx, params }: { ctx: Ctx; params: Record<string, string> }) {
  const [filters, setFilters] = useState<Filters>(() => ({
    source: null,
    remote: false,
    metro: savedCity(),
    q: params.q ?? "", // the address's words; then as the search box's pauses set them
  }));
  useEffect(() => {
    try {
      if (filters.metro) localStorage.setItem(CITY_KEY, filters.metro);
      else localStorage.removeItem(CITY_KEY);
    } catch {}
  }, [filters.metro]);
  // The search box: what's typed now, and the words searched once typing pauses. They live in
  // the address (#/inbox?q=…), so coming back, or a link, searches them again.
  const [typed, setTyped] = useState(params.q ?? "");
  useEffect(() => {
    const t = setTimeout(
      () => setFilters((f) => (f.q === typed.trim() ? f : { ...f, q: typed.trim() })),
      250,
    );
    return () => clearTimeout(t);
  }, [typed]);
  const wrote = useRef(params.q ?? "");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the words searched are the trigger
  useEffect(() => {
    if ((filters.q ?? "") === wrote.current) return;
    wrote.current = filters.q ?? "";
    ctx.params(filters.q ? { q: filters.q } : {});
  }, [filters.q]);
  // An address typed or followed (Back): its words.
  useEffect(() => {
    if ((params.q ?? "") !== wrote.current) {
      wrote.current = params.q ?? "";
      setTyped(params.q ?? "");
    }
  }, [params.q]);
  const listFilters = useMemo(
    () => ({ source: filters.source, remote: filters.remote, metro: filters.metro }),
    [filters.source, filters.remote, filters.metro],
  );
  const inboxList = useCompanies("/api/inbox", listFilters);
  // The city and Remote only narrow "Everything else" too; the source switch is the Inbox's own.
  const otherFilters = useMemo(
    () => ({ source: null, remote: filters.remote, metro: filters.metro }),
    [filters.remote, filters.metro],
  );
  const others = useCompanies("/api/others", otherFilters);
  // The search: every open role, any company, none of the switches.
  const searchFilters = useMemo(
    () => ({ source: null, remote: false, metro: null, q: filters.q }),
    [filters.q],
  );
  const found = useCompanies("/api/inbox/search", searchFilters);
  const { companies, count, sources, metros } = inboxList;
  // A saved city the profile no longer has, or no cities at all (the switch hidden): back to every
  // city, once the list has come back with the cities there are.
  useEffect(() => {
    if (companies && filters.metro && !metros.includes(filters.metro))
      setFilters((f) => ({ ...f, metro: null }));
  }, [companies, metros, filters.metro]);
  const adding = useAdding();
  const refreshing = useRefreshing();
  useEffect(() => {
    if (refreshing.said) ctx.toast(`Refresh all: ${refreshing.said}`);
  }, [refreshing.said, ctx]);

  const act = async (list: List, company: number, roleId: number, action: string) => {
    const res = await ctx.post(`/api/roles/${roleId}`, { action });
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    ctx.toast(out.toast);
    await list.reloadCompany(company);
    await ctx.refetch();
    // Apply goes straight on: the thread opens and the form with it, or, when the board asks which
    // CV, the thread's Apply panel with the picker for this role.
    if (res.ok && out.thread) {
      ctx.open(out.thread);
      if (out.url) await startApply(ctx, out.thread, out.url);
      if (out.work) await work(ctx, out.thread);
    }
  };
  const actCompany = async (list: List, company: number, action: string) => {
    if (action === "work") {
      await workCompany(ctx, company);
      await list.reloadCompany(company);
      return ctx.refetch();
    }
    const res = await ctx.post(
      action === "refresh" ? `/api/companies/${company}/refresh` : `/api/companies/${company}`,
      action === "refresh" ? {} : { action },
    );
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    if (out.toast) ctx.toast(out.toast); // a Refresh answers with none: its result comes later
    await list.reloadCompany(out.company ?? company);
    await ctx.refetch();
    if (res.ok && out.thread) ctx.open(out.thread);
  };
  const rows = (list: List, f: Filters) => (
    <>
      {list.arrived > 0 && (
        <button type="button" className="small link" onClick={() => list.load()}>
          {list.arrived} new {list.arrived > 1 ? "companies" : "company"} since you opened this · show from
          the top
        </button>
      )}
      {list.companies?.map((c) => (
        <CompanyRow
          key={c.id}
          c={c}
          last={c.id === list.last}
          filters={f}
          line={adding[String(c.id)]}
          act={(roleId, action) => act(list, c.id, roleId, action)}
          actCompany={(action) => actCompany(list, c.id, action)}
          copied={() => ctx.toast("Copied")}
        />
      ))}
      {list.next && (
        <button type="button" className="small link" onClick={() => list.load(list.next)}>
          more companies
        </button>
      )}
    </>
  );

  if (!companies) return null;
  const tags = new Map(sources.map((s) => [s.source, s.tag]));
  const searching = !!filters.q;
  // While searching, every open role is looked at: the switches wait.
  const idle = searching
    ? "Search looks at every open role: the switches wait until you clear it"
    : undefined;
  return (
    <main className="queue">
      <section>
        <SectionHead
          count={searching ? found.count : count}
          label={
            searching ? "Search" : filters.source ? (tags.get(filters.source) ?? filters.source) : "Inbox"
          }
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", margin: "10px 0" }}>
          <input
            type="search"
            aria-label="Search companies and roles"
            placeholder="Search companies and roles"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setTyped("")}
            style={{ width: 240 }}
          />
          {sources.length > 1 && (
            <div
              className="segmented"
              role="group"
              aria-label="Source"
              title={idle}
              style={searching ? DIM : undefined}
            >
              <button
                type="button"
                disabled={searching}
                aria-pressed={!filters.source}
                onClick={() => setFilters({ ...filters, source: null })}
              >
                All
              </button>
              {sources.map((s) => (
                <button
                  key={s.source}
                  type="button"
                  disabled={searching}
                  aria-pressed={filters.source === s.source}
                  onClick={() => setFilters({ ...filters, source: s.source })}
                >
                  {s.tag}
                </button>
              ))}
            </div>
          )}
          {metros.length > 0 && (
            <select
              aria-label="City"
              disabled={searching}
              title={idle}
              style={searching ? DIM : undefined}
              value={filters.metro ?? ""}
              onChange={(e) => setFilters({ ...filters, metro: e.target.value || null })}
            >
              <option value="">All cities</option>
              {metros.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          )}
          <label
            className="muted"
            title={idle}
            style={{ display: "flex", gap: 6, alignItems: "center", ...(searching ? DIM : {}) }}
          >
            <input
              type="checkbox"
              disabled={searching}
              checked={filters.remote}
              onChange={(e) => setFilters({ ...filters, remote: e.target.checked })}
            />
            Remote only
          </label>
          <span className="spacer" />
          {refreshing.line ? (
            <span className="held-text">{refreshing.line}</span>
          ) : (
            <button
              type="button"
              className="small"
              onClick={async () => {
                const res = await ctx.post("/api/refresh", {});
                const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
                ctx.toast(out.toast);
              }}
            >
              Refresh all
            </button>
          )}
        </div>
        {searching ? (
          <>
            <div className="faint" style={{ fontSize: 13, margin: "-4px 0 6px" }}>
              {idle}.
            </div>
            <FoundLines ctx={ctx} q={filters.q!} setTyped={setTyped} />
            {rows(found, searchFilters)}
          </>
        ) : (
          <>
            {/* Only fits reach the Inbox; the titles in your places that might be yours wait here. */}
            <ReviewLine ctx={ctx} />
            {/* What Dismiss cleared: those companies' roles that fit stay out of the Inbox. */}
            <DismissedLine />
            {companies.length === 0 &&
              (filters.source || filters.metro || filters.remote ? (
                <div className="empty" style={{ paddingLeft: 0 }}>
                  Nothing new for these filters.
                </div>
              ) : (
                <EmptyHint ctx={ctx} where="inbox" />
              ))}
            {rows(inboxList, filters)}
          </>
        )}
      </section>
      {/* Every other company with a board: all its open roles, to browse when nothing is new. */}
      {!searching && (
        <section>
          <SectionHead count={others.count} label="Everything else" />
          {others.companies?.length === 0 && (
            <div className="empty" style={{ paddingLeft: 0 }}>
              No other companies with a board.
            </div>
          )}
          {rows(others, otherFilters)}
        </section>
      )}
    </main>
  );
}

const DIM = { opacity: 0.45 };

const inbox: BoardFeature = {
  name: "inbox",
  order: 5,
  pages: {
    inbox: (ctx, params) => <InboxPage ctx={ctx} params={params} />,
    titles: (ctx) => <ReviewTitles ctx={ctx} />,
  },
};

export default inbox;

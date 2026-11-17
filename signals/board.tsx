// The Signals screen: every company a signal named that has nothing open that fits you, why, and
// what can be done. Not a to-do list: no count in the top bar, nothing to clear. Three groups by
// the useful action (a near miss to apply to, nothing posted to Work on, a page to look at
// yourself), then folds: hiring for other kinds of work, older than 90 days, noise, hidden by you.
import { useCallback, useEffect, useState } from "react";
import { startApply } from "../apply/board.tsx";
import { ago, safeHref, shortDate } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import { work, workCompany } from "../decisions/board.tsx";
import { type Filters, RoleRow, useCompanies } from "../inbox/board.tsx";
import type { RoleView } from "../inbox/query.ts";
import type { SignalsCompany, View } from "./query.ts";

type Summary = {
  counts: Record<View, number>;
  sources: { source: string; tag: string }[];
  work: string | null; // what one Work run costs at most
  workBlocked: string | null; // why Work can't start
};
type Reason = "all" | "hiring" | "posted" | "unread";

function Btn({
  label,
  onClick,
  primary,
  title,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={primary ? "small primary" : "small"}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

/** A company's open roles, near misses first, each with why it doesn't fit; Apply works as in the Inbox. */
function Roles({ c, act }: { c: SignalsCompany; act: (id: number, action: string) => Promise<void> }) {
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const load = useCallback(
    async (cursor: string | null) => {
      const res = await fetch(`/api/companies/${c.id}/roles?view=all${cursor ? `&cursor=${cursor}` : ""}`);
      if (!res.ok) return;
      const body = (await res.json()) as { roles: RoleView[]; next: string | null };
      setRoles((prev) => (cursor ? [...prev, ...body.roles] : body.roles));
      setNext(body.next);
    },
    [c.id],
  );
  useEffect(() => {
    load(null);
  }, [load]);
  return (
    <div style={{ paddingLeft: 16, paddingBottom: 8 }}>
      {roles.map((r) => (
        <RoleRow
          key={r.id}
          r={r}
          watched={false}
          act={async (id, action) => {
            // The role shows what you chose (Dismiss, Apply) once it's done.
            await act(id, action);
            load(null);
          }}
        />
      ))}
      {next && (
        <button type="button" className="small link" onClick={() => load(next)}>
          more roles
        </button>
      )}
    </div>
  );
}

/** What named it: the newest signal's source, date, the start of what it said, and its link. */
function SignalLine({ c }: { c: SignalsCompany }) {
  const s = c.signal;
  if (!s) return <span className="faint">No signal on record</span>;
  const said = s.title ?? s.text;
  // A dropped file names a company by its website alone: nothing more to open.
  const dropped = s.source === "drop" && !said;
  return (
    <span className="muted" style={{ fontSize: 13 }}>
      {s.tag} · {shortDate(s.at)}
      {dropped
        ? " · in a file you dropped"
        : said
          ? ` · “${said.length > 140 ? `${said.slice(0, 138)}…` : said}”`
          : ""}{" "}
      {s.url && !dropped && (
        <a href={safeHref(s.url)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {s.kind === "posting" ? "the posting" : "the post"}
        </a>
      )}
      {c.signals > 1 && <span className="faint"> · named {c.signals} times</span>}
    </span>
  );
}

function CompanyRow({
  c,
  last,
  summary,
  act,
  actCompany,
  paste,
  copied,
}: {
  c: SignalsCompany;
  last: boolean;
  summary: Summary | null;
  act: (id: number, action: string) => Promise<void>;
  actCompany: (action: string) => void;
  paste: (value: string) => Promise<boolean>;
  copied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [given, setGiven] = useState("");
  const opens = c.held > 0;
  const site = c.domain ? `https://${c.domain}` : null;
  const link = c.careers_url ?? c.board?.url ?? site;
  // No board that reads: you can give its careers page or job board yourself (as Sources' Board
  // found step takes it). It's read then; nothing is searched for.
  const showLink = !!link && (c.group === "unread" || link !== site);
  const canPaste = c.group === "unread" || (c.group === "posted" && c.board?.status !== "ok");
  return (
    <div
      style={{
        borderBottom: "1px solid var(--line)",
        boxShadow: last ? "inset 3px 0 0 var(--ink)" : undefined,
      }}
      title={last ? "You last acted here" : undefined}
    >
      <div
        className="row"
        style={{
          gridTemplateColumns: "minmax(0,1fr) auto",
          borderBottom: 0,
          cursor: opens ? "pointer" : undefined,
        }}
        onClick={() => opens && setOpen(!open)}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
            {site ? (
              <a
                href={safeHref(site)}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 17, fontWeight: 600 }}
                onClick={(e) => e.stopPropagation()}
                title={`${c.name}'s website`}
              >
                {c.name}
              </a>
            ) : (
              <span style={{ fontSize: 17, fontWeight: 600 }}>{c.name}</span>
            )}
            {c.domain && <span className="faint">{c.domain}</span>}
            <span className={c.near ? "held-text" : "muted"}>{c.why}</span>
            {c.at && <span className="faint">{ago(c.at)}</span>}
            {opens && <span className="faint">{open ? "▾" : "▸"}</span>}
          </div>
          {c.nearRole && !open && (
            <span className="muted" style={{ fontSize: 13 }}>
              {c.nearRole.title} · {c.nearRole.why}
            </span>
          )}
          {c.note && (
            <span className="muted" style={{ fontSize: 13 }}>
              The app saw: {c.note}
            </span>
          )}
          <SignalLine c={c} />
          {c.reading && (
            <span className="muted" style={{ fontSize: 13 }}>
              Looking at the page you gave…
            </span>
          )}
          {(showLink || c.funding) && (
            <span style={{ fontSize: 13, display: "flex", gap: 10 }}>
              {showLink && (
                <a
                  href={safeHref(link)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {link === c.board?.url ? "open its job board" : "open its careers page"}
                </a>
              )}
              {c.funding && (
                <a href={safeHref(c.funding.url)} target="_blank" rel="noreferrer" className="faint">
                  Form D filed {c.funding.date}
                </a>
              )}
            </span>
          )}
        </div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          {c.email && !c.held && (
            <>
              {/* Applies by email: Apply opens the thread (Work, then Mark sent); nothing is sent for you. */}
              <span className="faint">applies by email · {c.email}</span>
              <Copy text={c.email} onCopied={copied} />
              <Btn label="Apply" primary onClick={() => actCompany("apply_email")} />
            </>
          )}
          <Btn
            label="Work"
            primary={!c.held && !c.email}
            title={summary?.work ? `Work: ${summary.work}` : (summary?.workBlocked ?? undefined)}
            onClick={() => actCompany("work")}
          />
          {c.group === "unread" && <Btn label="Try again" onClick={() => actCompany("retry")} />}
          {canPaste && !c.reading && (
            <Btn
              label="Paste its board"
              title="Give its careers page or job board yourself"
              onClick={() => {
                setPasting(!pasting);
                setGiven("");
              }}
            />
          )}
          <Btn label="Watch" onClick={() => actCompany("watch")} />
          {c.hidden ? (
            <Btn label="Unhide" onClick={() => actCompany("unhide")} />
          ) : (
            <Btn
              label="Hide"
              title="Off this list only: a role that fits later still reaches your Inbox"
              onClick={() => actCompany("hide")}
            />
          )}
          <Btn
            label="Dismiss"
            title="This company and whatever it posts later stay out"
            onClick={() => actCompany("dismiss")}
          />
        </div>
      </div>
      {pasting && canPaste && !c.reading && (
        <form
          className="sig-paste"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await paste(given)) setPasting(false);
          }}
        >
          <div>
            <label htmlFor={`paste-${c.id}`}>Careers page or job board</label>
            <input
              id={`paste-${c.id}`}
              // biome-ignore lint/a11y/noAutofocus: the field opens on your click, to type in at once
              autoFocus
              placeholder="example.com/careers"
              value={given}
              onChange={(e) => setGiven(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setPasting(false);
                }
              }}
            />
          </div>
          <button type="submit" className="small primary" disabled={!given.trim()}>
            Save
          </button>
          <button type="button" className="small" onClick={() => setPasting(false)}>
            Cancel
          </button>
        </form>
      )}
      {open && opens && <Roles c={c} act={act} />}
    </div>
  );
}

/** One list, a page at a time, updated in place when something changes. */
function List({
  view,
  filters,
  ctx,
  summary,
  onChange,
  empty,
}: {
  view: View;
  filters: Filters;
  ctx: Ctx;
  summary: Summary | null;
  onChange: () => void;
  empty?: string;
}) {
  const list = useCompanies<SignalsCompany>(`/api/signals/${view}`, filters);
  const act = async (company: number, roleId: number, action: string) => {
    const res = await ctx.post(`/api/roles/${roleId}`, { action });
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    ctx.toast(out.toast);
    await list.reloadCompany(company);
    onChange();
    await ctx.refetch();
    // Apply goes straight on, as in the Inbox: the thread opens, and the form with it.
    if (res.ok && out.thread) {
      ctx.open(out.thread);
      if (out.url) await startApply(ctx, out.thread, out.url);
      if (out.work) await work(ctx, out.thread);
    }
  };
  const actCompany = async (company: number, action: string) => {
    if (action === "work") {
      await workCompany(ctx, company);
    } else {
      const [url, body] =
        action === "hide" || action === "unhide"
          ? ["/api/signals/hide", { id: company, hide: action === "hide" }]
          : action === "retry"
            ? ["/api/sources/retry", { step: "board", id: company }]
            : [`/api/companies/${company}`, { action }];
      const res = await ctx.post(url as string, body);
      const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
      if (out.toast) ctx.toast(out.toast);
      if (res.ok && out.thread) ctx.open(out.thread);
    }
    await list.reloadCompany(company);
    onChange();
    await ctx.refetch();
  };
  // A careers page or board you give: Sources' by-hand path reads it now, with the same checks.
  const paste = async (c: SignalsCompany, value: string) => {
    const res = await ctx.post("/api/sources/hand", { step: "board", id: c.id, value });
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    if (!res.ok) {
      ctx.toast(out.toast ?? "That didn't work");
      return false;
    }
    ctx.toast(
      `${c.name}: the page is looked at now, and its roles read at the next read, within 15 minutes. If one fits you, ${c.name} moves to your Inbox; if not, it stays here with what was found.`,
    );
    await list.reloadCompany(c.id);
    return true;
  };
  if (!list.companies)
    return (
      <div className="faint" style={{ padding: "8px 0" }}>
        Loading…
      </div>
    );
  return (
    <>
      {list.arrived > 0 && (
        <button type="button" className="small link" onClick={() => list.load()}>
          {list.arrived} more since you opened this · show from the top
        </button>
      )}
      {list.companies.length === 0 && empty && (
        <div className="empty" style={{ paddingLeft: 0 }}>
          {empty}
        </div>
      )}
      {list.companies.map((c) => (
        <CompanyRow
          key={c.id}
          c={c}
          last={c.id === list.last}
          summary={summary}
          act={(roleId, action) => act(c.id, roleId, action)}
          actCompany={(action) => actCompany(c.id, action)}
          paste={(value) => paste(c, value)}
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
}

function Head({ label, n, sub }: { label: string; n: number | undefined; sub?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, margin: "18px 0 6px" }}>
      <div className="sec-head" style={{ margin: 0 }}>
        <span className="label">
          {label}
          {n !== undefined ? ` · ${n.toLocaleString("en-US")}` : ""}
        </span>
      </div>
      {sub && (
        <span className="muted" style={{ fontSize: 13 }}>
          {sub}
        </span>
      )}
    </div>
  );
}

/** A fold: its count, its list once opened. */
function Fold({
  label,
  sub,
  n,
  children,
}: {
  label: string;
  sub?: string;
  n: number;
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!n) return null;
  return (
    <div>
      <button type="button" className="collapsed" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          {label} · {n.toLocaleString("en-US")}
        </span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <>
          {sub && (
            <div className="muted" style={{ fontSize: 13, margin: "6px 0" }}>
              {sub}
            </div>
          )}
          {children()}
        </>
      )}
    </div>
  );
}

const GROUPS: { view: "hiring" | "posted" | "unread"; label: string; sub: string; empty: string }[] = [
  {
    view: "hiring",
    label: "Hiring, nothing that fits you",
    sub: "Near misses: a role with your title words in a place, or a way of working, that isn't one of yours. Open a company to see its roles and why each doesn't fit.",
    empty: "No near misses.",
  },
  {
    view: "posted",
    label: "Nothing posted",
    sub: "No open role to apply to. Work gathers what's public, then writes the problem, the person to write to and your proof, for a note of your own.",
    empty: "Nothing here.",
  },
  {
    view: "unread",
    label: "Couldn't be read",
    sub: "It has a careers page or board the app couldn't read: open it and look yourself, or try again.",
    empty: "Nothing here: every careers page found was read.",
  },
];

function SignalsPage({ ctx }: { ctx: Ctx }) {
  const [typed, setTyped] = useState("");
  const [filters, setFilters] = useState<Filters>({ source: null, remote: false, metro: null, q: "" });
  const [reason, setReason] = useState<Reason>("all");
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    const t = setTimeout(
      () => setFilters((f) => (f.q === typed.trim() ? f : { ...f, q: typed.trim() })),
      250,
    );
    return () => clearTimeout(t);
  }, [typed]);
  const loadSummary = useCallback(async () => {
    const p = new URLSearchParams();
    if (filters.source) p.set("source", filters.source);
    if (filters.q) p.set("q", filters.q);
    const r = await fetch(`/api/signals/summary?${p}`);
    if (r.ok) setSummary(await r.json());
  }, [filters.source, filters.q]);
  useEffect(() => {
    loadSummary();
    window.addEventListener("inbox.changed", loadSummary);
    return () => window.removeEventListener("inbox.changed", loadSummary);
  }, [loadSummary]);
  const n = summary?.counts;
  const filtered = !!(filters.q || filters.source);
  const shown = n ? n.hiring + n.other + n.posted + n.unread : 0;
  const anything = n ? Object.values(n).some((x) => x > 0) : false;
  return (
    <main className="queue">
      <section>
        <div className="sec-head">
          <span className="label">Signals</span>
        </div>
        <p className="muted" style={{ margin: "6px 0", maxWidth: 760 }}>
          Companies your sources named that have nothing open that fits you, so they aren't in your Inbox. Not
          a to-do list: look when you like.{" "}
          {summary?.work
            ? `What Work costs: ${summary.work}.`
            : summary?.workBlocked
              ? summary.workBlocked
              : ""}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", margin: "10px 0" }}>
          <input
            type="search"
            aria-label="Search companies and what named them"
            placeholder="Search companies and what named them"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setTyped("")}
            style={{ width: 280 }}
          />
          <div className="segmented" role="group" aria-label="Why it's here">
            {(
              [
                ["all", "All"],
                ["hiring", "Hiring"],
                ["posted", "Nothing posted"],
                ["unread", "Couldn't be read"],
              ] as [Reason, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={reason === k} onClick={() => setReason(k)}>
                {label}
              </button>
            ))}
          </div>
          {summary && summary.sources.length > 1 && (
            <div className="segmented" role="group" aria-label="Source">
              <button
                type="button"
                aria-pressed={!filters.source}
                onClick={() => setFilters({ ...filters, source: null })}
              >
                Every source
              </button>
              {summary.sources.map((s) => (
                <button
                  key={s.source}
                  type="button"
                  aria-pressed={filters.source === s.source}
                  onClick={() => setFilters({ ...filters, source: s.source })}
                >
                  {s.tag}
                </button>
              ))}
            </div>
          )}
        </div>
        {summary && !anything && (
          <div className="empty" style={{ paddingLeft: 0 }}>
            {filtered
              ? `Nothing on Signals matches${filters.q ? ` “${filters.q}”` : " this source"}.`
              : "No companies here yet. When a source names a company with nothing open that fits you, it shows here, with why."}
          </div>
        )}
        {summary && anything && shown === 0 && (
          <div className="empty" style={{ paddingLeft: 0 }}>
            {filtered
              ? "Nothing from the last 90 days matches: see the folds below."
              : "Nothing named in the last 90 days: older companies and the rest are in the folds below."}
          </div>
        )}
      </section>
      {GROUPS.filter((g) => reason === "all" || reason === g.view).map((g) =>
        reason === "all" && !n?.[g.view] && !(g.view === "hiring" && n?.other) ? null : (
          <section key={g.view}>
            <Head label={g.label} n={n?.[g.view]} sub={g.sub} />
            <List
              view={g.view}
              filters={filters}
              ctx={ctx}
              summary={summary}
              onChange={loadSummary}
              empty={filtered ? "Nothing matches." : g.empty}
            />
            {g.view === "hiring" && (
              <Fold
                label="Hiring only for other kinds of work"
                sub="Open roles, none with your title words (a warehouse hiring for its warehouse)."
                n={n?.other ?? 0}
              >
                {() => (
                  <List view="other" filters={filters} ctx={ctx} summary={summary} onChange={loadSummary} />
                )}
              </Fold>
            )}
          </section>
        ),
      )}
      <section>
        <Fold label="Show older: named more than 90 days ago" n={reason === "all" ? (n?.older ?? 0) : 0}>
          {() => <List view="older" filters={filters} ctx={ctx} summary={summary} onChange={loadSummary} />}
        </Fold>
        <Fold
          label="Hidden as noise"
          sub="Set aside without asking, never deleted: no signal on record, a fund rather than a company hiring, a name that names no company, no website known, or a website that doesn't answer."
          n={reason === "all" ? (n?.noise ?? 0) : 0}
        >
          {() => <List view="noise" filters={filters} ctx={ctx} summary={summary} onChange={loadSummary} />}
        </Fold>
        <Fold label="Hidden by you" n={reason === "all" ? (n?.hidden ?? 0) : 0}>
          {() => <List view="hidden" filters={filters} ctx={ctx} summary={summary} onChange={loadSummary} />}
        </Fold>
      </section>
    </main>
  );
}

const signals: BoardFeature = {
  name: "signals",
  order: 6,
  pages: { signals: (ctx) => <SignalsPage ctx={ctx} /> },
};

export default signals;

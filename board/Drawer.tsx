import { type ReactNode, useState } from "react";
import type { Cited, Detail, Fact } from "../core/derive.ts";
import type { Entry } from "../core/log.ts";
import { isStandIn } from "../core/vocab.ts";
import {
  age,
  citedSources,
  domainOf,
  linkLabel,
  roleHref,
  roleWord,
  safeHref,
  sentence,
  statusWord,
} from "./format.ts";
import { useWorkLine } from "./progress.ts";
import { type Ctx, type Fold, registry } from "./slots.ts";
import { Copy, State } from "./ui.tsx";

const GROUPS = ["product", "founder", "hiring", "money", "you"];

/** The Person line: a role only beside the name it belongs to, and with no one named, a note that
 * opens with "no person found" (what the worker is told to write) doesn't say it again. */
export function personOf(d: Detail): { who: string; role: string; text: string } {
  const r = d.research;
  const name = r?.person.name || d.contact?.name || "";
  const role = r?.person.name ? r.person.role : d.contact?.name ? d.contact.role : "";
  const text = r?.person.text ?? "";
  if (name) return { who: name, role, text };
  return {
    who: r ? "no person found" : "",
    role: "",
    text: text.replace(/^\s*no person found\s*[.:;,—-]?\s*/i, ""),
  };
}

/** The block as plain text, fact numbers kept, for pasting into a message draft. */
export function researchText(d: Detail): string {
  const r = d.research;
  if (!r) return "";
  const n = (facts: number[]) => (facts.length ? ` (${facts.join(", ")})` : "");
  const p = personOf(d);
  const who = [p.who, p.role].filter(Boolean).join(", ");
  const sources = citedSources(d).filter((x) => x.href);
  return [
    `Problem: ${r.problem.text}${n(r.problem.facts)}`,
    `Person: ${who}${p.text ? ` — ${p.text}` : ""}${n(r.person.facts)}`,
    `Proof${r.proof.budget ? ` (${r.proof.budget})` : ""}: ${r.proof.text}${n(r.proof.facts)}`,
    ...(sources.length ? ["", "Sources:", ...sources.map((x) => `[${x.n}] ${x.href}`)] : []),
  ].join("\n");
}

async function decide(ctx: Ctx, id: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await ctx.post(`/api/threads/${id}/decision`, body);
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  ctx.toast(out.toast);
  if (res.ok) await ctx.refetch(id);
  return res.ok;
}

function sourceLabel(f: Fact): { label: string; href?: string } {
  const s = f.source;
  if (!s) return { label: "no source" };
  const when = age(s.fetched_at ?? f.ts);
  return { label: `${linkLabel(s.url)} · ${when}`, href: safeHref(s.url) };
}

function FactRow({ f }: { f: Fact }) {
  const [open, setOpen] = useState(false);
  const src = sourceLabel(f);
  return (
    <div className={`fact${f.used ? "" : " unused"}`} onClick={() => setOpen(!open)}>
      <span className="num muted">{f.n}</span>
      <div>
        <span>{f.text}</span>
        {f.failed && f.source && <span className="mini-tag">source changed</span>}
        {!f.source && <span className="mini-tag">unsourced</span>}
        {f.late && <span className="late"> new</span>}
        {!f.used && (
          <span className="muted" style={{ fontSize: 12 }}>
            {" "}
            unused
          </span>
        )}
        {open && f.source?.quote && <blockquote>{f.source.quote}</blockquote>}
      </div>
      {src.href ? (
        <a
          className="src"
          href={src.href}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {src.label}
        </a>
      ) : (
        <span className="src">{src.label}</span>
      )}
    </div>
  );
}

function Evidence({ d }: { d: Detail }) {
  if (d.facts.length === 0) return null;
  const groups = [...GROUPS, ...new Set(d.facts.map((f) => f.group).filter((g) => !GROUPS.includes(g)))];
  const late = d.facts.filter((f) => f.late);
  const lateBy = new Map<string, number>();
  for (const f of late) lateBy.set(f.actor, (lateBy.get(f.actor) ?? 0) + 1);
  return (
    <section className="d-sec">
      <div className="d-label">Evidence</div>
      {groups.map((g) => {
        const facts = d.facts.filter((f) => f.group === g);
        if (facts.length === 0) return null;
        return (
          <div key={g} className="d-sec" style={{ gap: 6 }}>
            <div className="group">{g}</div>
            {facts.map((f) => (
              <FactRow key={f.id} f={f} />
            ))}
          </div>
        );
      })}
      {[...lateBy].map(([actor, n]) => (
        <div key={actor} className="late">
          +{n} from {sentence(actor)}
        </div>
      ))}
    </section>
  );
}

function Channels({ d, ctx }: { d: Detail; ctx: Ctx }) {
  if (d.channels.length === 0) return null;
  return (
    <div className="channels">
      {d.channels.map((c) =>
        c.channel.toLowerCase() === "linkedin" ? (
          <div key={c.channel + c.value} style={{ display: "contents" }}>
            <span className="muted">LinkedIn</span>
            <a href={safeHref(c.url ?? c.value)} target="_blank" rel="noreferrer">
              Open profile
            </a>
            <span className="conf-guessed">link</span>
            <span />
          </div>
        ) : (
          <div key={c.channel + c.value} style={{ display: "contents" }}>
            <span className="muted">{c.channel === "x" ? "X" : sentence(c.channel)}</span>
            <span>
              {c.value} {c.source && <span className="faint">· {c.source}</span>}
            </span>
            <span className={`conf-${c.confidence}`}>{c.confidence}</span>
            <Copy
              text={c.value}
              onCopied={() => {
                ctx.toast("Copied");
                ctx
                  .post(`/api/threads/${d.id}/decision`, { action: "copy", what: c.channel })
                  .catch(() => {});
              }}
            />
          </div>
        ),
      )}
    </div>
  );
}

/** One line of the block; click a fact number for its quote and source. */
function Line({
  label,
  head,
  line,
  d,
  children,
}: {
  label: string;
  head?: string;
  line: Cited | undefined;
  d: Detail;
  children?: ReactNode;
}) {
  const [shown, setShown] = useState<number | null>(null);
  const f = shown === null ? undefined : d.facts.find((x) => x.n === shown);
  const src = f && sourceLabel(f);
  return (
    <div className={`point${line?.uncited ? " unsourced" : ""}`}>
      <span className="muted">{label}</span>
      <div>
        {head && <div style={{ fontWeight: 600 }}>{head}</div>}
        {line?.text && <span>{line.text}</span>}
        {line?.uncited && <span className="mini-tag">uncited</span>}
        {children}
        {f && (
          <blockquote>
            {f.source?.quote || f.text}
            {src?.href && (
              <div>
                <a href={src.href} target="_blank" rel="noreferrer">
                  {src.label}
                </a>
              </div>
            )}
          </blockquote>
        )}
      </div>
      <span className="num muted" style={{ fontSize: 12, display: "flex", gap: 4 }}>
        {line?.facts.length
          ? line.facts.map((n) => (
              <button
                key={n}
                type="button"
                className="small link"
                aria-label={`Fact ${n}`}
                onClick={() => setShown(shown === n ? null : n)}
              >
                {n}
              </button>
            ))
          : "—"}
      </span>
    </div>
  );
}

/** The facts the block cites, once each: one click opens the issue, post or page itself. */
function Sources({ d }: { d: Detail }) {
  const sources = citedSources(d);
  if (sources.length === 0) return null;
  return (
    <div className="point sources">
      <span className="muted">Sources</span>
      <div>
        {sources.map((x) => (
          <div key={x.n} className="source">
            <span className="num muted">{x.n}</span>
            {x.href ? (
              <a href={x.href} target="_blank" rel="noreferrer">
                {x.label} ↗
              </a>
            ) : (
              <span>{x.label}</span>
            )}
            <span className="muted">{x.text}</span>
          </div>
        ))}
      </div>
      <span />
    </div>
  );
}

/** Problem / Person / Proof, every line with the facts it rests on. */
function Research({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const progress = useWorkLine(d.id);
  const r = d.research;
  const working = d.status === "researching";
  if (!r && !d.contact && !working) return null;
  const { who, role, text } = personOf(d);
  return (
    <section className="d-sec">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="d-label">Research</span>
        <span style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          {r && r.uncited > 0 && (
            <span className="mono held-text" style={{ fontSize: 12 }}>
              {r.uncited} uncited
            </span>
          )}
          {r && (
            <Copy
              text={researchText(d)}
              onCopied={() => {
                ctx.toast("Copied");
                ctx
                  .post(`/api/threads/${d.id}/decision`, { action: "copy", what: "research" })
                  .catch(() => {});
              }}
            />
          )}
        </span>
      </div>
      {working && (
        <div className="muted">
          researching ·{" "}
          {progress ??
            (d.tonight ? "next in line" : isStandIn(d.id) ? "waiting for website" : "waiting to start")}
        </div>
      )}
      <div className="points">
        {r && <Line label="Problem" line={r.problem} d={d} />}
        {who && (
          <Line
            label="Person"
            head={[who, role].filter(Boolean).join(" · ")}
            line={r ? { ...r.person, text } : undefined}
            d={d}
          >
            <Channels d={d} ctx={ctx} />
          </Line>
        )}
        {r && <Line label={r.proof.budget ? `Proof · ${r.proof.budget}` : "Proof"} line={r.proof} d={d} />}
        <Sources d={d} />
      </div>
    </section>
  );
}

/** The company's roles, one line each. Gone roles stay, greyed; dismissed ones fold away at the end. */
function Roles({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  if (d.roles.length === 0) return null;
  const shown = d.roles.filter((r) => r.status !== "dismissed");
  const dismissed = d.roles.filter((r) => r.status === "dismissed");
  return (
    <section className="d-sec" style={{ gap: 6 }}>
      <div className="d-label">Roles</div>
      {shown.map((r) => (
        <RoleLine key={r.key} r={r} d={d} ctx={ctx} />
      ))}
      {dismissed.length > 0 && (
        <button type="button" className="collapsed" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span>Dismissed · {dismissed.length}</span>
          <span>{open ? "▾" : "▸"}</span>
        </button>
      )}
      {open && dismissed.map((r) => <RoleLine key={r.key} r={r} d={d} ctx={ctx} />)}
    </section>
  );
}

function RoleLine({ r, d, ctx }: { r: Detail["roles"][number]; d: Detail; ctx: Ctx }) {
  const out = r.status === "gone" || r.status === "dismissed";
  return (
    <div
      className={out ? "faint" : ""}
      style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline" }}
    >
      {r.url ? (
        <a href={roleHref(r.url)} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
          {r.title}
        </a>
      ) : (
        <span style={{ fontWeight: 500 }}>{r.title}</span>
      )}
      <span className="muted">{r.location || "location unknown"}</span>
      <State state={roleWord(r)} />
      {r.status === "apply" && (
        <button
          type="button"
          className="small"
          onClick={() => decide(ctx, d.id, { action: "drop", url: r.key })}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export function describe(e: Entry): string {
  const d = e.data ?? {};
  // Old logs also hold hypothesis, talking_points, proof and problem_tag entries.
  switch (e.kind as string) {
    case "hypothesis":
      return `hypothesis: ${d.text}`;
    case "talking_points":
      return "talking points";
    case "signal":
      return `${d.source_tag ?? "signal"}${d.title ? `: ${d.title}` : ""}${e.source?.url ? ` · ${domainOf(e.source.url)}` : ""}`;
    case "decision":
      return [d.action.replaceAll("_", " "), d.reason, d.text, d.url, d.until && `until ${d.until}`]
        .filter(Boolean)
        .join(" · ");
    case "fact":
      return `fact: ${d.text}`;
    case "contact":
      return `contact: ${d.name}${d.role ? `, ${d.role}` : ""}`;
    case "research":
      return d.problem ? `research: ${d.problem.text}` : (d.text ?? "research");
    case "note":
      if (d.event === "run_done")
        return [
          d.text,
          d.read?.length ? `read ${d.read.length} page${d.read.length > 1 ? "s" : ""}` : null,
          d.skipped?.length
            ? `skipped ${d.skipped.map((x: { source: string }) => x.source).join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
      return d.text ?? d.event ?? "note";
    default:
      return d.text ?? d.label ?? e.kind.replaceAll("_", " ");
  }
}

const timelineFold: Fold = {
  key: "timeline",
  label: "Timeline",
  order: 90,
  summary: (d) => `${d.entries.length} entries`,
  render: (d) => (
    <div className="timeline">
      {[...d.entries].reverse().map((e) => (
        <div key={e.id} style={{ display: "contents" }}>
          <span className="faint">
            {new Date(e.ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
          </span>
          <span className="muted">{e.actor}</span>
          <span>{describe(e)}</span>
        </div>
      ))}
    </div>
  ),
};

function Folds({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const [open, setOpen] = useState<string | null>(null);
  const folds = [...registry.flatMap((f) => f.folds ?? []), timelineFold].sort((a, b) => a.order - b.order);
  return (
    <section className="folds">
      {folds.map((f) => {
        const summary = f.summary(d);
        if (summary === null) return null;
        const isOpen = open === f.key;
        return (
          <div className="fold" key={f.key}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : f.key)}>
              <span className="d-label">{f.label}</span>
              <span className="muted">{summary}</span>
              <span className="muted">{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen && <div className="fold-body">{f.render(d, ctx)}</div>}
          </div>
        );
      })}
    </section>
  );
}

export function Drawer({
  d,
  position,
  updated,
  ctx,
}: {
  d: Detail;
  position: { n: number; of: number } | null;
  updated: boolean;
  ctx: Ctx;
}) {
  const sub = [d.contact?.name, d.contact?.role, statusWord(d)].filter(Boolean).join(" · ");
  const footers = registry.map((f) => f.footer?.(d, ctx)).filter(Boolean);
  return (
    <>
      <div className="scrim" onClick={() => ctx.open(null)} />
      <aside className="drawer" aria-label={d.company}>
        <header className="d-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div className="d-company">{d.company}</div>
            <div className="d-sub">{sub}</div>
          </div>
          <div className="d-pos">
            {updated && <span className="updated">updated</span>}
            {position && (
              <span className="faint">
                {position.n} of {position.of}
              </span>
            )}
            <button type="button" className="d-close" aria-label="Close" onClick={() => ctx.open(null)}>
              ×
            </button>
          </div>
        </header>
        <div className="d-body">
          <Roles d={d} ctx={ctx} />
          {registry.map((f) => (
            <div key={f.name} style={{ display: "contents" }}>
              {f.drawerSections?.(d, ctx)}
            </div>
          ))}
          <Research d={d} ctx={ctx} />
          <Evidence d={d} />
          <Folds d={d} ctx={ctx} />
        </div>
        {footers.length > 0 && <footer className="d-foot">{footers}</footer>}
      </aside>
    </>
  );
}

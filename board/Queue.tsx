import { useState } from "react";
import type { Summary } from "../core/derive.ts";
import { age, pad2, rolesSummary, statusWord } from "./format.ts";
import { useWorkLine } from "./progress.ts";
import type { Ctx } from "./slots.ts";
import type { Layout } from "./store.ts";
import { EmptyHint, State } from "./ui.tsx";

function ThreadRow({ s, selected, ctx }: { s: Summary; selected: boolean; ctx: Ctx }) {
  const line = useWorkLine(s.id);
  const word = line ? `researching · ${line}` : statusWord(s);
  return (
    <div className={`row quiet${selected ? " selected" : ""}`} onClick={() => ctx.open(s.id)}>
      <span className="n">{s.needsYou ? <span className="sq sig" /> : null}</span>
      <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline" }}>
        <span className="company">{s.company}</span>
        <span className="muted">{rolesSummary(s.roles)}</span>
        <span className="faint">{age(s.lastTs)}</span>
      </div>
      {word ? <State state={word} /> : <span />}
    </div>
  );
}

function Collapsed({ label, rows, ctx }: { label: string; rows: Summary[]; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="collapsed" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          {label} · {rows.length}
        </span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && rows.map((s) => <ThreadRow key={s.id} s={s} selected={false} ctx={ctx} />)}
    </div>
  );
}

export function SectionHead({ count, label, big }: { count: number; label: string; big?: boolean }) {
  return (
    <div className="sec-head">
      <span className={`sec-count${big ? " big" : ""}`}>{pad2(count)}</span>
      <span className="label">{label}</span>
    </div>
  );
}

/** Threads: one list, companies needing you on top, then by last activity. */
export function Queue({
  layout,
  rows,
  openId,
  ctx,
}: {
  layout: Layout;
  rows: Map<string, Summary>;
  openId: string | null;
  ctx: Ctx;
}) {
  const get = (ids: string[]) => ids.map((id) => rows.get(id)).filter((s): s is Summary => !!s);
  const open = get(layout.open);
  const closed = get(layout.closed);
  const applied = get(layout.applied);
  const dropped = get(layout.dropped);
  return (
    <main className="queue">
      <section>
        <SectionHead count={open.filter((s) => s.needsYou).length} label="Threads · need you" big />
        {open.map((s) => (
          <ThreadRow key={s.id} s={s} selected={s.id === openId} ctx={ctx} />
        ))}
        {open.length === 0 && applied.length === 0 && dropped.length === 0 && (
          <EmptyHint ctx={ctx} where="threads" />
        )}
      </section>
      {closed.length > 0 && <Collapsed label="Closed" rows={closed} ctx={ctx} />}
      {applied.length > 0 && <Collapsed label="Applied" rows={applied} ctx={ctx} />}
      {dropped.length > 0 && <Collapsed label="Dismissed" rows={dropped} ctx={ctx} />}
    </main>
  );
}

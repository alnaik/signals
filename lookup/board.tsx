import { useCallback, useEffect, useState } from "react";
import { age, safeHref, sentence } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import { isStandIn } from "../core/vocab.ts";
import type { Found, Lookup, Mode, Quote } from "./lookup.ts";

// The panel is the top bar's: open over any screen (and over a thread), from its button or a
// thread's "Find an email". What it shows lives here, so both reach it.
type View = "recent" | Mode;
let panel: { open: boolean; view: View; company: string } = { open: false, view: "recent", company: "" };
const listeners = new Set<() => void>();
const setPanel = (p: Partial<typeof panel>) => {
  panel = { ...panel, ...p };
  for (const l of listeners) l();
};

/** Open Look up on Find a person, with the company filled in. */
export function openLookUp(company: string): void {
  setPanel({ open: true, view: "person", company });
}

function usePanel() {
  const [p, setP] = useState(panel);
  useEffect(() => {
    const l = () => setP(panel);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return p;
}

/** Calls fn now and on every lookup change from the server. */
function useLookupChanges(fn: () => void) {
  useEffect(() => {
    fn();
    window.addEventListener("lookup.changed", fn);
    return () => window.removeEventListener("lookup.changed", fn);
  }, [fn]);
}

const dollars = (x: number) => `$${x.toFixed(2)}`;
// What a lookup spent: a few cents, to the tenth of a cent.
const spent = (x: number) => (x > 0 && x < 1 ? `$${x.toFixed(3)}` : dollars(x));
// "Up to": rounded up to the cent, so the most it could cost is never understated.
const upTo = (x: number) => dollars(Math.ceil(x * 100 - 1e-9) / 100);

async function send(ctx: Ctx, url: string, body: unknown) {
  const res = await ctx.post(url, body);
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  if (out.toast) ctx.toast(out.toast);
  return { ok: res.ok, out };
}

/** The line above every Run: the most this press costs, and the month's room. */
function CostLine({ mode, q }: { mode: Mode; q: Record<string, string> }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const key = new URLSearchParams({ mode, ...q }).toString();
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await fetch(`/api/lookups/quote?${key}`).catch(() => null);
      if (r?.ok) setQuote(await r.json());
    }, 250);
    return () => clearTimeout(t);
  }, [key]);
  return (
    <div className="lk-note">
      {quote && (
        <div>
          {quote.upTo > 0 ? `Up to ${upTo(quote.upTo)} this press` : "Nothing paid this press"} ·{" "}
          {dollars(quote.left)} left of this month's {dollars(quote.cap)}
        </div>
      )}
      {quote?.slow && (
        <div className="muted">
          Exa's agent can take up to 3 min. It goes on if you close this panel; Recent shows it.
        </div>
      )}
      <div className="muted">Nothing here enters your Inbox or a thread until you press Save.</div>
    </div>
  );
}

function Field({
  label,
  value,
  set,
  placeholder,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="lk-field">
      <span className="muted">{label}</span>
      <input
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
}

function PersonForm({ ctx, company, ran }: { ctx: Ctx; company: string; ran: () => void }) {
  const [f, setF] = useState({ name: "", company, role: "", github: "" });
  useEffect(() => setF((x) => ({ ...x, company })), [company]);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const go = async () => {
    const { ok } = await send(ctx, "/api/lookups", { mode: "person", ...f });
    if (ok) ran();
  };
  return (
    <div className="lk-form">
      <Field label="Name" value={f.name} set={set("name")} placeholder="First Last" />
      <Field
        label="Company"
        value={f.company}
        set={set("company")}
        placeholder="a company known here, or its domain (acme.dev)"
      />
      <Field label="Role" value={f.role} set={set("role")} placeholder="Head of Engineering" />
      <Field label="GitHub" value={f.github} set={set("github")} placeholder="optional: their username" />
      <CostLine mode="person" q={{ company: f.company, name: f.name, role: f.role }} />
      <div>
        <button type="button" className="primary" disabled={!f.name.trim() || !f.company.trim()} onClick={go}>
          Run
        </button>
      </div>
    </div>
  );
}

function PeopleForm({ ctx, company, ran }: { ctx: Ctx; company: string; ran: () => void }) {
  const [f, setF] = useState({ company, titles: "" });
  useEffect(() => setF((x) => ({ ...x, company })), [company]);
  const titles = f.titles
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const go = async () => {
    const { ok } = await send(ctx, "/api/lookups", { mode: "people", company: f.company, titles });
    if (ok) ran();
  };
  return (
    <div className="lk-form">
      <Field
        label="Company"
        value={f.company}
        set={(v) => setF((x) => ({ ...x, company: v }))}
        placeholder="a company known here, or its domain (acme.dev)"
      />
      <Field
        label="Titles"
        value={f.titles}
        set={(v) => setF((x) => ({ ...x, titles: v }))}
        placeholder="CTO, Head of Engineering"
      />
      <CostLine mode="people" q={{ company: f.company, titles: titles.join(",") }} />
      <div>
        <button type="button" className="primary" disabled={!f.company.trim() || !titles.length} onClick={go}>
          Run
        </button>
      </div>
    </div>
  );
}

/** One person: what was found, Find email (People), Save to the company's thread. */
function FoundRow({
  ctx,
  l,
  p,
  n,
  emailCost,
}: {
  ctx: Ctx;
  l: Lookup;
  p: Found;
  n: number;
  emailCost: number | null;
}) {
  const find = async (confirm = false) => {
    const { out } = await send(ctx, `/api/lookups/${l.id}/email`, { n, confirm });
    if (out.ask && window.confirm(`${out.ask} Up to ${upTo(emailCost ?? 0)} more.`)) await find(true);
  };
  const profile = safeHref(p.profile_urls[0]);
  return (
    <div className="lk-person">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600 }}>{p.name}</span>
        {p.role && <span className="muted">{p.role}</span>}
        {profile && (
          <a className="faint" href={profile} target="_blank" rel="noreferrer">
            {p.source} ↗
          </a>
        )}
      </div>
      {p.hits && p.hits.length > 0 && (
        <div className="channels">
          {p.hits.map((h) => (
            <div key={h.channel + h.value} style={{ display: "contents" }}>
              <span className="muted">{h.channel === "x" ? "X" : sentence(h.channel)}</span>
              <span style={{ overflowWrap: "anywhere" }}>
                {h.value} <span className="faint">· {h.source}</span>
              </span>
              <span className={`conf-${h.confidence}`}>{h.confidence}</span>
              <Copy text={h.value} onCopied={() => ctx.toast("Copied")} />
            </div>
          ))}
        </div>
      )}
      {p.hits && !p.hits.some((h) => h.channel === "email") && (
        <span className="faint">
          {p.dropped ? "emails dropped after 30 days" : "no email found"}
          {p.steps?.length ? ` · ${p.steps.join(" · ")}` : ""}
        </span>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {l.mode === "people" &&
          (p.finding ? (
            <span className="muted">finding the email…</span>
          ) : (
            !p.hits && (
              <button type="button" className="small" onClick={() => find()}>
                Find email{emailCost ? ` · up to ${upTo(emailCost)}` : ""}
              </button>
            )
          ))}
        {p.saved ? (
          <button
            type="button"
            className="small link"
            onClick={() => {
              setPanel({ open: false });
              ctx.open(p.saved!);
            }}
          >
            saved · open the thread
          </button>
        ) : (
          !p.finding && (
            <button
              type="button"
              className="small primary"
              onClick={() => send(ctx, `/api/lookups/${l.id}/save`, { n })}
            >
              Save
            </button>
          )
        )}
      </div>
    </div>
  );
}

function asked(l: Lookup): string {
  const at = l.results?.company.name ?? l.inputs.company;
  return l.mode === "person" ? `${l.inputs.name} at ${at}` : `${(l.inputs.titles ?? []).join(", ")} at ${at}`;
}

function LookupItem({ ctx, l }: { ctx: Ctx; l: Lookup }) {
  const [open, setOpen] = useState(l.status !== "running");
  const [emailCost, setEmailCost] = useState<number | null>(null);
  const domain = l.results?.company.domain ?? "";
  useEffect(() => {
    if (l.mode !== "people" || !domain) return;
    fetch(`/api/lookups/quote?${new URLSearchParams({ mode: "person", company: domain })}`)
      .then((r) => r.json())
      .then((q: Quote) => setEmailCost(q.upTo))
      .catch(() => {});
  }, [l.mode, domain]);
  const people = l.results?.people ?? [];
  const running = l.status === "running";
  return (
    <div className="lk-item">
      <button type="button" className="lk-item-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          <span className="faint">{l.mode === "person" ? "Find a person" : "People at a company"}</span>{" "}
          {asked(l)}
        </span>
        <span className="faint">
          {running ? (l.line ?? "running") : l.status === "failed" ? "failed" : `${people.length} found`} ·{" "}
          {spent(l.usd)} · {age(l.finished_at ?? l.started_at)}
        </span>
      </button>
      {open && (
        <div className="lk-item-body">
          {l.results?.error && <span className="held-text">{l.results.error}</span>}
          {l.results?.skipped?.length ? <span className="faint">{l.results.skipped.join(" · ")}</span> : null}
          {people.length > 0 && (
            <span className="muted">
              Save puts a person on {l.results?.company.name}'s thread, opening it if there is none. A thread
              with no one becomes "person found"; one that has a person keeps them, and this one is added
              beside them.
            </span>
          )}
          {people.map((p, n) => (
            // A lookup's people never reorder: their place is who they are (Find email and Save name it).
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <FoundRow key={n} ctx={ctx} l={l} p={p} n={n} emailCost={emailCost} />
          ))}
          {running && !people.length && <span className="muted">{l.line ?? "starting"}</span>}
        </div>
      )}
    </div>
  );
}

function Recent({ ctx, list }: { ctx: Ctx; list: Lookup[] | null }) {
  if (!list) return null;
  if (!list.length)
    return <div className="muted">No lookups yet. Find a person's email, or the people at a company.</div>;
  const running = list.filter((l) => l.status === "running");
  const finished = list.filter((l) => l.status !== "running");
  return (
    <>
      {running.length > 0 && <div className="d-label">Running · {running.length}</div>}
      {running.map((l) => (
        <LookupItem key={l.id} ctx={ctx} l={l} />
      ))}
      {finished.length > 0 && <div className="d-label">Finished</div>}
      {finished.map((l) => (
        <LookupItem key={l.id} ctx={ctx} l={l} />
      ))}
    </>
  );
}

function Panel({ ctx }: { ctx: Ctx }) {
  const p = usePanel();
  const [list, setList] = useState<Lookup[] | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/lookups").catch(() => null);
    if (!r?.ok) return;
    const body = (await r.json()) as { lookups: Lookup[]; unseen: number };
    setList(body.lookups);
    // Shown is seen: the button's count goes once Recent has shown them.
    if (body.unseen && panel.view === "recent") void ctx.post("/api/lookups/seen", {});
  }, [ctx]);
  useLookupChanges(load);
  // biome-ignore lint/correctness/useExhaustiveDependencies: back on Recent, what it shows is seen
  useEffect(() => {
    if (p.view === "recent") load();
  }, [p.view]);
  useEffect(() => {
    // Escape closes the panel alone: a thread open under it stays.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPanel({ open: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const tab = (v: View, label: string) => (
    <button type="button" aria-pressed={p.view === v} onClick={() => setPanel({ view: v })}>
      {label}
    </button>
  );
  const ran = () => setPanel({ view: "recent" });
  return (
    <>
      <div className="scrim lk-scrim" onClick={() => setPanel({ open: false })} />
      <aside className="drawer lk-panel" aria-label="Look up">
        <header className="d-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div className="d-company">Look up</div>
            <div className="d-sub">
              On your own providers, in your contact order. It runs on if you close this.
            </div>
          </div>
          <button
            type="button"
            className="d-close"
            aria-label="Close Look up"
            onClick={() => setPanel({ open: false })}
          >
            ×
          </button>
        </header>
        <div className="d-body">
          <div className="segmented" role="group" aria-label="Look up" style={{ alignSelf: "flex-start" }}>
            {tab("recent", "Recent")}
            {tab("person", "Find a person")}
            {tab("people", "People at a company")}
          </div>
          {p.view === "recent" && <Recent ctx={ctx} list={list} />}
          {p.view === "person" && <PersonForm ctx={ctx} company={p.company} ran={ran} />}
          {p.view === "people" && <PeopleForm ctx={ctx} company={p.company} ran={ran} />}
        </div>
      </aside>
    </>
  );
}

/** "Look up", or "Look up · 2 done" for finished lookups not seen yet; the panel when open. */
function LookUp({ ctx }: { ctx: Ctx }) {
  const p = usePanel();
  const [done, setDone] = useState(0);
  const load = useCallback(async () => {
    const r = await fetch("/api/lookups/unseen").catch(() => null);
    if (r?.ok) setDone(((await r.json()) as { unseen: number }).unseen);
  }, []);
  useLookupChanges(load);
  return (
    <>
      <button
        type="button"
        aria-expanded={p.open}
        className={done ? "lk-done" : ""}
        onClick={() => setPanel({ open: !p.open, view: done ? "recent" : panel.view })}
      >
        Look up{done ? ` · ${done} done` : ""}
      </button>
      {p.open && <Panel ctx={ctx} />}
    </>
  );
}

const lookup: BoardFeature = {
  name: "lookup",
  order: 30,
  topBar: (ctx) => <LookUp ctx={ctx} />,
  // A thread's company, filled in: its domain, or its name while it has none.
  footer: (d) =>
    d.status !== "closed" && (
      <button key="lookup" type="button" onClick={() => openLookUp(isStandIn(d.id) ? d.company : d.id)}>
        Find an email
      </button>
    ),
};

export default lookup;

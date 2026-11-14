import { useEffect, useState } from "react";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import type { Detail } from "../core/derive.ts";

async function decide(ctx: Ctx, id: string, body: Record<string, unknown>, url?: string): Promise<boolean> {
  const res = await ctx.post(url ?? `/api/threads/${id}/decision`, body);
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  ctx.toast(out.toast);
  if (res.ok) await ctx.refetch(id);
  return res.ok;
}

// The positioning page, offered in the thread the first time Work is pressed without one. "Not
// now" is remembered in this browser; Work runs either way.
const LATER = "jobsignal.positioning.later";
let offerFor: string | null = null;
const listeners = new Set<() => void>();
const setOffer = (id: string | null) => {
  offerFor = id;
  for (const l of listeners) l();
};
// Why Work couldn't start, by thread: said in the thread's footer too, since a toast goes.
const blocked = new Map<string, string>();

/** Start Work; when it can't start, the reason stays on the thread until the next press. */
async function startWork(ctx: Ctx, id: string): Promise<void> {
  const res = await ctx.post(`/api/work/${id}`, {});
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  ctx.toast(out.toast);
  if (res.ok) blocked.delete(id);
  else blocked.set(id, out.toast);
  for (const l of listeners) l();
  if (res.ok) await ctx.refetch(id);
}

/** Work on a thread, or first the positioning offer when there is no page and it wasn't put off. */
async function work(ctx: Ctx, id: string): Promise<void> {
  if (!localStorage.getItem(LATER)) {
    const p = (await fetch("/api/positioning")
      .then((r) => r.json())
      .catch(() => ({ exists: true }))) as { exists: boolean };
    if (!p.exists) return setOffer(id);
  }
  await startWork(ctx, id);
}

/**
 * Work on a company with no role (the Inbox, the Watchlist): its thread opens, then Work starts or
 * waits its turn. The toast is Work's answer, or why it can't start.
 */
export async function workCompany(ctx: Ctx, company: number): Promise<void> {
  const res = await ctx.post(`/api/companies/${company}`, { action: "work" });
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  if (!res.ok || !out.thread) return ctx.toast(out.toast);
  ctx.open(out.thread);
  await work(ctx, out.thread);
}

/** What the positioning page is, the prompt to start it, the two results pasted back; or not now. */
function PositioningOffer({ id, ctx }: { id: string; ctx: Ctx }) {
  const [prompt, setPrompt] = useState("");
  const [md, setMd] = useState("");
  const [ev, setEv] = useState("");
  useEffect(() => {
    fetch("/api/positioning/prompt")
      .then((r) => r.json())
      .then((b: { prompt: string }) => setPrompt(b.prompt))
      .catch(() => {});
  }, []);
  const go = async () => {
    setOffer(null);
    await startWork(ctx, id);
  };
  return (
    <div style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
      <strong>Before your first Work: a positioning page</strong>
      <span>
        It is a short private page on who you are for, the problems you solve and what proves it, with links.
        Work reads it to pick something you could make for this company; without it, Work still runs with less
        to go on.
      </span>
      <span className="muted">
        Copy the prompt into a new Claude chat with your CV and links attached, then paste its two results
        here.
      </span>
      <div>
        <Copy text={prompt} label="Copy the prompt" onCopied={() => ctx.toast("Copied")} />
      </div>
      <textarea
        aria-label="The first result: your positioning page"
        rows={5}
        placeholder="Paste the first result here: your positioning page"
        value={md}
        onChange={(e) => setMd(e.target.value)}
      />
      <textarea
        aria-label="The second result: the evidence"
        rows={3}
        placeholder="Paste the second result here: the evidence, one line each (optional)"
        value={ev}
        onChange={(e) => setEv(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="primary"
          disabled={!md.trim()}
          onClick={async () => {
            const r = await ctx.post("/api/setup/positioning", { md, evidence: ev });
            if (!r.ok) return ctx.toast("Couldn't save it");
            await go();
          }}
        >
          Save and Work
        </button>
        <button
          type="button"
          onClick={async () => {
            localStorage.setItem(LATER, new Date().toISOString());
            await go();
          }}
        >
          Not now
        </button>
      </div>
      <span className="faint">It stays in Settings &gt; Positioning page.</span>
    </div>
  );
}

/** Work · Mark sent / Got a reply. */
function Footer({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const [offer, setOfferHere] = useState(offerFor === d.id);
  const [why, setWhy] = useState(blocked.get(d.id) ?? null);
  useEffect(() => {
    const l = () => {
      setOfferHere(offerFor === d.id);
      setWhy(blocked.get(d.id) ?? null);
    };
    listeners.add(l);
    // An offer made between this footer's first draw and now (Work from the Inbox opens a new
    // thread and offers at once) would otherwise be missed.
    l();
    return () => {
      listeners.delete(l);
    };
  }, [d.id]);
  if (d.status === "closed") return null;
  if (offer) return <PositioningOffer id={d.id} ctx={ctx} />;
  const btn = (label: string, onClick: () => void, cls = "") => (
    <button key={label} type="button" className={cls} onClick={onClick}>
      {label}
    </button>
  );
  const sent = d.status === "sent" || d.status === "replied";
  return (
    <>
      {why && d.status !== "researching" && (
        <span className="held-text" style={{ flexBasis: "100%", fontSize: 13 }}>
          {why}
        </span>
      )}
      {d.status === "researching"
        ? btn(d.tonight ? "Next in line" : "Researching…", () => {}, "quiet")
        : btn("Work", () => work(ctx, d.id), d.status ? "" : "primary")}
      {sent
        ? d.status === "sent" && btn("Got a reply", () => decide(ctx, d.id, { action: "got_reply" }))
        : btn("Mark sent", () => decide(ctx, d.id, { action: "mark_sent" }), d.contact ? "primary" : "")}
    </>
  );
}

const decisions: BoardFeature = {
  name: "decisions",
  order: 10,
  footer: (d, ctx) => <Footer key={`${d.id}:${d.status}`} d={d} ctx={ctx} />,
};

export default decisions;

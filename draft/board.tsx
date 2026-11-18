// The message on a thread, under Work's block: written when you press for it, with Copy and no
// send button. What enters it is checked in code (draft/shape.ts).
import { useState } from "react";
import { safeHref } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import type { Detail } from "../core/derive.ts";
import {
  type DraftData,
  draftState,
  type FollowupData,
  MAX_FOLLOWUP_WORDS,
  MAX_WORDS,
  messageText,
  PART_LABEL,
} from "./shape.ts";

const day = (ts: string) => new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function Link({ url, label }: { url: string; label?: string }) {
  const href = safeHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {label ?? url} ↗
    </a>
  ) : (
    <span>{label ?? url}</span>
  );
}

/** A fact as the thread numbers it, with its source. */
function FactRef({ d, id }: { d: Detail; id?: string }) {
  const f = id ? d.facts.find((x) => x.id === id) : undefined;
  if (!f) return null;
  return (
    <span className="muted">
      matches fact {f.n}: {f.text}
      {f.source?.url && (
        <>
          {" "}
          · <Link url={f.source.url} label="source" />
        </>
      )}
    </span>
  );
}

/** Marking the proof Work planned as built, with its link: then a draft leads with it. */
function ProofBuilt({ d, ctx, url }: { d: Detail; ctx: Ctx; url: string | null }) {
  const [link, setLink] = useState("");
  if (url)
    return (
      <div>
        <span className="muted">Proof built · </span>
        <Link url={url} />
      </div>
    );
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span className="muted">Built the proof? Its link:</span>
      <input
        aria-label="The proof's link"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="https://"
        style={{ flex: 1, minWidth: 160 }}
      />
      <button
        type="button"
        className="small"
        disabled={!link.trim()}
        onClick={async () => {
          const res = await ctx.post(`/api/threads/${d.id}/decision`, { action: "proof_built", url: link });
          const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
          ctx.toast(out.toast);
          if (res.ok) await ctx.refetch(d.id);
        }}
      >
        Mark built
      </button>
    </div>
  );
}

/** The message as it will be copied, each sentence with what it rests on; then what is missing. */
function Body({ m, max }: { m: DraftData | FollowupData; max: number }) {
  const over = m.words - max;
  return (
    <div className="points">
      {m.step === "draft" && (
        <div>
          <span className="muted">To </span>
          <span style={{ fontWeight: 600 }}>{m.to.name}</span>
          {m.to.address ? (
            <span>
              {" "}
              · {m.to.address}{" "}
              <span className="faint">· verified{m.to.source ? `, from ${m.to.source}` : ""}</span>
            </span>
          ) : (
            <span className="held-text"> · no address found</span>
          )}
        </div>
      )}
      {m.step === "draft" && m.subject && (
        <div>
          <span className="muted">Subject </span>
          {m.subject}
        </div>
      )}
      <div>{m.greeting}</div>
      {m.sentences.map((s) => (
        <div key={s.part + s.text} className="point">
          <span className="muted">{m.step === "draft" ? PART_LABEL[s.part] : ""}</span>
          <span>{s.text}</span>
          <span className="num muted" style={{ fontSize: 12 }}>
            {s.facts.length
              ? `fact ${s.facts.join(", ")}`
              : s.evidence.length
                ? "your evidence"
                : s.part === "made"
                  ? "your proof"
                  : ""}
          </span>
        </div>
      ))}
      <div>{m.signoff}</div>
      <div className="mono" style={{ fontSize: 12 }}>
        <span className={over > 0 ? "held-text" : "muted"}>
          {m.words} / {max}
          {over > 0 ? ` · ${over} over: shorten it yourself` : ""}
        </span>
      </div>
      {m.missing.map((x) => (
        <div key={x} className="held-text" style={{ fontSize: 12 }}>
          {x}
        </div>
      ))}
    </div>
  );
}

function Message({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const [busy, setBusy] = useState(false);
  const [others, setOthers] = useState(false);
  if (!d.research) return null;
  const s = draftState(d.entries);
  const go = async (body: Record<string, unknown>) => {
    setBusy(true);
    setOthers(false);
    const res = await ctx.post(`/api/draft/${d.id}`, body);
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    setBusy(false);
    ctx.toast(out.toast);
    await ctx.refetch(d.id);
  };
  const last = s.last?.data;
  const draft = last?.step === "draft" ? (last as DraftData) : null;
  const pairs = (s.candidates?.data.pairs ?? []) as { claim: string; url: string; fact: string }[];
  const showPairs = !s.proof && pairs.length > 0 && (last?.step === "candidates" || others);
  const picked = draft && !draft.made.built ? draft.made : null;
  const fu = s.followup?.data;
  const copy = (what: "draft" | "followup") => () => {
    ctx.toast("Copied");
    ctx
      .post(`/api/threads/${d.id}/decision`, { action: "copy", what })
      .then(() => ctx.refetch(d.id))
      .catch(() => {});
  };
  return (
    <section className="d-sec">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="d-label">Message</span>
        {draft && <Copy text={messageText(draft)} onCopied={copy("draft")} />}
      </div>
      <ProofBuilt d={d} ctx={ctx} url={s.proof?.url ?? null} />
      {last?.step === "none" && <div className="held-text">{last.text}</div>}
      {showPairs && (
        <div className="d-sec" style={{ gap: 6 }}>
          <span className="muted">No proof is built. Pick the item of your evidence to lead with:</span>
          {pairs.map((p, i) => (
            <div key={p.url + p.fact} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
                <span>
                  {p.claim} · <Link url={p.url} label="link" />
                </span>
                <FactRef d={d} id={p.fact} />
              </div>
              <button type="button" className="small" disabled={busy} onClick={() => go({ pick: i })}>
                {picked?.url === p.url ? "Use again" : "Use this"}
              </button>
            </div>
          ))}
        </div>
      )}
      {draft && (
        <>
          {picked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span>
                <span className="muted">Your evidence: </span>
                {picked.claim}
              </span>
              <FactRef d={d} id={picked.fact} />
            </div>
          )}
          <Body m={draft} max={MAX_WORDS} />
        </>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        {!draft && last?.step !== "candidates" && (
          <button type="button" className="small primary" disabled={busy} onClick={() => go({})}>
            {busy ? "Writing…" : "Write a draft"}
          </button>
        )}
        {draft && !s.copied && (
          <button type="button" className="small" disabled={busy} onClick={() => go({ again: true })}>
            {busy ? "Writing…" : "Write again"}
          </button>
        )}
        {draft && !s.copied && !s.proof && pairs.length > 1 && (
          <button type="button" className="small link" onClick={() => setOthers(!others)}>
            Other evidence
          </button>
        )}
        {s.copied && <span className="muted">Draft first copied {day(s.copied)}</span>}
        {s.copied && draft && !s.followupCopied && (
          <button type="button" className="small" disabled={busy} onClick={() => go({ followup: true })}>
            {busy ? "Writing…" : "Write a follow-up"}
          </button>
        )}
      </div>
      {fu?.step === "followup_none" && <div className="muted">{fu.text}</div>}
      {fu?.step === "followup" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="muted">
              Follow-up{s.followupCopied ? ` · copied ${day(s.followupCopied)}, the only one` : ""}
            </span>
            <Copy text={messageText(fu as FollowupData)} onCopied={copy("followup")} />
          </div>
          <Body m={fu as FollowupData} max={MAX_FOLLOWUP_WORDS} />
        </>
      )}
    </section>
  );
}

const draft: BoardFeature = {
  name: "draft",
  underWork: (d, ctx) => <Message key={d.id} d={d} ctx={ctx} />,
};

export default draft;

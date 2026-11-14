import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { safeHref } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import type { Detail, Role } from "../core/derive.ts";
import { EXTENSION_ID } from "../extension/id.ts";
import type { Field } from "./forms.ts";
import { isLinkedIn } from "./linkedin.ts";
import type { ApplyFile } from "./prepare.ts";

type ApplyData = {
  files: (ApplyFile & { fields: Field[] })[];
  pdfs: string[];
  board: string | null; // the company's own board or careers page
};

const ATS: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };

// Each Apply started on a thread, whichever button started it (its panel's, or the Inbox's): the
// panel reloads what the board prepared, which changes nothing in the thread's log, and shows the
// CV picker for the role when the board asked which CV.
type Started = { n: number; ask: Record<string, string[]> }; // role → the PDFs to pick from
const started = new Map<string, Started>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

// The Applies on their way (thread and role): a press while one is (a double click, or the panel's
// button while the Inbox's Apply is still reading the form) starts nothing, so the form opens once.
const opening = new Set<string>();
const openingKey = (thread: string, url: string) => `${thread} ${url}`;
const tell = () => {
  for (const l of listeners) l();
};

function record(thread: string, url: string, ask: string[] | null): void {
  const s = started.get(thread);
  const { [url]: _, ...rest } = s?.ask ?? {};
  started.set(thread, { n: (s?.n ?? 0) + 1, ask: ask ? { ...rest, [url]: ask } : rest });
  tell();
}

function useApply(d: Detail) {
  const [data, setData] = useState<ApplyData | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/apply/${d.id}`);
    if (r.ok) setData(await r.json());
  }, [d.id]);
  const starts = useSyncExternalStore(subscribe, () => started.get(d.id)?.n ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the thread changes or an Apply started
  useEffect(() => {
    load();
  }, [load, d.lastTs, starts]);
  return { data, load };
}

type Runtime = { sendMessage: (id: string, msg: unknown) => Promise<unknown> };
const runtime = () => (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;

/** A message to the Job Signal extension; null when it isn't in this browser. */
export async function toExtension(msg: unknown): Promise<unknown> {
  const rt = runtime();
  if (!rt?.sendMessage) return null;
  try {
    return await rt.sendMessage(EXTENSION_ID, msg);
  } catch {
    return null;
  }
}

/**
 * Apply on a role: one click; when me/ holds more than one PDF, one more to pick the role's (once
 * per role). Once at a time per role: a press while it's on its way does nothing.
 */
export async function startApply(
  ctx: Ctx,
  thread: string,
  url: string,
  pdf?: string,
): Promise<string[] | null> {
  const key = openingKey(thread, url);
  if (opening.has(key)) return null;
  opening.add(key);
  tell();
  try {
    return await applyOnce(ctx, thread, url, pdf);
  } finally {
    opening.delete(key);
    tell();
  }
}

async function applyOnce(ctx: Ctx, thread: string, url: string, pdf?: string): Promise<string[] | null> {
  const ext = !!(await toExtension({ type: "hello" }));
  const res = await ctx.post(`/api/apply/${thread}`, { url, ext, ...(pdf ? { pdf } : {}) });
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  // The extension opens the form in a tab linked to this company, so the tab fills. No answer (it
  // was reloading into a newer build): the form opens unfilled, as without the extension.
  if (out.open && !(await toExtension({ type: "open", ...out.open }))) {
    const again = await ctx.post(`/api/apply/${thread}`, { url, ...(pdf ? { pdf } : {}) });
    out.toast = again.ok
      ? "The extension didn't answer: the form opened unfilled"
      : ((await again.json().catch(() => null))?.toast ?? "Something went wrong");
  }
  ctx.toast(out.toast);
  await ctx.refetch(thread);
  record(thread, url, out.ask ?? null);
  return out.ask ?? null;
}

function OpenField({ f, d, ctx, onSaved }: { f: Field; d: Detail; ctx: Ctx; onSaved: () => void }) {
  const [text, setText] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, padding: "4px 0" }}>
      {f.options ? (
        <select
          aria-label={`Answer: ${f.label}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1 }}
        >
          <option value="">What you picked on the form, to reuse next time</option>
          {f.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <textarea
          aria-label={`Answer: ${f.label}`}
          rows={2}
          placeholder="What you wrote on the form, to reuse next time"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1 }}
        />
      )}
      <button
        type="button"
        className="small"
        disabled={!text.trim()}
        onClick={async () => {
          const r = await ctx.post(`/api/apply/${d.id}/answer`, { question: f.label, answer: text });
          ctx.toast((await r.json()).toast);
          if (r.ok) onSaved();
        }}
      >
        Save answer
      </button>
    </div>
  );
}

function Panel({
  d,
  r,
  a,
  data,
  ctx,
  load,
}: {
  d: Detail;
  r: Role;
  a: ApplyData["files"][number] | undefined;
  data: ApplyData;
  ctx: Ctx;
  load: () => void;
}) {
  const ask = useSyncExternalStore(subscribe, () => started.get(d.id)?.ask[r.key] ?? null);
  const busy = useSyncExternalStore(subscribe, () => opening.has(openingKey(d.id, r.key)));
  const go = (pdf?: string) => startApply(ctx, d.id, r.key, pdf);
  // Done once you applied; Dismiss when the form showed the posting is gone or not for you.
  const decision = async (action: "applied" | "drop") => {
    const res = await ctx.post(`/api/threads/${d.id}/decision`, { action, url: r.key });
    ctx.toast((await res.json().catch(() => ({ toast: "Something went wrong" }))).toast);
    await ctx.refetch(d.id);
  };
  // A role from a LinkedIn alert: never applied on there, so no form opens.
  const linkedin = !!r.url && isLinkedIn(r.url);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontWeight: 500 }}>{r.title}</span>
        {a && <span className="faint">{a.ats ? ATS[a.ats] : "the company's own form"}</span>}
        {a?.pdf && <span className="faint">CV: {a.pdf}</span>}
        <span className="spacer" />
        {!linkedin && (
          <button type="button" className="small primary" disabled={busy} onClick={() => go()}>
            {busy ? "Opening the form…" : a ? "Open the form again" : "Apply"}
          </button>
        )}
        {(a || linkedin) && (
          <>
            <button type="button" className="small" onClick={() => decision("applied")}>
              Done
            </button>
            <button type="button" className="small" onClick={() => decision("drop")}>
              Dismiss
            </button>
          </>
        )}
      </div>
      {a && !busy && (
        <div className="muted" style={{ fontSize: 13 }}>
          Next: the form is open in your browser. Fill in what is missing and press Submit there yourself,
          then press Done here. Dismiss if the posting is gone or isn't for you.
        </div>
      )}
      {linkedin && (
        <div className="held-text">
          This role came from LinkedIn, and LinkedIn is never applied on: apply on {d.company}'s own board
          {data.board ? (
            <>
              {" · "}
              <a href={safeHref(data.board)} target="_blank" rel="noreferrer">
                open it
              </a>
            </>
          ) : (
            " (none found yet)"
          )}
          .
        </div>
      )}
      {ask && (
        <div className="reason-row">
          <span className="muted">Which CV for {r.title}?</span>
          {ask.map((f) => (
            <button key={f} type="button" className="small" disabled={busy} onClick={() => go(f)}>
              {f}
            </button>
          ))}
        </div>
      )}
      {!data.pdfs.length && (
        <div className="held-text">No PDF in me/ yet: add your CV there to attach it.</div>
      )}
      {a?.error && <div className="muted">{a.error}</div>}
      {a && !a.ats && (
        <div className="muted">
          This form isn't read ahead: the extension fills what it can; answer on the form.
        </div>
      )}
      {a?.fields.map((f) => (
        <div key={f.key} style={{ fontSize: 13 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <span style={{ flex: "0 0 40%" }}>{f.label}</span>
            <span className="muted" style={{ flex: 1, overflowWrap: "anywhere" }}>
              {f.kind === "file" ? (f.value ? f.value.split("/").at(-1) : "") : f.value}
            </span>
            <span className="faint">{f.source}</span>
            {f.value && f.kind !== "file" && <Copy text={f.value} onCopied={() => ctx.toast("Copied")} />}
          </div>
          {f.missing && <div className="held-text">{f.missing}</div>}
          {f.kind === "open" && !f.value && <OpenField f={f} d={d} ctx={ctx} onSaved={load} />}
        </div>
      ))}
    </div>
  );
}

/** The Apply panel: for each role you chose and haven't applied to, the form and its fields. */
function ApplyPanel({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const { data, load } = useApply(d);
  const open = d.roles.filter((r) => r.status === "apply");
  if (!data || open.length === 0 || d.status === "closed") return null;
  return (
    <section className="d-sec" style={{ gap: 4 }}>
      <div className="d-label">Apply</div>
      {open.map((r) => (
        <Panel
          key={r.key}
          d={d}
          r={r}
          a={r.url && isLinkedIn(r.url) ? undefined : data.files.find((f) => f.role.key === r.key)}
          data={data}
          ctx={ctx}
          load={load}
        />
      ))}
    </section>
  );
}

const apply: BoardFeature = {
  name: "apply",
  order: 15,
  drawerSections: (d, ctx) => <ApplyPanel key={d.id} d={d} ctx={ctx} />,
};

export default apply;

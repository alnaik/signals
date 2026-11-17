// The lines under the search box: what the words found, a word that left nothing, the
// descriptions searched, and the offer to read the missing ones (inbox/read.ts).
import { useCallback, useEffect, useState } from "react";
import type { Ctx } from "../board/slots.ts";

type About = {
  terms: string[];
  total: number;
  fitting: number;
  companies: number;
  missing: { word: string; anywhere: boolean; without: number; meant: string | null } | null;
  texts: { open: number; kept: number; fit: number; fitKept: number };
  offer: { names: string[]; roles: number; minutes: number } | null;
  reading: Reading | null;
};
type Reading = {
  names: string[];
  done: number;
  failed: number;
  total: number;
  stopped: boolean;
  finished?: boolean;
};

const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const CAP = 600; // inbox/read.ts READ_CAP
const names = (xs: string[]) =>
  xs.length > 2 ? `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more` : xs.join(" and ");

/** The typed text with a word taken out, or put in its place. */
export function without(typed: string, word: string, put = ""): string {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return typed
    .replace(new RegExp(`(^|\\s)-?"?${esc}"?(?=\\s|$)`, "i"), (_, sp: string) => (put ? `${sp}${put}` : sp))
    .replace(/\s+/g, " ")
    .trim();
}

export function FoundLines({ ctx, q, setTyped }: { ctx: Ctx; q: string; setTyped: (s: string) => void }) {
  const [a, setA] = useState<About | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/inbox/search/about?q=${encodeURIComponent(q)}`);
    if (!r.ok) return;
    const body = (await r.json()) as About;
    setA(body);
    setReading(body.reading);
  }, [q]);
  useEffect(() => {
    load();
    window.addEventListener("inbox.changed", load);
    return () => window.removeEventListener("inbox.changed", load);
  }, [load]);
  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<Reading>).detail;
      if (r?.finished) {
        setReading(null);
        ctx.toast(
          `${r.stopped ? "Stopped: " : ""}read ${plural(r.done - r.failed, "description")}${
            r.failed ? ` · ${n(r.failed)} couldn't be read` : ""
          }`,
        );
        load();
      } else setReading(r);
    };
    window.addEventListener("inbox.read", on);
    return () => window.removeEventListener("inbox.read", on);
  }, [ctx, load]);
  if (!a) return null;
  const m = a.missing;
  const link = (label: string, onClick: () => void) => (
    <button type="button" className="link" onClick={onClick}>
      {label}
    </button>
  );
  return (
    <div
      className="muted"
      style={{ fontSize: 13, margin: "0 0 10px", display: "flex", flexDirection: "column", gap: 4 }}
    >
      {!(m && !a.total && !a.companies) && (
        <span>
          {a.total
            ? `${plural(a.total, "open role")} at ${plural(a.companies, "company", "companies")} · ${n(a.fitting)} fit you, shown first`
            : a.companies
              ? `${plural(a.companies, "company", "companies")} named by a recent signal, no open role`
              : a.terms.length
                ? `No open role has every word of “${q}”.`
                : "Type a word to look for: -word only leaves roles out."}
        </span>
      )}
      {m && (
        <span className="held-text">
          {m.anywhere ? `No role has “${m.word}” with the other words` : `No role has “${m.word}”`}
          {m.without > 0 && (
            <>
              {" "}
              · {n(m.without)} match without it ·{" "}
              {link("Search without it", () => setTyped(without(q, m.word)))}
            </>
          )}
          {m.meant && <> · Did you mean {link(m.meant, () => setTyped(without(q, m.word, m.meant!)))}?</>}
        </span>
      )}
      {reading ? (
        <span>
          Reading {names(reading.names)}'s descriptions · {n(reading.done)} of {n(reading.total)}
          {reading.failed ? ` (${n(reading.failed)} couldn't be read)` : ""} ·{" "}
          {link("Stop", () =>
            ctx.post("/api/inbox/read", { stop: true }).then(async (r) => ctx.toast((await r.json()).toast)),
          )}
        </span>
      ) : (
        a.offer && (
          <span>
            {names(a.offer.names)}: {plural(a.offer.roles, "open role")} here{" "}
            {a.offer.roles === 1 ? "has" : "have"} no description or no place yet ·{" "}
            {link(a.offer.roles > CAP ? `Read the first ${n(CAP)}` : "Read them", async () => {
              const r = await ctx.post("/api/inbox/read", { q });
              const out = await r.json().catch(() => ({}));
              if (out.toast) ctx.toast(out.toast);
              if (out.reading) setReading(out.reading);
            })}{" "}
            (at least {plural(a.offer.minutes, "minute")}; it goes on if you close the board)
          </span>
        )
      )}
      <span className="faint">
        Descriptions are searched where kept: {n(a.texts.kept)} of {n(a.texts.open)} open roles,{" "}
        {n(a.texts.fitKept)} of the {n(a.texts.fit)} that fit you. Opening a role keeps its description.
      </span>
    </div>
  );
}

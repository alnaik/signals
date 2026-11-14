import { useEffect, useState } from "react";
import { safeHref } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import type { Detail } from "../core/derive.ts";
import type { Result, Watch } from "./actions.ts";

type ProviderInfo = { name: string; label: string; available: boolean; cost: number };

async function post<T>(ctx: Ctx, url: string, body: unknown): Promise<(T & { toast?: string }) | null> {
  const res = await ctx.post(url, body);
  const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
  if (out.toast) ctx.toast(out.toast);
  return res.ok ? out : null;
}

/** Search the free providers for this company; add a result as a fact, or watch the search. */
function Search({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState(d.company);
  const [results, setResults] = useState<Result[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [watched, setWatched] = useState<Watch[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/research/providers")
      .then((r) => r.json())
      .then((list: ProviderInfo[]) => {
        setProviders(list);
        setChosen(list.filter((p) => p.available && p.cost === 0).map((p) => p.name));
      })
      .catch(() => {});
    fetch(`/api/research/${d.id}/watches`)
      .then((r) => r.json())
      .then(setWatched)
      .catch(() => {});
  }, [d.id]);
  const run = async () => {
    setBusy(true);
    const out = await post<{ results: Result[]; errors: Record<string, string> }>(
      ctx,
      `/api/research/${d.id}/search`,
      { query, providers: chosen },
    );
    setBusy(false);
    setResults(out?.results ?? []);
    setErrors(out?.errors ?? {});
  };
  const isWatched = watched.some((w) => w.query === query.trim());
  return (
    <div className="d-sec" style={{ gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          aria-label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder='e.g. "Tessera" is:open label:bug'
          style={{ flex: 1 }}
        />
        <button type="button" className="small primary" disabled={busy || !query.trim()} onClick={run}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {providers.map((p) => (
          <button
            key={p.name}
            type="button"
            className={`small${chosen.includes(p.name) ? " primary" : ""}`}
            disabled={!p.available}
            title={p.available ? (p.cost ? `$${p.cost} a search` : "free") : "not connected"}
            onClick={() =>
              setChosen(chosen.includes(p.name) ? chosen.filter((x) => x !== p.name) : [...chosen, p.name])
            }
          >
            {p.label}
          </button>
        ))}
        <span className="spacer" />
        {results && (
          <button
            type="button"
            className="small link"
            onClick={async () => {
              const out = await post<{ watches: Watch[] }>(ctx, `/api/research/${d.id}/watch`, {
                query: query.trim(),
                providers: chosen,
                on: !isWatched,
                seen: results.map((r) => r.url),
              });
              if (out) setWatched(out.watches);
            }}
          >
            {isWatched ? "Stop watching" : "Watch this search"}
          </button>
        )}
      </div>
      {Object.entries(errors).map(([p, e]) => (
        <div key={p} className="faint">
          {p}: {e}
        </div>
      ))}
      {results?.length === 0 && <div className="faint">Nothing found.</div>}
      {results?.map((r) => (
        <div key={r.url} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <a href={safeHref(r.url)} target="_blank" rel="noreferrer">
              {r.title}
            </a>{" "}
            <span className="faint">{new URL(r.url).hostname}</span>
            {r.flags?.map((f) => (
              <span key={f} className="mini-tag">
                {f}
              </span>
            ))}
            <div className="muted">{r.snippet.slice(0, 240)}</div>
          </div>
          <button
            type="button"
            className="small"
            onClick={async () => {
              if (await post(ctx, `/api/research/${d.id}/fact`, { result: r })) await ctx.refetch(d.id);
            }}
          >
            Add as fact
          </button>
        </div>
      ))}
      {watched.length > 0 && (
        <div className="faint">Watched nightly: {watched.map((w) => `“${w.query}”`).join(", ")}</div>
      )}
    </div>
  );
}

/** A fact you found yourself: the claim, the link and the exact quote. */
function AddFact({ d, ctx }: { d: Detail; ctx: Ctx }) {
  const [f, setF] = useState({ text: "", url: "", quote: "" });
  const field = (k: keyof typeof f, label: string) => (
    <input
      aria-label={label}
      placeholder={label}
      value={f[k]}
      onChange={(e) => setF({ ...f, [k]: e.target.value })}
    />
  );
  return (
    <div className="d-sec" style={{ gap: 6 }}>
      {field("text", "The claim, in a line")}
      {field("url", "Link")}
      {field("quote", "The exact quote from that page")}
      <div>
        <button
          type="button"
          className="small"
          disabled={!f.text.trim() || !f.url.trim() || !f.quote.trim()}
          onClick={async () => {
            if (await post(ctx, `/api/research/${d.id}/yours`, f)) {
              setF({ text: "", url: "", quote: "" });
              await ctx.refetch(d.id);
            }
          }}
        >
          Add a fact
        </button>
      </div>
    </div>
  );
}

const research: BoardFeature = {
  name: "research",
  folds: [
    {
      key: "search",
      label: "Search",
      order: 20,
      summary: () => "GitHub, HN",
      render: (d, ctx) => <Search key={d.id} d={d} ctx={ctx} />,
    },
    {
      key: "add-fact",
      label: "Add a fact",
      order: 30,
      summary: () => "claim, link, quote",
      render: (d, ctx) => <AddFact key={d.id} d={d} ctx={ctx} />,
    },
  ],
};

export default research;

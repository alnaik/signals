import { useCallback, useEffect, useState } from "react";
import { safeHref } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import type { Section } from "./page.ts";

type Data = { title: string; sections: Section[]; exists: boolean };

function linkify(text: string) {
  const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/\S+)/g);
  // Parts of one line never reorder, so position plus text is a stable key.
  return parts.map((p, i) => {
    const key = `${i}:${p}`;
    const md = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (md)
      return (
        <a key={key} href={safeHref(md[2])} target="_blank" rel="noreferrer">
          {md[1]}
        </a>
      );
    if (/^https?:\/\//.test(p))
      return (
        <a key={key} href={safeHref(p)} target="_blank" rel="noreferrer">
          {p}
        </a>
      );
    return <span key={key}>{p}</span>;
  });
}

function PositioningPage({ ctx }: { ctx: Ctx }) {
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/positioning");
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return null;
  const act = async (url: string, body: unknown) => {
    const r = await ctx.post(url, body);
    ctx.toast((await r.json()).toast);
    load();
  };
  return (
    <div className="layout" style={{ paddingTop: 0 }}>
      <main className="queue">
        <div className="sec-head">
          <span className="label">{data.title}</span>
        </div>
        {!data.exists && (
          <div className="empty">
            No positioning page yet. It lives at me/positioning.md in the data folder.
          </div>
        )}
        {data.sections.map((s) => (
          <section key={s.title}>
            <div className="sec-head">
              <span className="sec-count">{String(s.items.length).padStart(2, "0")}</span>
              <span className="label">{s.title}</span>
            </div>
            {s.intro.map((p) => (
              <p key={p} className="muted" style={{ margin: "8px 0" }}>
                {linkify(p)}
              </p>
            ))}
            {s.items.map((it) => (
              <div
                key={it.id}
                className="row quiet"
                style={{ gridTemplateColumns: "minmax(0,1fr) auto", cursor: "default" }}
              >
                <span>{linkify(it.text)}</span>
                <label
                  style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}
                  className="muted"
                >
                  <input
                    type="checkbox"
                    checked={it.public}
                    onChange={(e) => act("/api/positioning/public", { id: it.id, on: e.target.checked })}
                  />
                  public
                </label>
              </div>
            ))}
          </section>
        ))}
      </main>
      <aside className="rail">
        <section>
          <div className="label">Portfolio</div>
          <div className="faint" style={{ padding: "9px 0" }}>
            Public items export with: jobsignal portfolio
          </div>
        </section>
      </aside>
    </div>
  );
}

const positioning: BoardFeature = {
  name: "positioning",
  order: 40,
  topBar: (ctx) => (
    <button type="button" className="top-link" onClick={() => ctx.page("positioning")}>
      Positioning
    </button>
  ),
  pages: { positioning: (ctx) => <PositioningPage ctx={ctx} /> },
};

export default positioning;

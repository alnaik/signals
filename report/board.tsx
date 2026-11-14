import { useCallback, useEffect, useState } from "react";
import { age } from "../board/format.ts";
import type { BoardFeature, Ctx } from "../board/slots.ts";
import type { Problem } from "./report.ts";

function useProblems(): [Problem[], () => void] {
  const [list, setList] = useState<Problem[]>([]);
  const load = useCallback(async () => {
    const r = await fetch("/api/report/problems").catch(() => null);
    if (r?.ok) setList(await r.json());
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  return [list, load];
}

// Shown only when something failed in the last day.
function ProblemsButton({ ctx }: { ctx: Ctx }) {
  const [list] = useProblems();
  if (!list.length) return null;
  return (
    <button type="button" className="crit-text" onClick={() => ctx.page("report")}>
      Problems · {list.length}
    </button>
  );
}

function ReportPage({ ctx }: { ctx: Ctx }) {
  const [list, load] = useProblems();
  const copy = async () => {
    const text = await (await fetch("/api/report")).text();
    await navigator.clipboard.writeText(text);
    ctx.toast("Bug report copied · paste it into Claude Code");
  };
  return (
    <main className="queue" style={{ maxWidth: 860 }}>
      <section>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="label" style={{ flex: 1 }}>
            What failed in the last day
          </div>
          <button type="button" className="small" onClick={load}>
            Refresh
          </button>
          <button type="button" className="small primary" onClick={copy}>
            Copy bug report
          </button>
        </div>
        {list.length === 0 && (
          <div className="faint" style={{ padding: "9px 0" }}>
            Nothing failed.
          </div>
        )}
        {list.map((p) => (
          <div
            key={`${p.area}:${p.what}`}
            className="row quiet"
            style={{ gridTemplateColumns: "minmax(0,1fr) auto", cursor: "default" }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <span>
                <b>{p.area}</b> · {p.what}
                {p.count > 1 ? ` · ${p.count}×` : ""}
              </span>
              <span className="muted" style={{ overflowWrap: "anywhere" }}>
                {p.last.error}
              </span>
            </div>
            <span className="faint">{age(p.last.ts)}</span>
          </div>
        ))}
      </section>
    </main>
  );
}

const report: BoardFeature = {
  name: "report",
  order: 90,
  topBar: (ctx) => <ProblemsButton ctx={ctx} />,
  pages: { report: (ctx) => <ReportPage ctx={ctx} /> },
};

export default report;

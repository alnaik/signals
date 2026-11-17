// Review titles: the Inbox's line, and the page it opens (#/titles).
import { useCallback, useEffect, useState } from "react";
import { SectionHead } from "../board/Queue.tsx";
import type { Ctx } from "../board/slots.ts";
import { Tag } from "../board/ui.tsx";
import type { TitleGroup } from "./titles.ts";

const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** Under the Inbox's switches: how many roles in your places might be yours, and the way to them. */
export function ReviewLine({ ctx }: { ctx: Ctx }) {
  const [c, setC] = useState<{ roles: number; groups: number; fresh: number } | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/review-titles/count")
        .then((r) => (r.ok ? r.json() : null))
        .then(setC)
        .catch(() => {});
    load();
    window.addEventListener("inbox.changed", load);
    return () => window.removeEventListener("inbox.changed", load);
  }, []);
  if (!c?.roles) return null;
  return (
    <div className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
      {plural(c.roles, "more role")} in your places might be yours ·{" "}
      <button type="button" className="link" onClick={() => ctx.page("titles")}>
        Review titles
      </button>
      {c.fresh > 0 && <span className="held-text"> · {plural(c.fresh, "new group")}</span>}
    </div>
  );
}

function Group({ g, act }: { g: TitleGroup; act: (g: TitleGroup, action: "add" | "skip") => void }) {
  return (
    <div className="row quiet" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
      <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 15, fontWeight: 500 }}>
          {g.phrase || `${g.like}, its words in another order`}
        </span>
        <span className="muted">{plural(g.roles, "role")}</span>
        {g.like && g.phrase && <span className="muted">like your {g.like}</span>}
        {g.fresh && <Tag>new</Tag>}
        <span className="faint">{g.titles.join(" · ")}</span>
      </div>
      <div className="actions">
        {g.phrase && (
          <button
            type="button"
            className="small primary"
            title={`Adds “${g.phrase}” to your title words`}
            onClick={() => act(g, "add")}
          >
            Add
          </button>
        )}
        <button
          type="button"
          className="small"
          title="Stops showing this group"
          onClick={() => act(g, "skip")}
        >
          Not mine
        </button>
      </div>
    </div>
  );
}

/** A tier's groups: those of three roles or more, the rest behind "show all". */
function Tier({
  groups,
  act,
}: {
  groups: TitleGroup[];
  act: (g: TitleGroup, action: "add" | "skip") => void;
}) {
  const [more, setMore] = useState(false);
  const big = groups.filter((g) => g.roles >= 3);
  const shown = more || big.length === 0 ? groups : big;
  return (
    <>
      {shown.map((g) => (
        <Group key={g.key} g={g} act={act} />
      ))}
      {shown.length < groups.length && (
        <button type="button" className="small link" onClick={() => setMore(true)}>
          show all {n(groups.length)} groups ({n(groups.length - shown.length)} of one or two roles)
        </button>
      )}
    </>
  );
}

export function ReviewTitles({ ctx }: { ctx: Ctx }) {
  const [groups, setGroups] = useState<TitleGroup[] | null>(null);
  const [others, setOthers] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/review-titles");
    if (r.ok) setGroups((await r.json()).groups);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (g: TitleGroup, action: "add" | "skip") => {
    // Not mine leaves at once; Add when its roles are scored again.
    if (action === "skip") setGroups((gs) => (gs ?? []).filter((x) => x.key !== g.key));
    const res = await ctx.post("/api/review-titles", { action, key: g.key, phrase: g.phrase });
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    ctx.toast(out.toast);
    if (action === "add") {
      await load();
      await ctx.refetch();
    }
  };
  if (!groups) return null;
  const tier = (t: 1 | 2 | 3) => groups.filter((g) => g.tier === t);
  const roles = groups.reduce((s, g) => s + g.roles, 0);
  const third = tier(3);
  return (
    <main className="queue">
      <section>
        <button type="button" className="link" onClick={() => ctx.page("inbox")}>
          ← Inbox
        </button>
        <SectionHead count={roles} label="Review titles" />
        <p className="muted" style={{ margin: "6px 0 12px", maxWidth: 760 }}>
          Roles in your places whose title names a job but has none of your title words, grouped. Add puts the
          phrase in your title words (as in Settings): its roles fit from now and come to the Inbox. Not mine
          stops showing a group; its roles stay open, and search still finds them.
        </p>
        {groups.length === 0 && (
          <div className="empty">Nothing to review: every title here has your words.</div>
        )}
        {tier(1).length > 0 && (
          <>
            <div className="label" style={{ margin: "14px 0 4px" }}>
              Close to your words · {plural(tier(1).length, "group")}
            </div>
            <Tier groups={tier(1)} act={act} />
          </>
        )}
        {tier(2).length > 0 && (
          <>
            <div className="label" style={{ margin: "14px 0 4px" }}>
              Other jobs that build · {plural(tier(2).length, "group")}
            </div>
            <Tier groups={tier(2)} act={act} />
          </>
        )}
        {third.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="collapsed"
              aria-expanded={others}
              onClick={() => setOthers(!others)}
            >
              <span>
                Other jobs: manager, analyst, consultant, director … · {plural(third.length, "group")} ·{" "}
                {plural(
                  third.reduce((s, g) => s + g.roles, 0),
                  "role",
                )}
              </span>
              <span>{others ? "▾" : "▸"}</span>
            </button>
            {others && <Tier groups={third} act={act} />}
          </div>
        )}
      </section>
    </main>
  );
}

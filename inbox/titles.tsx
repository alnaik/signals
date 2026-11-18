// Review titles: the Inbox's line, and the page it opens (#/titles).
import { useCallback, useEffect, useState } from "react";
import { roleHref } from "../board/format.ts";
import { SectionHead } from "../board/Queue.tsx";
import type { Ctx } from "../board/slots.ts";
import { ModeBadge, Tag } from "../board/ui.tsx";
import type { TitleGroup, TitleRole, TitleWord } from "./titles.ts";

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

type Act = (g: TitleGroup, action: "add" | "skip", phrase?: string) => void;

/** An opened group's roles, newest first; `tick` reloads them (an Add took some out). */
function GroupRoles({ g, tick, act }: { g: TitleGroup; tick: number; act: Act }) {
  const [got, setGot] = useState<{ roles: TitleRole[]; total: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the trigger
  useEffect(() => {
    fetch(`/api/review-titles/roles?key=${encodeURIComponent(g.key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setGot)
      .catch(() => {});
  }, [g.key, tick]);
  if (!got)
    return (
      <div className="faint" style={{ padding: "6px 0 8px 16px" }}>
        reading…
      </div>
    );
  return (
    <div style={{ paddingLeft: 16, paddingBottom: 8 }}>
      {got.roles.map((r) => (
        <div
          key={r.id}
          className="row quiet"
          style={{
            gridTemplateColumns: "minmax(0,1fr) auto",
            borderTop: "1px solid var(--line)",
            borderBottom: 0,
            cursor: "default",
          }}
        >
          <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
            <a
              href={roleHref(r.url)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 15, fontWeight: 500 }}
            >
              {r.title}
            </a>
            <span className="muted">{r.company}</span>
            <span className="muted" title={r.location || undefined}>
              {r.place || (r.mode && r.mode !== "unknown" ? "" : r.location || "location unknown")}
            </span>
            <ModeBadge mode={r.mode} />
          </div>
          <div className="actions">
            <button
              type="button"
              className="small"
              title={`Adds “${r.title}” to your title words: this role, and any role with this title, fits from now`}
              onClick={() => act(g, "add", r.title)}
            >
              Add
            </button>
          </div>
        </div>
      ))}
      {got.total > got.roles.length && (
        <div className="faint" style={{ padding: "6px 0" }}>
          {n(got.roles.length)} of {n(got.total)} shown
        </div>
      )}
    </div>
  );
}

/** A group is the row; its roles open behind a click, as a company's do in the Inbox. */
function Group({ g, tick, act }: { g: TitleGroup; tick: number; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <div
        className="row quiet"
        style={{ gridTemplateColumns: "minmax(0,1fr) auto", borderBottom: 0 }}
        onClick={() => setOpen(!open)}
      >
        <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
          <span style={{ fontSize: 15, fontWeight: 500 }}>
            {g.phrase || `${g.like}, its words in another order`}
          </span>
          <span className="muted">
            {plural(g.roles, "role")} {open ? "▾" : "▸"}
          </span>
          {g.like && g.phrase && <span className="muted">like your {g.like}</span>}
          {g.fresh && <Tag>new</Tag>}
          <span className="faint">{g.titles.join(" · ")}</span>
        </div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
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
      {open && <GroupRoles g={g} tick={tick} act={act} />}
    </div>
  );
}

/** A tier's groups: those of three roles or more, the rest behind "show all". */
function Tier({ groups, tick, act }: { groups: TitleGroup[]; tick: number; act: Act }) {
  const [more, setMore] = useState(false);
  const big = groups.filter((g) => g.roles >= 3);
  const shown = more || big.length === 0 ? groups : big;
  return (
    <>
      {shown.map((g) => (
        <Group key={g.key} g={g} tick={tick} act={act} />
      ))}
      {shown.length < groups.length && (
        <button type="button" className="small link" onClick={() => setMore(true)}>
          show all {n(groups.length)} groups ({n(groups.length - shown.length)} of one or two roles)
        </button>
      )}
    </>
  );
}

const WORDS_SHOWN = 10;

/**
 * Your title words, most Inbox roles first, each with its record. Drop takes one out of them; it
 * stays here, dropped, with Add back, until you leave the page.
 */
function Words({ words, ctx, reload }: { words: TitleWord[]; ctx: Ctx; reload: () => Promise<void> }) {
  const [more, setMore] = useState(false);
  const [dropped, setDropped] = useState<string[]>([]);
  const post = async (action: "drop" | "add", word: string) => {
    const res = await ctx.post("/api/review-titles", { action, key: "", phrase: word });
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    ctx.toast(out.toast);
    if (res.ok) setDropped((ds) => (action === "drop" ? [...ds, word] : ds.filter((d) => d !== word)));
    await reload();
    await ctx.refetch();
  };
  const shown = more ? words : words.slice(0, WORDS_SHOWN);
  const row = (word: string, line: string, button: React.ReactNode, faint = false) => (
    <div
      key={word}
      className="row quiet"
      style={{ gridTemplateColumns: "minmax(0,1fr) auto", cursor: "default" }}
    >
      <div className="l1" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline" }}>
        <span className={faint ? "faint" : undefined} style={{ fontSize: 15, fontWeight: 500 }}>
          {word}
        </span>
        <span className="muted">{line}</span>
      </div>
      <div className="actions">{button}</div>
    </div>
  );
  return (
    <>
      <div className="label" style={{ margin: "14px 0 4px" }}>
        Your title words · {n(words.length)}
      </div>
      {dropped.map((w) =>
        row(
          w,
          "dropped",
          <button
            type="button"
            className="small"
            title={`Puts “${w}” back in your title words`}
            onClick={() => post("add", w)}
          >
            Add back
          </button>,
          true,
        ),
      )}
      {shown.map((w) =>
        row(
          w.word,
          `${n(w.inbox)} in the Inbox · ${n(w.applied)} applied · ${n(w.dismissed)} dismissed`,
          <button
            type="button"
            className="small"
            title={`Takes “${w.word}” out of your title words: its roles leave the Inbox, unless another word of yours matches them. Roles you applied to or dismissed stay as they are.`}
            onClick={() => post("drop", w.word)}
          >
            Drop
          </button>,
        ),
      )}
      {shown.length < words.length && (
        <button type="button" className="small link" onClick={() => setMore(true)}>
          show all {n(words.length)} words
        </button>
      )}
    </>
  );
}

export function ReviewTitles({ ctx }: { ctx: Ctx }) {
  const [groups, setGroups] = useState<TitleGroup[] | null>(null);
  const [words, setWords] = useState<TitleWord[]>([]);
  const [others, setOthers] = useState(false);
  const [tick, setTick] = useState(0); // an Add: open groups read their roles again
  const load = useCallback(async () => {
    const r = await fetch("/api/review-titles");
    if (!r.ok) return;
    const got = await r.json();
    setGroups(got.groups);
    setWords(got.words);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // `phrase`: one role's exact title, its own Add; else the group's phrase.
  const act: Act = async (g, action, phrase = g.phrase) => {
    // Not mine leaves at once; Add when its roles are scored again.
    if (action === "skip") setGroups((gs) => (gs ?? []).filter((x) => x.key !== g.key));
    const res = await ctx.post("/api/review-titles", { action, key: g.key, phrase });
    const out = await res.json().catch(() => ({ toast: "Something went wrong" }));
    ctx.toast(out.toast);
    if (action === "add") {
      await load();
      setTick((t) => t + 1);
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
          stops showing a group; its roles stay open, and search still finds them. Drop takes one of your
          title words out: its roles leave the Inbox and aren't shown here, unless another word of yours
          matches them.
        </p>
        {words.length > 0 && <Words words={words} ctx={ctx} reload={load} />}
        {groups.length === 0 && (
          <div className="empty">Nothing to review: every title here has your words.</div>
        )}
        {tier(1).length > 0 && (
          <>
            <div className="label" style={{ margin: "14px 0 4px" }}>
              Close to your words · {plural(tier(1).length, "group")}
            </div>
            <Tier groups={tier(1)} tick={tick} act={act} />
          </>
        )}
        {tier(2).length > 0 && (
          <>
            <div className="label" style={{ margin: "14px 0 4px" }}>
              Other jobs that build · {plural(tier(2).length, "group")}
            </div>
            <Tier groups={tier(2)} tick={tick} act={act} />
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
            {others && <Tier groups={third} tick={tick} act={act} />}
          </div>
        )}
      </section>
    </main>
  );
}

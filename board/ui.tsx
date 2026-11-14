import { useEffect, useState } from "react";
import { sentence } from "./format.ts";
import type { Ctx } from "./slots.ts";

export type Mark = "ink" | "out" | "off" | "sig" | "red";

export function markFor(state: string): Mark {
  if (state === "person found" || state === "replied" || state === "apply" || state === "new") return "sig";
  if (
    state.startsWith("researching") ||
    state.startsWith("closed") ||
    state === "gone" ||
    state === "dismissed" ||
    state === "no person found" ||
    state === "researched"
  )
    return "out";
  return "ink";
}

export function State({ state }: { state: string }) {
  return (
    <span className={`state${markFor(state) === "out" ? " quiet" : ""}`}>
      <span className={`sq ${markFor(state)}`} />
      {sentence(state)}
    </span>
  );
}

export function Tag({ children }: { children: string }) {
  return <span className="tag">{children}</span>;
}

/** Remote, hybrid or on-site, when the posting says; nothing when it doesn't. */
export function ModeBadge({ mode }: { mode?: string }) {
  if (!mode || mode === "unknown") return null;
  return <Tag>{mode === "onsite" ? "on-site" : mode}</Tag>;
}

export function Copy({
  text,
  onCopied,
  label = "Copy",
}: {
  text: string;
  onCopied?: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="small"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text);
        onCopied?.();
      }}
    >
      {label}
    </button>
  );
}

/** A role's text from its board, shown on expand. Boards send HTML (some of it entity-encoded): shown as text. */
export function RoleText({ text }: { text: string }) {
  let t = text;
  for (let i = 0; i < 2 && /<\w|&#?\w+;/.test(t); i++)
    t = new DOMParser().parseFromString(t, "text/html").body.textContent ?? "";
  return (
    <div
      className="muted"
      style={{ whiteSpace: "pre-wrap", fontSize: 13, maxHeight: 320, overflow: "auto", padding: "6px 0" }}
    >
      {t.trim()}
    </div>
  );
}

type Hint = { waiting: number; watched: number; watchedNames: string[]; watchedFit: number; inbox: number };
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * An empty Inbox or Threads screen: what is going on (companies still waiting for their board,
 * where the companies you added are) and the next step, as a link.
 */
export function EmptyHint({ ctx, where }: { ctx: Ctx; where: "inbox" | "threads" }) {
  const [h, setH] = useState<Hint | null>(null);
  useEffect(() => {
    fetch("/api/inbox/empty")
      .then((r) => r.json())
      .then(setH)
      .catch(() => {});
  }, []);
  const go = (page: string, label: string) => (
    <button type="button" className="link" onClick={() => ctx.page(page)}>
      {label}
    </button>
  );
  const names = h?.watchedNames.join(", ") + (h && h.watched > h.watchedNames.length ? "…" : "");
  return (
    <div className="empty" style={{ paddingLeft: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {where === "threads" ? (
        <span>No threads yet. A thread starts when you Apply to a role or press Work on a company.</span>
      ) : (
        <span>Nothing new in the Inbox yet.</span>
      )}
      {h && h.waiting > 0 && (
        <span>
          Still reading:{" "}
          {h.waiting === 1 ? "1 company is" : `${plural(h.waiting, "company", "companies")} are`} waiting for{" "}
          {h.waiting === 1 ? "its job board" : "their job boards"} to be found. Roles that fit come in as each
          one is read.
        </span>
      )}
      {where === "threads" && h && h.inbox > 0 ? (
        <span>
          Your Inbox has {plural(h.inbox, "company", "companies")} with roles that fit:{" "}
          {go("inbox", "open the Inbox")}.
        </span>
      ) : h && h.watched > 0 ? (
        <span>
          The {plural(h.watched, "company", "companies")} you added ({names}) {h.watched === 1 ? "is" : "are"}{" "}
          on your Watchlist with {plural(h.watchedFit, "role")} that fit you; new ones show in the Inbox as
          they're posted. {go("watchlist", "Open the Watchlist")}.
        </span>
      ) : null}
      <span>More companies come from your sources: {go("sources", "connect one on Sources")}.</span>
    </div>
  );
}

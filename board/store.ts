// Board state. Rows come from /api/board; the order is frozen while a drawer is open, so
// nothing reorders under you. It re-sorts on close or decision.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Detail, Summary } from "../core/derive.ts";
import type { AgentState } from "../core/state.ts";

export type BoardData = {
  now: string;
  threads: Summary[];
  inbox: number;
  agents: ({ key: string; name: string } & AgentState)[];
};

export type Layout = { open: string[]; closed: string[]; applied: string[]; dropped: string[] };

/** One list: companies needing you on top, then by last activity. Closed, applied and dismissed ones apart. */
export function layoutOf(threads: Summary[]): Layout {
  const sorted = [...threads].sort(
    (a, b) => Number(b.needsYou) - Number(a.needsYou) || b.lastTs.localeCompare(a.lastTs),
  );
  return {
    open: sorted.filter((t) => t.status !== "closed" && !t.finished && !t.dropped).map((t) => t.id),
    closed: sorted.filter((t) => t.status === "closed").map((t) => t.id),
    applied: sorted.filter((t) => t.finished).map((t) => t.id),
    dropped: sorted.filter((t) => t.dropped).map((t) => t.id),
  };
}

export function useBoard() {
  const [data, setData] = useState<BoardData | null>(null);
  const [rows, setRows] = useState<Map<string, Summary>>(new Map());
  const [layout, setLayout] = useState<Layout>({ open: [], closed: [], applied: [], dropped: [] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [updated, setUpdated] = useState(false);
  const [live, setLive] = useState(false);
  const openRef = useRef<string | null>(null);
  openRef.current = openId;

  const relayout = useCallback((m: Map<string, Summary>) => setLayout(layoutOf([...m.values()])), []);

  const load = useCallback(
    async (id: string | null, relayoutNow: boolean) => {
      const res = await fetch("/api/board");
      if (!res.ok) return;
      const d: BoardData = await res.json();
      const m = new Map(d.threads.map((t) => [t.id, t]));
      setData(d);
      setRows(m);
      if (!openRef.current || relayoutNow) relayout(m);
      const target = id ?? openRef.current;
      if (openRef.current && openRef.current === target) {
        const r = await fetch(`/api/threads/${target}`);
        if (r.ok) {
          setDetail(await r.json());
          if (id) setUpdated(true);
        }
      }
    },
    [relayout],
  );

  const refetchAll = useCallback((relayoutNow = false) => load(null, relayoutNow), [load]);
  // A change in the Inbox (every 2 s at most while a read runs) changes only its count up here:
  // the threads come with their own events.
  const refetchInbox = useCallback(async () => {
    const r = await fetch("/api/inbox/count").catch(() => null);
    if (!r?.ok) return;
    const { inbox } = (await r.json()) as { inbox: number };
    setData((d) => (d && d.inbox !== inbox ? { ...d, inbox } : d));
  }, []);
  const refetchThread = useCallback((id: string) => load(id, false), [load]);

  const open = useCallback(
    async (id: string | null) => {
      setOpenId(id);
      setUpdated(false);
      if (!id) {
        setDetail(null);
        relayout(rows);
        return;
      }
      const r = await fetch(`/api/threads/${id}`);
      setDetail(r.ok ? await r.json() : null);
    },
    [rows, relayout],
  );

  useEffect(() => {
    refetchAll();
  }, [refetchAll]);

  const store = useMemo(
    () => ({ refetchAll, refetchThread, refetchInbox, setLive }),
    [refetchAll, refetchThread, refetchInbox],
  );

  return { data, rows, layout, openId, detail, updated, live, open, store, relayout, setLayout };
}

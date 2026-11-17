// Extension points. Features add UI by default-exporting a BoardFeature from
// `<feature>/board.tsx`; the core board never imports a feature by name.
import type { ReactNode } from "react";
import type { Detail } from "../core/derive.ts";
import { features } from "./slots.gen.ts";

export type Ctx = {
  toast: (msg: string) => void;
  open: (id: string | null) => void;
  next: () => void; // advance the drawer after a decision
  page: (key: string | null, params?: Record<string, string>) => void;
  params: (params: Record<string, string>) => void; // the open page's, in the address (#/inbox?q=…); the thread stays open
  refetch: (id?: string) => Promise<void>;
  post: (url: string, body: unknown) => Promise<Response>;
};

export type Fold = {
  key: string;
  label: string;
  order: number;
  summary: (d: Detail) => string | null; // null hides the fold
  render: (d: Detail, ctx: Ctx) => ReactNode;
};

export type Store = {
  refetchAll: (relayoutNow?: boolean) => Promise<void>;
  refetchThread: (id: string) => Promise<void>;
  refetchInbox: () => Promise<void>; // the Inbox's count alone
  setLive: (v: boolean) => void;
};

export type BoardFeature = {
  name: string;
  order?: number;
  topBar?: (ctx: Ctx) => ReactNode;
  rail?: (ctx: Ctx) => ReactNode; // a block in the Threads screen's right-hand column
  drawerSections?: (d: Detail, ctx: Ctx) => ReactNode;
  folds?: Fold[];
  footer?: (d: Detail, ctx: Ctx) => ReactNode;
  pages?: Record<string, (ctx: Ctx, params: Record<string, string>) => ReactNode>;
  connect?: (store: Store) => () => void;
  gate?: (ctx: Ctx) => ReactNode | null; // shown instead of the board when non-null (first-run setup)
  margin?: (ctx: Ctx) => ReactNode; // beside the frame, on every screen of the board (not first run)
};

export const registry: BoardFeature[] = [...features].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

// Past applications become closed threads with their history: the posting, the application
// as `sent`, and a close with the recorded outcome. They don't join the watchlist; choosing
// a new role at the company opens the thread again, history intact.
import { createHash } from "node:crypto";
import * as index from "../core/index-db.ts";
import { append, exists, read, threadId } from "../core/log.ts";
import { namesNoCompany } from "../intake/leads.ts";
import { readSourceState, writeSourceState } from "../signals/state.ts";

export type Past = {
  company: string;
  role?: string;
  url?: string;
  domain?: string;
  date?: string; // ISO date applied
  status?: string; // rejected · no response · interview · offer …
  notes?: string;
  source: string; // notebook · gmail · takeout
};

export function closeReason(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (/offer|hired|accepted/.test(s)) return "hired";
  if (/reject|declin|not (moving|selected)|unsuccessful/.test(s)) return "rejected";
  if (/interview|screen|onsite/.test(s)) return "interviewed, then closed";
  if (/withdr/.test(s)) return "withdrew";
  return s ? `past: ${s}` : "no response";
}

async function domainFor(p: Past): Promise<string | null> {
  for (const c of [p.domain, p.url]) {
    if (!c) continue;
    try {
      if (!namesNoCompany(c)) return threadId(c);
    } catch {}
  }
  // A company name only: the free company directory (intake/resolve.ts), when present.
  const mod = (await import("../intake/resolve.ts" as string).catch(() => null)) as {
    resolveCompany?: (n: string) => Promise<string | null>;
  } | null;
  return (await mod?.resolveCompany?.(p.company)) ?? null;
}

export type ImportResult = "imported" | "attached" | "duplicate" | "unresolved";

export async function importPast(p: Past): Promise<{ result: ImportResult; id?: string }> {
  const key = createHash("sha256")
    .update(`${p.company.toLowerCase()}|${(p.role ?? "").toLowerCase()}|${p.date ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const seen = readSourceState<string[]>("past-applications", []);
  if (seen.includes(key)) return { result: "duplicate" };
  const id = await domainFor(p);
  if (!id) return { result: "unresolved" };
  const ts = p.date ? new Date(p.date).toISOString() : undefined;
  const before = exists(id) ? read(id) : [];
  const open = before.length > 0;
  if (open) {
    // A thread already exists: keep it as it is and add the history as a note.
    append(id, {
      actor: "import",
      kind: "note",
      data: {
        event: "past_application",
        role: p.role,
        status: p.status,
        date: p.date,
        notes: p.notes,
        source: p.source,
      },
    });
  } else {
    append(id, {
      actor: "import",
      kind: "signal",
      ...(ts ? { ts } : {}),
      data: {
        company: p.company,
        source_tag: "past application",
        kind: "posting",
        ...(p.role ? { title: p.role } : {}),
      },
      ...(p.url ? { source: { type: "page" as const, url: p.url, fetched_at: ts } } : {}),
    });
    append(id, {
      actor: "import",
      kind: "sent",
      ...(ts ? { ts } : {}),
      data: { channel: "application", role: p.role, source: p.source },
    });
    append(id, {
      actor: "import",
      kind: "decision",
      ...(ts ? { ts } : {}),
      data: {
        action: "close",
        reason: closeReason(p.status),
        ...(p.notes ? { text: p.notes } : {}),
        imported: true,
      },
    });
  }
  writeSourceState("past-applications", [...seen, key]);
  index.reindex(id);
  return { result: open ? "attached" : "imported", id };
}

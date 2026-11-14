// Reply detection: mail from a thread's contacts after you marked it sent becomes a
// `reply` entry, which makes the thread read "replied". Auto-replies are ignored.
import * as index from "../../core/index-db.ts";
import { append, read } from "../../core/log.ts";
import { isConnected, search } from "../../gmail/client.ts";
import type { Source } from "../../intake/types.ts";

type Watch = { id: string; emails: string[]; since: string; seen: Set<string> };

export function waitingThreads(): Watch[] {
  const out: Watch[] = [];
  for (const s of index.all().filter((x) => x.status === "sent" || x.status === "replied")) {
    const log = read(s.id);
    const sent = log.filter((e) => e.kind === "decision" && e.data.action === "mark_sent").at(-1);
    if (!sent) continue;
    const emails = new Set<string>();
    for (const e of log) {
      if (e.kind !== "contact") continue;
      for (const c of (e.data.channels ?? []) as { channel: string; value: string }[]) {
        if (c.channel === "email") emails.add(c.value.toLowerCase());
      }
    }
    const seen = new Set(
      log.filter((e) => e.kind === "reply" && e.data.message_id).map((e) => String(e.data.message_id)),
    );
    if (emails.size) out.push({ id: s.id, emails: [...emails], since: sent.ts, seen });
  }
  return out;
}

const gmailReplies: Source = {
  key: "gmail",
  name: "Gmail",
  schedule: "every_6h",
  connected: isConnected,
  fetch: async () => {
    const watches = waitingThreads();
    if (!watches.length) return [];
    const after = new Date(Math.min(...watches.map((w) => Date.parse(w.since))));
    const messages = await search({ from: watches.flatMap((w) => w.emails), after, max: 100 });
    for (const m of messages.filter((x) => !x.autoReply)) {
      for (const w of watches) {
        if (!w.emails.includes(m.from) || m.date < w.since || w.seen.has(m.id)) continue;
        w.seen.add(m.id);
        append(w.id, {
          actor: "gmail",
          kind: "reply",
          data: {
            channel: "email",
            from: m.from,
            subject: m.subject,
            text: m.snippet,
            message_id: m.id,
            at: m.date,
          },
        });
        index.reindex(w.id);
      }
    }
    return [];
  },
};

export default gmailReplies;

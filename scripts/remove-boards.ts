// Remove boards a company's job board has replaced (a careers page the model read, once its
// Greenhouse or Ashby board has had its first read), with their roles and role text, as
// intake/repair.ts removeBoard does. A dry run unless --apply. Nothing is removed when any board
// asked for has a role applied to or dismissed, is being read now, or is its company's only board
// read so far. Back up first: sqlite3 <data>/jobsignal.db ".backup <file>".
// Usage: bun scripts/remove-boards.ts 788 789 [--apply]
import { markChanged, open, tx } from "../core/db.ts";
import { dataDir } from "../core/paths.ts";

const apply = process.argv.includes("--apply");
const ids = process.argv.slice(2).filter((a) => a !== "--apply");
if (!ids.length || ids.some((a) => !/^\d+$/.test(a))) {
  console.error("Usage: bun scripts/remove-boards.ts <board id>... [--apply]");
  process.exit(2);
}
console.log(`${apply ? "Removing" : "Dry run (add --apply to remove)"} · ${dataDir()}`);
const d = open();
const now = new Date().toISOString();
type Row = {
  id: number;
  company_id: number;
  name: string;
  provider: string;
  url: string;
  lease_until: string | null;
};
let refused = false;
for (const id of ids.map(Number)) {
  const b = d
    .query(
      "SELECT b.id, b.company_id, c.name, b.provider, b.url, b.lease_until FROM boards b JOIN companies c ON c.id = b.company_id WHERE b.id = ?",
    )
    .get(id) as Row | null;
  if (!b) {
    console.log(`board ${id}: not found`);
    refused = true;
    continue;
  }
  const states = d
    .query("SELECT state, count(*) AS n FROM roles WHERE board_id = ? GROUP BY state")
    .all(id) as { state: string; n: number }[];
  const texts = (
    d
      .query("SELECT count(*) AS n FROM role_text WHERE role_id IN (SELECT id FROM roles WHERE board_id = ?)")
      .get(id) as {
      n: number;
    }
  ).n;
  const others = d
    .query(
      "SELECT id, provider, url, role_count FROM boards WHERE company_id = ? AND id <> ? AND status = 'ok' AND last_read_at IS NOT NULL",
    )
    .all(b.company_id, id) as { id: number; provider: string; url: string; role_count: number | null }[];
  const why = [
    ...states.filter((s) => s.state === "applied" || s.state === "dismissed").map((s) => `${s.n} ${s.state}`),
    ...(b.lease_until && b.lease_until > now ? ["being read now"] : []),
    ...(others.length ? [] : ["its company has no other board read"]),
  ];
  console.log(
    `board ${id} · ${b.name} (#${b.company_id}) · ${b.provider} ${b.url} · roles ${
      states.map((s) => `${s.n} ${s.state}`).join(", ") || "none"
    } · role text ${texts} · kept: ${others.map((o) => `#${o.id} ${o.provider} ${o.url} (${o.role_count ?? "?"} roles)`).join(", ") || "none"}${
      why.length ? ` · REFUSED: ${why.join(", ")}` : ""
    }`,
  );
  if (why.length) refused = true;
}
if (refused) {
  console.log("Nothing removed.");
  process.exit(1);
}
if (apply) {
  tx(() => {
    for (const id of ids.map(Number)) {
      d.query("DELETE FROM role_text WHERE role_id IN (SELECT id FROM roles WHERE board_id = ?)").run(id);
      d.query("DELETE FROM roles WHERE board_id = ?").run(id);
      d.query("DELETE FROM boards WHERE id = ?").run(id);
    }
    markChanged();
  });
  console.log(`Removed ${ids.length} board${ids.length > 1 ? "s" : ""}.`);
}

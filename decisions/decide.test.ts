import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import * as index from "../core/index-db.ts";
import { append, read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { decide } from "./decide.ts";

const data = tempData();
afterAll(data.cleanup);

const URL = "https://jobs.lever.co/a/1";
function thread(id: string) {
  append(id, {
    actor: "ats",
    kind: "signal",
    data: { company: id, kind: "posting", title: "Backend Engineer" },
    source: { type: "page", url: URL },
  });
  append(id, { actor: "board", kind: "decision", data: { action: "apply", url: URL } });
  index.reindex(id);
}
const ok = (r: ReturnType<typeof decide>) => {
  if (!r.ok) throw new Error(r.toast);
  return r;
};

beforeEach(() => {
  index.close();
  rmSync(paths.threads(), { recursive: true, force: true });
  rmSync(paths.index(), { force: true });
});

test("Done marks a role applied; Dismiss dismisses it; both name the role", () => {
  thread("a.dev");
  expect(decide("a.dev", { action: "applied", url: "https://elsewhere/1" }).ok).toBe(false);
  expect(ok(decide("a.dev", { action: "applied", url: URL })).toast).toBe("Applied · Backend Engineer");
  expect(decide("a.dev", { action: "applied", url: URL }).ok).toBe(false);
  expect(index.reindex("a.dev")?.roles[0]?.status).toBe("applied");
  ok(decide("a.dev", { action: "drop", url: URL }));
  expect(index.reindex("a.dev")?.roles[0]?.status).toBe("dismissed");
});

test("a role applied to, then dismissed on the thread is dismissed on its board too (the Watchlist page)", async () => {
  const { open } = await import("../core/db.ts");
  const { upsertCompany } = await import("../intake/companies.ts");
  const { addBoard } = await import("../intake/discover.ts");
  const { applyRead } = await import("../intake/refresh.ts");
  const { chooseRole } = await import("../inbox/choose.ts");
  const id = upsertCompany({ name: "Acme", domain: "acme.dev" });
  const board = addBoard(id, "lever", "https://jobs.lever.co/acme", "test").board!;
  applyRead(board, {
    ok: true,
    jobs: [{ id: "1", title: "Backend Engineer", url: URL, location: "Remote", postedAt: null }],
  });
  const role = open().query("SELECT id FROM roles WHERE url = ?").get(URL) as { id: number };
  const state = () =>
    (open().query("SELECT state FROM roles WHERE id = ?").get(role.id) as { state: string }).state;
  chooseRole(role.id, "apply"); // Apply in the Inbox: the thread holds the role
  expect(state()).toBe("applied");
  // Backed out of the form, then Dismiss on the thread.
  expect(ok(decide("acme.dev", { action: "drop", url: URL }))).toMatchObject({ company: id });
  expect(state()).toBe("dismissed");
  // Chosen again on the thread: applied again.
  ok(decide("acme.dev", { action: "apply", url: URL }));
  expect(state()).toBe("applied");
  // A thread role no board lists changes nothing.
  thread("b.dev");
  expect(ok(decide("b.dev", { action: "drop", url: URL })).company).toBeUndefined();
});

test("work starts researching once; the board can't close a thread", () => {
  thread("a.dev");
  ok(decide("a.dev", { action: "work" }));
  expect(index.reindex("a.dev")?.status).toBe("researching");
  expect(decide("a.dev", { action: "work" }).ok).toBe(false);
  const before = read("a.dev").length;
  expect(decide("a.dev", { action: "close", reason: "wrong stack" })).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(read("a.dev")).toHaveLength(before);
  expect(index.reindex("a.dev")?.status).toBe("researching");
  // A thread closed by the past-applications import still refuses Mark sent.
  append("a.dev", { actor: "import", kind: "decision", data: { action: "close", reason: "rejected" } });
  expect(index.reindex("a.dev")).toMatchObject({ status: "closed", closeReason: "rejected" });
  expect(decide("a.dev", { action: "mark_sent" }).ok).toBe(false);
});

test("Remove takes back one saved person by their contact entry, and says who the person is now", () => {
  thread("a.dev");
  const contact = (actor: string, name: string, email: string) =>
    append("a.dev", {
      actor,
      kind: "contact",
      data: {
        name,
        role: "",
        confidence: "verified",
        channels: [{ channel: "email", value: email, confidence: "verified" }],
      },
    });
  const lisa = contact("gather", "Lisa Wang", "lisa@a.dev");
  const hillary = contact("lookup", "Hillary Bush", "hillary@a.dev");
  expect(decide("a.dev", { action: "remove_contact", entry: "nope" })).toMatchObject({
    ok: false,
    status: 400,
  });
  const r = ok(decide("a.dev", { action: "remove_contact", entry: hillary.id }));
  expect(r.toast).toBe("Removed Hillary Bush");
  expect(r.entry).toMatchObject({
    kind: "decision",
    data: { action: "remove_contact", entry: hillary.id, name: "Hillary Bush" },
    refs: [hillary.id],
  });
  // Already removed: nothing more to take back.
  expect(decide("a.dev", { action: "remove_contact", entry: hillary.id }).ok).toBe(false);
  expect(index.reindex("a.dev")?.contact?.name).toBe("Lisa Wang");
  // The log keeps every line; only what it derives to changes.
  expect(read("a.dev").filter((e) => e.kind === "contact")).toHaveLength(2);

  const ann = contact("lookup", "Ann Ode", "ann@a.dev");
  expect(ok(decide("a.dev", { action: "remove_contact", entry: lisa.id })).toast).toBe(
    "Removed Lisa Wang · Ann Ode is the person now",
  );
  expect(index.reindex("a.dev")).toMatchObject({ status: "person found", contact: { name: ann.data.name } });
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { tempData } from "../core/testing.ts";
import { startServer } from "./main.ts";

const data = tempData();
let app: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  app = await startServer({ port: 0 });
});
afterAll(() => {
  app.stop();
  data.cleanup();
});

test("the board listens on this Mac only", () => {
  expect(app.server.hostname).toBe("127.0.0.1");
});

test("API requests with a foreign Host are refused (DNS rebinding)", async () => {
  const ok = await fetch(`${app.url}api/board`);
  expect(ok.status).toBe(200);
  const r = await fetch(`${app.url}api/board`, { headers: { host: "evil.example:4317" } });
  expect(r.status).toBe(403);
});

test("writes from another origin are refused (CSRF)", async () => {
  const body = JSON.stringify({ action: "work" });
  const cross = await fetch(`${app.url}api/threads/x.dev/decision`, {
    method: "POST",
    body,
    headers: { origin: "https://evil.example", "content-type": "text/plain" },
  });
  expect(cross.status).toBe(403);
  const fetchSite = await fetch(`${app.url}api/threads/x.dev/decision`, {
    method: "POST",
    body,
    headers: { "sec-fetch-site": "cross-site" },
  });
  expect(fetchSite.status).toBe(403);
  const own = await fetch(`${app.url}api/threads/x.dev/decision`, {
    method: "POST",
    body,
    headers: { origin: app.url.replace(/\/$/, "") },
  });
  expect(own.status).not.toBe(403);
});

test("a role id reaches choose, and a domain param can't climb out", async () => {
  const { upsertCompany } = await import("../intake/companies.ts");
  const { addBoard } = await import("../intake/discover.ts");
  const { applyRead } = await import("../intake/refresh.ts");
  const { open } = await import("../core/db.ts");
  const board = addBoard(
    upsertCompany({ name: "Brindle Robotics", domain: "brindlerobotics.dev" }),
    "ashby",
    "https://jobs.ashbyhq.com/brindle-robotics",
    "test",
  ).board!;
  // Read once before, so the role is news, not the first read's backlog.
  applyRead(board, { ok: true, jobs: [] });
  const again = open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as typeof board;
  applyRead(again, {
    ok: true,
    jobs: [
      {
        id: "9",
        title: "Software Engineer",
        url: "https://jobs.ashbyhq.com/brindle-robotics/9",
        location: "",
        postedAt: null,
      },
    ],
  });
  const { id } = open().query("SELECT id FROM roles").get() as { id: number };
  const own = { origin: app.url.replace(/\/$/, "") };
  const r = await fetch(`${app.url}api/roles/${id}`, {
    method: "POST",
    body: JSON.stringify({ action: "dismiss" }),
    headers: own,
  });
  expect(r.status).toBe(200);
  expect((await r.json()).toast).toBe("Dismissed · Software Engineer");
  const climb = await fetch(`${app.url}api/threads/..%2F..%2Fme`, { headers: own });
  expect(climb.status).toBe(400);
  expect((await climb.json()).toast).toBe("Not a company id");
});

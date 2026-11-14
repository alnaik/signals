// The board's flows through the real server on a scratch folder: Add, Inbox choose, Apply prepare
// and Work preflight over HTTP, so a guard or route change can't pass the suite while the board
// fails. Only the outside world is mocked: the runner, the browser, Greenhouse.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { setUrlOpener } from "../apply/server.ts";
import { runRunner, setRunner } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { deleteSecret } from "../core/keychain.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { upsertCompany } from "../intake/companies.ts";
import { addBoard } from "../intake/discover.ts";
import { applyRead, type Board } from "../intake/refresh.ts";
import { setProviders } from "../providers/registry.ts";
import { startServer } from "./main.ts";

const data = tempData();
const realFetch = globalThis.fetch;
const claudeBin = process.env.JOBSIGNAL_CLAUDE_BIN;
const opened: string[] = [];
let app: Awaited<ReturnType<typeof startServer>>;

const POSTING = "https://boards.greenhouse.io/quarry/jobs/4410";

beforeAll(async () => {
  setProviders([]); // no brand directory, no paid search
  setRunner(async (mode, companies) =>
    companies.map((c) =>
      mode === "detect"
        ? {
            domain: c.domain,
            ok: true,
            detect: { provider: "lever", careers_url: "https://jobs.lever.co/newco", method: "page" },
          }
        : {
            domain: c.domain,
            ok: true,
            jobs: [
              {
                id: "1",
                title: "Engineer",
                url: "https://jobs.lever.co/newco/1",
                location: "Remote - US",
                postedAt: new Date().toISOString(),
              },
              {
                id: "2",
                title: "Designer",
                url: "https://jobs.lever.co/newco/2",
                location: "Boulder, CO",
                postedAt: new Date().toISOString(),
              },
            ],
          },
    ),
  );
  setUrlOpener((url) => opened.push(url));
  // Greenhouse publishes its questions; the server itself is reached for real.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.hostname === "127.0.0.1") return realFetch(input, init);
    if (u.hostname === "boards-api.greenhouse.io")
      return Response.json({
        questions: [
          { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
        ],
      });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  app = await startServer({ port: 0 });
});
afterAll(() => {
  app.stop();
  globalThis.fetch = realFetch;
  setRunner(runRunner);
  setUrlOpener(null);
  setProviders(null);
  if (claudeBin === undefined) delete process.env.JOBSIGNAL_CLAUDE_BIN;
  else process.env.JOBSIGNAL_CLAUDE_BIN = claudeBin;
  data.cleanup();
});

const api = (path: string, body?: unknown) =>
  fetch(`${app.url}api/${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });

test("Inbox choose, then Apply prepare: the thread holds the role and the form opens", async () => {
  // Quarry's board, read once before: the role is news.
  const board = addBoard(
    upsertCompany({ name: "Quarry", domain: "quarry.dev" }),
    "greenhouse",
    "https://boards.greenhouse.io/quarry",
    "test",
  ).board!;
  applyRead(board, { ok: true, jobs: [] });
  applyRead(open().query("SELECT * FROM boards WHERE id = ?").get(board.id) as Board, {
    ok: true,
    jobs: [{ id: "4410", url: POSTING, title: "Product Engineer", location: "Remote", postedAt: null }],
  });
  const shown = (await (await api("inbox")).json()).companies.find(
    (x: { domain: string }) => x.domain === "quarry.dev",
  );
  expect(shown).toMatchObject({ name: "Quarry", roles: 1 });
  const { roles } = await (await api(`companies/${shown.id}/roles`)).json();
  expect(roles[0]).toMatchObject({ mode: "remote", title: "Product Engineer" });

  const r = await api(`roles/${roles[0].id}`, { action: "apply" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ thread: "quarry.dev", url: POSTING });
  const t = await (await api("threads/quarry.dev")).json();
  expect(t.roles.map((x: { title: string; status: string }) => [x.title, x.status])).toEqual([
    ["Product Engineer", "apply"],
  ]);

  const a = await api("apply/quarry.dev", { url: POSTING });
  expect(a.status).toBe(200);
  expect((await a.json()).toast).toStartWith("Opened the form in your browser, unfilled");
  expect(opened).toEqual(["https://job-boards.greenhouse.io/quarry/jobs/4410"]);
  const files = (await (await api("apply/quarry.dev")).json()).files;
  expect(files[0]).toMatchObject({
    ats: "greenhouse",
    apply_url: "https://job-boards.greenhouse.io/quarry/jobs/4410",
  });
  expect(files[0].questions.map((q: { label: string }) => q.label)).toEqual(["First Name"]);
});

test("Work refuses with no model connected, and the thread doesn't read researching", async () => {
  // A binary that exists, so the refusal is the missing connection's, wherever the suite runs.
  process.env.JOBSIGNAL_CLAUDE_BIN = process.execPath;
  writeFileSync(paths.config(), '[runner]\nmode = "claude-code-api-key"\n');
  deleteSecret("anthropic");
  const r = await api("work/quarry.dev", {});
  expect(r.status).toBe(400);
  expect((await r.json()).toast).toStartWith("Work can't start. No model connected");
  const t = await (await api("threads/quarry.dev")).json();
  expect(t.status).not.toBe("researching");
});

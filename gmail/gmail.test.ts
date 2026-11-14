import { afterAll, afterEach, expect, test } from "bun:test";
import * as index from "../core/index-db.ts";
import { setSecret } from "../core/keychain.ts";
import { append, read } from "../core/log.ts";
import { tempData } from "../core/testing.ts";
import gmailReplies from "../sources/gmail-replies/index.ts";
import { allowedQuery, connect, search } from "./client.ts";

const data = tempData();
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
setSecret("gmail_client_id", "cid");
setSecret("gmail_refresh_token", "rt");

const enc = (s: string) => Buffer.from(s).toString("base64url");
const msg = (
  id: string,
  from: string,
  subject: string,
  extra: { name: string; value: string }[] = [],
  label = "Label_7",
) => ({
  id,
  threadId: `t${id}`,
  snippet: `${subject}…`,
  labelIds: [label],
  internalDate: String(Date.parse("2026-10-23T10:00:00Z")),
  payload: {
    headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, ...extra],
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/plain", body: { data: enc("Thanks! See https://tessera.dev/jobs/4421") } }],
  },
});

function mockGmail(messages: ReturnType<typeof msg>[], seenQueries: string[] = []) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.host === "oauth2.googleapis.com")
      return Response.json({
        access_token: "AT",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      });
    if (url.pathname.endsWith("/labels"))
      return Response.json({ labels: [{ id: "Label_7", name: "Job Signal" }] });
    if (url.pathname.endsWith("/messages")) {
      seenQueries.push(url.searchParams.get("q")!);
      return Response.json({ messages: messages.map((m) => ({ id: m.id })) });
    }
    const id = url.pathname.split("/").at(-1);
    return Response.json(messages.find((m) => m.id === id));
  }) as typeof fetch;
  return seenQueries;
}

test("every query is scoped to the label or known contacts", () => {
  expect(allowedQuery({ label: true })).toBe('label:"Job Signal"');
  expect(allowedQuery({ from: ["maya@tessera.dev", "bad address"] })).toBe("from:(maya@tessera.dev)");
  expect(() => allowedQuery({})).toThrow("unscoped");
  expect(() => allowedQuery({ from: ["x) OR (anything"] })).toThrow("unscoped");
});

test("results outside the scope are dropped even if the API returned them", async () => {
  mockGmail([
    msg("1", "Maya <maya@tessera.dev>", "Re: hello"),
    msg("2", "Bank <alerts@bank.com>", "Statement", [], "INBOX"),
  ]);
  const out = await search({ from: ["maya@tessera.dev"] });
  expect(out.map((m) => m.from)).toEqual(["maya@tessera.dev"]);
});

test("a reply from the contact after Mark sent moves the thread to Talking", async () => {
  append("tessera.dev", { actor: "intake", kind: "signal", data: { company: "Tessera Labs" } });
  append("tessera.dev", { actor: "board", kind: "decision", data: { action: "work" } });
  append("tessera.dev", {
    actor: "worker",
    kind: "contact",
    data: {
      name: "Maya Chen",
      role: "CTO",
      channels: [{ channel: "email", value: "Maya@tessera.dev", confidence: "verified" }],
    },
  });
  append("tessera.dev", { actor: "worker", kind: "note", data: { event: "run_done" } });
  append("tessera.dev", {
    actor: "board",
    kind: "decision",
    data: { action: "mark_sent" },
    ts: "2026-10-22T09:00:00Z",
  });
  index.reindex("tessera.dev");
  const queries = mockGmail([
    msg("9", "Maya Chen <maya@tessera.dev>", "Automatic reply", [
      { name: "Auto-Submitted", value: "auto-replied" },
    ]),
    msg("10", "Maya Chen <maya@tessera.dev>", "Re: your invite teardown"),
  ]);
  await gmailReplies.fetch(null);
  expect(queries[0]).toStartWith("from:(maya@tessera.dev) after:");
  const replies = read("tessera.dev").filter((e) => e.kind === "reply");
  expect(replies.map((r) => r.data.subject)).toEqual(["Re: your invite teardown"]);
  expect(index.get("tessera.dev")?.status).toBe("replied");
  await gmailReplies.fetch(null); // the same message twice adds nothing
  expect(read("tessera.dev").filter((e) => e.kind === "reply").length).toBe(1);
});

test("a sign-in answer with the wrong state is refused, and no token is asked for", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked.push(String(url));
    return realFetch(url, init);
  }) as unknown as typeof fetch;
  const done = connect(async () => {
    await realFetch("http://127.0.0.1:8724/?state=not-the-one&code=stolen");
  });
  await expect(done).rejects.toThrow("Gmail connect: state mismatch");
  expect(asked.filter((u) => !u.startsWith("http://127.0.0.1"))).toEqual([]);
});

import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { deleteSecret, setSecret } from "../core/keychain.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import type { Message } from "../gmail/client.ts";
import { setProviders } from "../providers/registry.ts";
import jobMail, { parseAlert } from "./job-mail/index.ts";

const data = tempData();
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setProviders(null);
});
for (const [k, v] of Object.entries({
  gmail_client_id: "c",
  gmail_refresh_token: "r",
  x_client_id: "x",
  x_refresh_token: "xr",
}))
  setSecret(k, v);

const enc = (s: string) => Buffer.from(s).toString("base64url");
function gmailMessage(id: string, from: string, body: string) {
  return {
    id,
    threadId: id,
    labelIds: ["L1"],
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: "Alert" },
      ],
      mimeType: "text/plain",
      body: { data: enc(body) },
    },
  };
}

function mockApis(gmail: ReturnType<typeof gmailMessage>[], xPosts: Record<string, unknown>[]) {
  const xCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "g", expires_in: 3600 });
    if (url.pathname.endsWith("/oauth2/token")) return Response.json({ access_token: "x", expires_in: 7200 });
    if (url.pathname.endsWith("/labels"))
      return Response.json({ labels: [{ id: "L1", name: "Job Signal" }] });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: gmail.map((m) => ({ id: m.id })) });
    if (url.host === "gmail.googleapis.com")
      return Response.json(gmail.find((m) => url.pathname.endsWith(m.id)));
    if (url.pathname === "/2/tweets") {
      xCalls.push(url.searchParams.get("ids")!);
      return Response.json({ data: xPosts, includes: { users: [{ id: "7", username: "wrenna_builds" }] } });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return xCalls;
}

test("Grok's posts are verified through the X API; ones that don't exist are dropped", async () => {
  const xCalls = mockApis(
    [
      gmailMessage(
        "g1",
        "Grok <noreply@x.ai>",
        "Hiring signals today:\nhttps://x.com/wrenna_builds/status/111\nhttps://x.com/no_such_post_qz/status/222",
      ),
    ],
    [
      {
        id: "111",
        text: "We're hiring at Tallowly https://t.co/x",
        author_id: "7",
        entities: { urls: [{ expanded_url: "https://tallowly.com/jobs" }] },
      },
    ],
  );
  const leads = await jobMail.fetch(null);
  expect(xCalls).toEqual(["111,222"]);
  expect(leads).toEqual([
    expect.objectContaining({
      url: "https://x.com/wrenna_builds/status/111",
      text: "We're hiring at Tallowly https://t.co/x",
      domain: "tallowly.com",
      source_tag: "Grok",
    }),
  ]);
  expect(await jobMail.fetch(null)).toEqual([]); // the same email isn't read twice
});

const ALERT = `Your job alert for product engineer

Senior Product Engineer
Tessera Labs
London, England, United Kingdom
View job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc

Design Engineer
Quarry
Remote
View job: https://www.linkedin.com/comm/jobs/view/4012345679/

---------------------------------------------------------


Platform Engineer, Payments
Larkspur Freight
New York City Metropolitan Area

7 school alumni
View job: https://www.linkedin.com/comm/jobs/view/4038816201/

Backend Engineer
Quillmark, Inc.
New York City Metropolitan Area
Apply with resume & profile
View job: https://www.linkedin.com/comm/jobs/view/4038816257/`;

test("LinkedIn alerts parse into title, company, location and the job link", () => {
  const alerts = parseAlert({ body: ALERT } as Message);
  expect(alerts).toEqual([
    {
      title: "Senior Product Engineer",
      company: "Tessera Labs",
      location: "London, England, United Kingdom",
      url: "https://www.linkedin.com/comm/jobs/view/4012345678",
    },
    {
      title: "Design Engineer",
      company: "Quarry",
      location: "Remote",
      url: "https://www.linkedin.com/comm/jobs/view/4012345679",
    },
    {
      title: "Platform Engineer, Payments",
      company: "Larkspur Freight",
      location: "New York City Metropolitan Area",
      url: "https://www.linkedin.com/comm/jobs/view/4038816201",
    },
    {
      title: "Backend Engineer",
      company: "Quillmark, Inc.",
      location: "New York City Metropolitan Area",
      url: "https://www.linkedin.com/comm/jobs/view/4038816257",
    },
  ]);
});

test("a Grok mail from the spare mailbox while X isn't connected is read again later; an alert isn't", async () => {
  for (const k of ["gmail_refresh_token", "x_refresh_token"]) deleteSecret(k);
  const mail = (from: string, body: string) =>
    Buffer.from(
      [
        `From: ${from}`,
        "Subject: s",
        `Date: ${new Date().toUTCString()}`,
        "Content-Type: text/plain",
        "",
        body,
        "",
      ].join("\r\n"),
    );
  const box: Record<number, Buffer> = {
    7: mail(
      "LinkedIn <jobalerts-noreply@linkedin.com>",
      "Engineer\nAcme\nRemote\nView job: https://www.linkedin.com/jobs/view/1",
    ),
    9: mail("Grok <noreply@x.ai>", "https://x.com/someone/status/123"),
  };
  const fetched: string[] = [];
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (sk) => {
        sk.write("* OK fake ready\r\n");
      },
      data: (sk, d) => {
        for (const line of d.toString().split("\r\n").filter(Boolean)) {
          const [tag, ...rest] = line.split(" ");
          const cmd = rest.join(" ");
          if (/^EXAMINE/.test(cmd)) sk.write("* OK [UIDVALIDITY 42]\r\n");
          if (/^UID SEARCH/.test(cmd)) sk.write("* SEARCH 7 9\r\n");
          const f = cmd.match(/^UID FETCH ([\d,]+)/);
          if (f) {
            fetched.push(f[1]!);
            for (const uid of f[1]!.split(",").map(Number)) {
              sk.write(`* 1 FETCH (UID ${uid} BODY[] {${box[uid]!.length}}\r\n`);
              sk.write(box[uid]!);
              sk.write(")\r\n");
            }
          }
          sk.write(`${tag} OK done\r\n`);
        }
      },
    },
  });
  writeFileSync(
    paths.config(),
    `[source.job-mail]\nimap_host = "127.0.0.1"\nimap_port = ${server.port}\nimap_user = "jobs@example.com"\n`,
  );
  setSecret("job_mail_password", "app-pass");
  try {
    await jobMail.fetch(null);
    expect(jobMail.note).toBe("1 Grok mail wait for X");
    await jobMail.fetch(null);
    expect(fetched).toEqual(["9,7", "9"]); // newest first; the alert never again
  } finally {
    server.stop(true);
    deleteSecret("job_mail_password");
    writeFileSync(paths.config(), "");
    setSecret("gmail_refresh_token", "r");
    setSecret("x_refresh_token", "xr");
  }
});

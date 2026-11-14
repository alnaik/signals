import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseAlert, unforward } from "../sources/job-mail/index.ts";
import { READ_ONLY, readMailbox } from "./imap.ts";
import { parseRaw } from "./mime.ts";

// The build's check that job mail can only ever read: no IMAP command that changes a mailbox
// (flags, moves, copies, deletes, sends) appears in the mail code, and the client's one way to
// send a command allows only these.
const WRITES =
  /\b(STORE|COPY|MOVE|APPEND|EXPUNGE|DELETE|CREATE|RENAME|SUBSCRIBE|UNSUBSCRIBE|SETACL|DELETEACL|SETQUOTA|SETMETADATA|SELECT|IDLE|AUTHENTICATE|STARTTLS|ENABLE)\b/;
const MAIL_CODE = [
  ...readdirSync(import.meta.dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(import.meta.dir, f)),
  path.join(import.meta.dir, "../sources/job-mail/index.ts"),
];

test("the mail code holds no IMAP command but reading ones", () => {
  expect([...READ_ONLY]).toEqual(["CAPABILITY", "LOGIN", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"]);
  for (const f of MAIL_CODE) {
    const code = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)) // comments may name what it never does
      .join("\n");
    expect({ f, hit: code.match(WRITES)?.[0] ?? null }).toEqual({ f, hit: null });
  }
  // One place writes to the server: `send`, which refuses any verb outside READ_ONLY.
  expect(readFileSync(path.join(import.meta.dir, "imap.ts"), "utf8").match(/\.write\(/g)?.length).toBe(1);
});

const FORWARDED = [
  "From: Me <me@example.com>",
  "To: jobs@example.com",
  "Subject: Fwd: Your job alert",
  "Date: Wed, 11 Nov 2026 08:00:00 +0000",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "---------- Forwarded message ---------",
  "From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
  "Date: Tue, 10 Nov 2026",
  "Subject: Product engineer: Tessera Labs",
  "To: <me@example.com>",
  "",
  "Senior Product Engineer",
  "Tessera Labs",
  "London, England, United Kingdom",
  "View job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=3Dabc",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>html copy</p>",
  "--b1--",
  "",
].join("\r\n");

test("a spare mailbox is opened read-only, and a forwarded alert is read as the one inside it", async () => {
  const got: string[] = [];
  const raw = Buffer.from(FORWARDED);
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (s) => {
        s.write("* OK fake ready\r\n");
      },
      data: (s, d) => {
        for (const line of d.toString().split("\r\n").filter(Boolean)) {
          const [tag, ...rest] = line.split(" ");
          const cmd = rest.join(" ");
          got.push(cmd.replace(/^LOGIN .*/, "LOGIN …"));
          if (/^EXAMINE/.test(cmd)) s.write("* OK [UIDVALIDITY 42]\r\n");
          if (/^UID SEARCH/.test(cmd)) s.write("* SEARCH 7 9\r\n");
          if (/^UID FETCH/.test(cmd)) {
            s.write(`* 1 FETCH (UID 9 BODY[]<0> {${raw.length}}\r\n`);
            s.write(raw);
            s.write(")\r\n");
          }
          s.write(`${tag} OK done\r\n`);
        }
      },
    },
  });
  const box = await readMailbox(
    { host: "127.0.0.1", port: server.port, user: "jobs@example.com", password: "app-pass" },
    { since: new Date("2026-11-09T00:00:00Z"), skip: new Set([7]) },
  );
  server.stop(true);
  expect(got).toEqual([
    "LOGIN …",
    'EXAMINE "INBOX"',
    "UID SEARCH SINCE 9-Nov-2026",
    "UID FETCH 9 (UID BODY.PEEK[]<0.200000>)",
    "LOGOUT",
  ]);
  expect(box.uidValidity).toBe("42");
  const m = unforward(parseRaw(box.messages[0]!.raw, "imap:42:9"));
  expect(m.from).toBe("jobalerts-noreply@linkedin.com");
  expect(parseAlert(m)).toEqual([
    {
      title: "Senior Product Engineer",
      company: "Tessera Labs",
      location: "London, England, United Kingdom",
      url: "https://www.linkedin.com/comm/jobs/view/4012345678",
    },
  ]);
});

test("an Apple Mail forward, quoted, gives its sender too; a plain mail stays as it is", () => {
  const m = parseRaw(
    Buffer.from(
      "From: Me <me@example.com>\r\nSubject: Fw\r\n\r\n> Begin forwarded message:\r\n>\r\n> From: Wellfound <jobs@wellfound.com>\r\n> Subject: New roles\r\n>\r\n> Founding Engineer at Quarry\r\n",
    ),
    "x",
  );
  // A blank quoted line right after the marker is skipped before the header block.
  expect(unforward(m).from).toBe("jobs@wellfound.com");
  const plain = parseRaw(Buffer.from("From: Alerts <a@b.com>\r\n\r\nhello\r\n"), "y");
  expect(unforward(plain)).toEqual(plain);
});

test("only the start of each message is asked for, a cut-off one is read as far as it goes, and a huge one is refused", async () => {
  const cut = parseRaw(
    Buffer.from(FORWARDED.slice(0, FORWARDED.indexOf("--b1\r\nContent-Type: text/html"))),
    "c",
  );
  expect(cut.subject).toBe("Fwd: Your job alert");
  expect(cut.body).toContain("Tessera Labs");
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (s) => {
        s.write("* OK fake ready\r\n");
      },
      data: (s, d) => {
        for (const line of d.toString().split("\r\n").filter(Boolean)) {
          const [tag, ...rest] = line.split(" ");
          const cmd = rest.join(" ");
          if (/^UID SEARCH/.test(cmd)) s.write("* SEARCH 9\r\n");
          if (/^UID FETCH/.test(cmd)) s.write("* 1 FETCH (UID 9 BODY[]<0> {50000000}\r\n");
          else s.write(`${tag} OK done\r\n`);
        }
      },
    },
  });
  const read = readMailbox(
    { host: "127.0.0.1", port: server.port, user: "jobs@example.com", password: "app-pass" },
    { since: new Date("2026-11-09T00:00:00Z"), timeoutMs: 3000 },
  );
  await expect(read).rejects.toThrow("too big to read");
  server.stop(true);
});

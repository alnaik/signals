// A read-only IMAP client for a spare mailbox that holds only job mail, opened with an app
// password from the Keychain. It can only read: the mailbox is opened with EXAMINE (read-only:
// the server changes no flag), messages are fetched with BODY.PEEK[] (never marked seen), and
// every command goes through `send`, whose verb must be one of READ_ONLY. There is no code here
// to send, move, flag or delete mail; mail/imap.test.ts fails the build if any other IMAP command
// appears in this folder.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export const READ_ONLY = ["CAPABILITY", "LOGIN", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"] as const;
type Verb = (typeof READ_ONLY)[number];

export type ImapLogin = { host: string; port?: number; user: string; password: string };
export type Raw = { uid: number; raw: Buffer };

// Job mail is small: only the first 200 KB of each message is asked for (a cut-off message is read as
// far as it goes), and a server stating anything over 5 MB is refused rather than held in memory.
const FETCH_BYTES = 200_000;
const MAX_LITERAL = 5_000_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const quote = (s: string) => {
  if (/[\r\n]/.test(s)) throw new Error("A line break can't be sent to the mail server");
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
};

/** A connection error in plain words: the server's name or port is what a person can fix. */
function plainError(err: Error & { code?: string }): Error {
  if (err.code === "ENOTFOUND") return new Error("That mail server name wasn't found; check the spelling");
  if (err.code === "ECONNREFUSED")
    return new Error("The mail server refused the connection; check its name and port");
  return err;
}

/** One connection: lines and literals in, tagged commands out, one at a time. */
class Session {
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private closed: Error | null = null;
  private n = 0;
  constructor(private sock: Socket) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake?.();
    });
    const end = (err?: Error) => {
      this.closed ??= err ?? new Error("The mail server closed the connection");
      this.wake?.();
    };
    sock.on("error", (err) => end(plainError(err)));
    sock.on("close", () => end());
  }

  private async more(): Promise<void> {
    if (this.closed) throw this.closed;
    await new Promise<void>((r) => {
      this.wake = r;
    });
    this.wake = null;
  }

  /** One response line, with any literals it carries ({n} then n bytes) joined into `literals`. */
  async line(): Promise<{ text: string; literals: Buffer[] }> {
    let text = "";
    const literals: Buffer[] = [];
    for (;;) {
      let i = this.buf.indexOf("\r\n");
      while (i < 0) {
        await this.more();
        i = this.buf.indexOf("\r\n");
      }
      const part = this.buf.subarray(0, i).toString("latin1");
      this.buf = this.buf.subarray(i + 2);
      text += part;
      const lit = part.match(/\{(\d+)\}$/);
      if (!lit) return { text, literals };
      const size = Number(lit[1]);
      if (size > MAX_LITERAL) throw new Error("The mail server sent a message too big to read");
      while (this.buf.length < size) await this.more();
      literals.push(Buffer.from(this.buf.subarray(0, size)));
      this.buf = this.buf.subarray(size);
    }
  }

  /** Send one read-only command; its untagged lines, or an error with the server's words. */
  async send(verb: Verb, args = ""): Promise<{ text: string; literals: Buffer[] }[]> {
    if (!READ_ONLY.includes(verb)) throw new Error(`Not a read-only IMAP command: ${verb}`);
    const tag = `js${++this.n}`;
    this.sock.write(`${tag} ${verb}${args ? ` ${args}` : ""}\r\n`);
    const out: { text: string; literals: Buffer[] }[] = [];
    for (;;) {
      const l = await this.line();
      if (l.text.startsWith(`${tag} `)) {
        if (/^\S+ OK/i.test(l.text)) return out;
        throw new Error(`The mail server said: ${l.text.replace(/^\S+ (NO|BAD)\s*/i, "") || "no"}`);
      }
      out.push(l);
    }
  }

  close(): void {
    this.sock.destroy();
  }
}

async function open(login: ImapLogin, timeoutMs: number): Promise<Session> {
  // Plain TCP only to this Mac's own address (the tests' fake server); everywhere else TLS.
  const local = login.host === "127.0.0.1";
  const sock = local
    ? netConnect({ host: login.host, port: login.port ?? 993 })
    : tlsConnect({ host: login.host, port: login.port ?? 993, servername: login.host });
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error("The mail server took too long")));
  const s = new Session(sock);
  const hello = await s.line();
  if (!/^\* (OK|PREAUTH)/i.test(hello.text)) throw new Error(`The mail server said: ${hello.text}`);
  return s;
}

/**
 * The newest messages since `since` in the mailbox (INBOX by default), at most `max`, each
 * with its UID, read without changing anything on the server. `skip` holds UIDs already read.
 */
export async function readMailbox(
  login: ImapLogin,
  opts: { since: Date; max?: number; mailbox?: string; skip?: Set<number>; timeoutMs?: number },
): Promise<{ uidValidity: string; messages: Raw[] }> {
  const s = await open(login, opts.timeoutMs ?? 30_000);
  try {
    await s.send("LOGIN", `${quote(login.user)} ${quote(login.password)}`);
    const box = await s.send("EXAMINE", quote(opts.mailbox ?? "INBOX"));
    const uidValidity = box.map((l) => l.text.match(/UIDVALIDITY (\d+)/i)?.[1]).find(Boolean) ?? "0";
    const d = opts.since;
    const found = await s.send(
      "UID SEARCH",
      `SINCE ${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`,
    );
    const uids = found
      .flatMap((l) =>
        /^\* SEARCH/i.test(l.text)
          ? l.text
              .replace(/^\* SEARCH/i, "")
              .trim()
              .split(/\s+/)
          : [],
      )
      .map(Number)
      .filter((u) => u > 0 && !opts.skip?.has(u))
      .sort((a, b) => b - a)
      .slice(0, opts.max ?? 30);
    const messages: Raw[] = [];
    if (uids.length) {
      for (const l of await s.send("UID FETCH", `${uids.join(",")} (UID BODY.PEEK[]<0.${FETCH_BYTES}>)`)) {
        const uid = Number(l.text.match(/UID (\d+)/i)?.[1]);
        if (uid && l.literals[0]) messages.push({ uid, raw: l.literals[0] });
      }
    }
    await s.send("LOGOUT").catch(() => {});
    return { uidValidity, messages };
  } finally {
    s.close();
  }
}

/** Can this mailbox be opened read-only with these details? The server's own words when not. */
export async function checkLogin(login: ImapLogin): Promise<string | null> {
  try {
    await readMailbox(login, { since: new Date(), max: 0, timeoutMs: 15_000 });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

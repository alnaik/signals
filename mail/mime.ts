// A mail message as the job-mail parsers read it, from the raw bytes an IMAP server sends:
// headers (folded lines, encoded words), multipart bodies, base64 and quoted-printable, any
// charset the runtime decodes. The plain-text part is preferred, the HTML one turned to text.
import { htmlToText } from "../core/http.ts";
import type { Message } from "../gmail/client.ts";

type Part = { headers: Map<string, string>; body: Buffer };

function split(raw: Buffer): Part {
  let at = raw.indexOf("\r\n\r\n");
  let gap = 4;
  if (at < 0) {
    at = raw.indexOf("\n\n");
    gap = 2;
  }
  const head = (at < 0 ? raw : raw.subarray(0, at)).toString("latin1");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m && !headers.has(m[1]!.toLowerCase())) headers.set(m[1]!.toLowerCase(), m[2]!);
  }
  return { headers, body: at < 0 ? Buffer.alloc(0) : raw.subarray(at + gap) };
}

const param = (value: string, name: string) =>
  value
    .match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"))
    ?.slice(1)
    .find(Boolean);

function decodeText(bytes: Buffer, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function qp(s: string): Buffer {
  const bytes: number[] = [];
  const text = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function transfer(body: Buffer, encoding = ""): Buffer {
  const e = encoding.toLowerCase();
  if (e === "base64") return Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64");
  if (e === "quoted-printable") return qp(body.toString("latin1"));
  return body;
}

/** Encoded words in a header (=?utf-8?B?…?= and =?…?Q?…?=), decoded. */
export function headerText(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) =>
      decodeText(enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : qp(data.replace(/_/g, " ")), cs),
    );
}

/** The text/plain and text/html parts, walking any multipart. */
function texts(p: Part, out: { text: string; html: string }): void {
  const type = p.headers.get("content-type") ?? "text/plain";
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, "boundary");
    if (!boundary) return;
    const body = p.body.toString("latin1");
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      texts(split(Buffer.from(chunk.replace(/^\r?\n/, ""), "latin1")), out);
    }
    return;
  }
  if (/attachment/i.test(p.headers.get("content-disposition") ?? "")) return;
  const isHtml = /^text\/html/i.test(type);
  if (!isHtml && !/^text\/plain/i.test(type)) return;
  const text = decodeText(
    transfer(p.body, p.headers.get("content-transfer-encoding")),
    param(type, "charset"),
  );
  if (isHtml) out.html ||= text;
  else out.text ||= text;
}

/** A raw message as the same Message the Gmail route gives, so one set of parsers reads both. */
export function parseRaw(raw: Buffer, id: string): Message {
  const top = split(raw);
  const h = (k: string) => headerText(top.headers.get(k) ?? "");
  const fromRaw = h("from");
  const out = { text: "", html: "" };
  texts(top, out);
  const body = out.text || (out.html ? htmlToText(out.html) : "");
  const links = [...new Set([...(out.text + out.html).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) => x[0]))];
  const date = Date.parse(h("date"));
  return {
    id,
    threadId: id,
    from: (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim().toLowerCase(),
    fromName: fromRaw
      .replace(/<[^>]+>/, "")
      .replace(/"/g, "")
      .trim(),
    to: h("to"),
    subject: h("subject"),
    date: new Date(Number.isNaN(date) ? Date.now() : date).toISOString(),
    snippet: body.slice(0, 200),
    labels: [],
    autoReply: /auto-replied|auto-generated/i.test(h("auto-submitted")),
    links,
    body: body.slice(0, 20_000),
  };
}

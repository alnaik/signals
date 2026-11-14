// Optional Gmail adapter: your own Google Cloud project, a Desktop OAuth client, scope
// gmail.readonly only. Google can't limit a token to one label, so the limit is enforced
// here: every query is the job label, or mail from contacts already in a thread.
import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "../core/config.ts";
import { getSecret, setSecret } from "../core/keychain.ts";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const PORT = 8724;

export type Message = {
  id: string;
  threadId: string;
  from: string; // address only, lower-case
  fromName: string;
  to: string;
  subject: string;
  date: string; // ISO
  snippet: string;
  labels: string[];
  autoReply: boolean;
  links: string[];
  body: string;
};

export const jobLabel = (): string => String(loadConfig().source.gmail?.label ?? "Job Signal");
export const isConnected = (): boolean =>
  !!getSecret("gmail_client_id") && !!getSecret("gmail_refresh_token");

let access: { token: string; expires: number } | null = null;

async function token(body: Record<string, string>): Promise<void> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getSecret("gmail_client_id")!,
      client_secret: getSecret("gmail_client_secret") ?? "",
      ...body,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    scope?: string;
  };
  if (!res.ok || !json.access_token) throw new Error(`Gmail token: ${json.error ?? res.status}`);
  if (json.scope?.split(" ").some((s) => s.includes("mail.google.com") || s.endsWith("gmail.modify"))) {
    throw new Error("Gmail token has more than read-only scope; reconnect with gmail.readonly only");
  }
  access = { token: json.access_token, expires: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
  if (json.refresh_token) setSecret("gmail_refresh_token", json.refresh_token);
}

async function bearer(): Promise<string> {
  if (access && access.expires > Date.now()) return access.token;
  const refresh = getSecret("gmail_refresh_token");
  if (!refresh) throw new Error("Gmail isn't connected (jobsignal gmail connect)");
  await token({ grant_type: "refresh_token", refresh_token: refresh });
  return access!.token;
}

const CONNECT_WAIT_MS = 5 * 60_000;

export async function connect(
  open: (url: string) => unknown = (url) => Bun.spawn(["open", url]),
): Promise<void> {
  if (!getSecret("gmail_client_id"))
    throw new Error("Store the Desktop client ID first: pbpaste | jobsignal key set gmail_client_id");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const redirect = `http://127.0.0.1:${PORT}`;
  const url = `${AUTH}?${new URLSearchParams({
    client_id: getSecret("gmail_client_id")!,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  })}`;
  const code = await new Promise<string>((resolve, reject) => {
    // Nobody signed in within the wait: the port is let go, so Connect can be pressed again.
    const wait = setTimeout(() => {
      server.stop(true);
      reject(new Error("Gmail connect: no answer from the browser in 5 minutes; try again"));
    }, CONNECT_WAIT_MS);
    const server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        const c = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        // Google comes back to the root with a code or an error; anything else (the browser's
        // /favicon.ico, a stray request) is answered 404 and the sign-in keeps waiting.
        if (u.pathname !== "/" || (!c && !err)) return new Response("Not found", { status: 404 });
        clearTimeout(wait);
        setTimeout(() => server.stop(true), 100);
        if (u.searchParams.get("state") !== state || !c) {
          reject(new Error(`Gmail connect: ${err ?? "state mismatch"}`));
          return new Response("Not connected. Try again.", { status: 400 });
        }
        resolve(c);
        return new Response("Job Signal can now read your job label in Gmail. You can close this tab.");
      },
    });
    open(url);
  });
  await token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${await bearer()}` },
  });
  if (!res.ok) throw new Error(`Gmail ${path.split("/")[1]}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** The only queries allowed: the job label, or messages from known contacts. */
export function allowedQuery(opts: { label?: boolean; from?: string[]; after?: Date }): string {
  const parts: string[] = [];
  if (opts.label) parts.push(`label:"${jobLabel().replace(/"/g, "")}"`);
  const from = (opts.from ?? []).filter((e) => /^[^\s@"()]+@[^\s@"()]+$/.test(e));
  if (from.length) parts.push(`from:(${from.join(" OR ")})`);
  if (!parts.length) throw new Error("Refusing an unscoped Gmail query");
  const scope = parts.length > 1 ? `{${parts.join(" ")}}` : parts[0]!;
  return opts.after ? `${scope} after:${Math.floor(opts.after.getTime() / 1000)}` : scope;
}

type Part = {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
};
const b64 = (s?: string) =>
  s ? Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";

function bodyText(p: Part): { text: string; html: string } {
  let text = "";
  let html = "";
  const walk = (x: Part) => {
    if (x.mimeType === "text/plain") text += b64(x.body?.data);
    else if (x.mimeType === "text/html") html += b64(x.body?.data);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  return { text, html };
}

export function parseMessage(m: {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload: Part;
}): Message {
  const h = (name: string) =>
    m.payload.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const fromRaw = h("From");
  const addr = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim().toLowerCase();
  const { text, html } = bodyText(m.payload);
  const auto =
    /auto-replied|auto-generated/i.test(h("Auto-Submitted")) ||
    /^(auto|out of office|automatic reply|abwesenheit)/i.test(h("Subject")) ||
    !!h("X-Autoreply") ||
    /^(bulk|junk|list)$/i.test(h("Precedence"));
  const links = [...new Set([...(text + html).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) => x[0]))];
  return {
    id: m.id,
    threadId: m.threadId,
    from: addr,
    fromName: fromRaw
      .replace(/<[^>]+>/, "")
      .replace(/"/g, "")
      .trim(),
    to: h("To"),
    subject: h("Subject"),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(h("Date")).toISOString(),
    snippet: m.snippet ?? "",
    labels: m.labelIds ?? [],
    autoReply: auto,
    links,
    body: (text || html.replace(/<[^>]+>/g, " ")).slice(0, 20_000),
  };
}

/** Search within the allowed scope only, and check every result against it again. */
export async function search(opts: {
  label?: boolean;
  from?: string[];
  after?: Date;
  max?: number;
}): Promise<Message[]> {
  const q = allowedQuery(opts);
  const list = await get<{ messages?: { id: string }[] }>("/messages", {
    q,
    maxResults: String(opts.max ?? 50),
  });
  let labelId: string | null = null;
  if (opts.label) {
    const labels = await get<{ labels: { id: string; name: string }[] }>("/labels");
    labelId = labels.labels.find((l) => l.name === jobLabel())?.id ?? null;
  }
  const allowedFrom = new Set((opts.from ?? []).map((f) => f.toLowerCase()));
  const out: Message[] = [];
  for (const { id } of list.messages ?? []) {
    const m = parseMessage(await get(`/messages/${id}`, { format: "full" }));
    const inLabel = !!labelId && m.labels.includes(labelId);
    if (inLabel || allowedFrom.has(m.from)) out.push(m);
  }
  return out;
}

// Official X API v2 client: OAuth 2.0 with PKCE as a native (public) app, tokens in the Keychain.
// Pay-per-use: owned reads (your bookmarks) $0.001 per resource, Posts read $0.005 per resource.
// Every call is recorded in the ledger; set a spend limit on the X developer account too.
import { createHash, randomBytes } from "node:crypto";
import { getSecret, setSecret } from "../core/keychain.ts";
import { canSpend, record } from "../core/ledger.ts";

const API = "https://api.x.com/2";
const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = `${API}/oauth2/token`;
export const REDIRECT_URI = "http://127.0.0.1:8723/callback";
const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];
export const PRICES = { owned_read: 0.001, post_read: 0.005 };

export type Post = {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  username?: string;
  urls: string[]; // expanded links in the post
};

let access: { token: string; expires: number } | null = null;

export function isConnected(): boolean {
  return !!getSecret("x_client_id") && !!getSecret("x_refresh_token");
}

function tokenHeaders(): Record<string, string> {
  const id = getSecret("x_client_id")!;
  const secret = getSecret("x_client_secret");
  const h: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (secret) h.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  return h;
}

async function tokenRequest(body: Record<string, string>): Promise<void> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: tokenHeaders(),
    body: new URLSearchParams({ client_id: getSecret("x_client_id")!, ...body }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) throw new Error(`X token: ${json.error ?? res.status}`);
  access = { token: json.access_token, expires: Date.now() + ((json.expires_in ?? 7200) - 60) * 1000 };
  // Refresh tokens rotate: keep the new one or the next refresh fails.
  if (json.refresh_token) setSecret("x_refresh_token", json.refresh_token);
}

async function accessToken(): Promise<string> {
  if (access && access.expires > Date.now()) return access.token;
  const refresh = getSecret("x_refresh_token");
  if (!refresh) throw new Error("X is not connected (jobsignal x connect)");
  await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  return access!.token;
}

/** One-time connect: opens the browser, catches the callback on 127.0.0.1, stores the refresh token. */
const CONNECT_WAIT_MS = 5 * 60_000;

export async function connect(
  open: (url: string) => unknown = (url) => Bun.spawn(["open", url]),
): Promise<void> {
  if (!getSecret("x_client_id"))
    throw new Error("Store the app's client ID first: pbpaste | jobsignal key set x_client_id");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const url = `${AUTHORIZE}?${new URLSearchParams({
    response_type: "code",
    client_id: getSecret("x_client_id")!,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  const code = await new Promise<string>((resolve, reject) => {
    // Nobody signed in within the wait: the port is let go, so Connect can be pressed again.
    const wait = setTimeout(() => {
      server.stop(true);
      reject(new Error("X connect: no answer from the browser in 5 minutes; try again"));
    }, CONNECT_WAIT_MS);
    const server = Bun.serve({
      port: 8723,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== "/callback") return new Response("Not found", { status: 404 });
        clearTimeout(wait);
        setTimeout(() => server.stop(true), 100);
        if (u.searchParams.get("state") !== state) {
          reject(new Error("X connect: state mismatch"));
          return new Response("State mismatch. Try again.", { status: 400 });
        }
        const c = u.searchParams.get("code");
        if (!c) {
          reject(new Error(`X connect: ${u.searchParams.get("error") ?? "no code"}`));
          return new Response("Not connected.", { status: 400 });
        }
        resolve(c);
        return new Response("Job Signal is connected to X. You can close this tab.");
      },
    });
    open(url);
  });
  // The code expires 30 seconds after it arrives.
  await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

async function get(path: string, params: Record<string, string>) {
  const send = async (p: Record<string, string>) =>
    fetch(`${API}${path}?${new URLSearchParams(p)}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
  let res = await send(params);
  // Field parameters were renamed from tweet.fields to post.fields; accept either.
  if (res.status === 400 && params["post.fields"]) {
    const { "post.fields": f, ...rest } = params;
    res = await send({ ...rest, "tweet.fields": f! });
  }
  if (res.status === 429)
    throw new Error(`X rate limited until ${res.headers.get("x-rate-limit-reset") ?? "later"}`);
  if (!res.ok) throw new Error(`X ${path}: HTTP ${res.status}`);
  return res.json() as Promise<{
    data?: Record<string, unknown>[] | Record<string, unknown>;
    includes?: { users?: { id: string; username: string }[] };
    meta?: { next_token?: string; result_count?: number };
  }>;
}

function toPosts(json: Awaited<ReturnType<typeof get>>): Post[] {
  const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u.username]));
  const data = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
  return data.map((t) => {
    const entities = t.entities as { urls?: { expanded_url?: string; unwound_url?: string }[] } | undefined;
    return {
      id: String(t.id),
      text: String(t.text ?? ""),
      created_at: t.created_at as string | undefined,
      author_id: t.author_id as string | undefined,
      username: users.get(String(t.author_id)),
      urls: (entities?.urls ?? []).map((u) => u.unwound_url ?? u.expanded_url ?? "").filter(Boolean),
    };
  });
}

const FIELDS = {
  "post.fields": "created_at,author_id,entities",
  expansions: "author_id",
  "user.fields": "username",
};

let me: string | null = null;
async function myId(): Promise<string> {
  me ??= String(((await get("/users/me", {})).data as { id: string }).id);
  return me;
}

/**
 * Bookmarks, newest first, stopping at the first one already seen. X bills every bookmark
 * returned, new or not, so the first page is sized to how many are likely new (`firstPage`);
 * later pages are full (100) and only fetched while everything so far was new.
 */
export async function bookmarks(seen: Set<string>, maxPages = 10, firstPage = 100): Promise<Post[]> {
  const out: Post[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    // A full page is $0.10: stop at the monthly cap rather than record it after.
    if (!canSpend(100 * PRICES.owned_read)) break;
    const json = await get(`/users/${await myId()}/bookmarks`, {
      ...FIELDS,
      max_results: String(page === 0 ? Math.min(100, Math.max(5, firstPage)) : 100),
      ...(token ? { pagination_token: token } : {}),
    });
    const posts = toPosts(json);
    record({
      kind: "provider",
      station: "x-bookmarks",
      provider: "x",
      usd: posts.length * PRICES.owned_read,
    });
    for (const p of posts) {
      if (seen.has(p.id)) return out;
      out.push(p);
    }
    token = json.meta?.next_token;
    if (!token) break;
  }
  return out;
}

/** Read posts by id (verification of Grok's results). Up to 100 per call. */
export async function readPosts(ids: string[]): Promise<Post[]> {
  const out: Post[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    // Billed per post returned: past the monthly cap the rest wait for next month.
    if (!canSpend(batch.length * PRICES.post_read)) break;
    const posts = toPosts(await get("/tweets", { ids: batch.join(","), ...FIELDS }));
    record({ kind: "provider", station: "x-verify", provider: "x", usd: posts.length * PRICES.post_read });
    out.push(...posts);
  }
  return out;
}

export function postIdFromUrl(url: string): string | null {
  return url.match(/(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/)?.[1] ?? null;
}

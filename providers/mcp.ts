// Generic MCP adapter: any MCP server's tool becomes a provider capability through
// config.toml, with no code. Example:
//
//   [provider.mcp.brave]
//   command = ["npx", "-y", "@brave/brave-search-mcp-server"]
//   env = { BRAVE_API_KEY = "keychain:brave" }
//   [provider.mcp.brave.search]
//   tool = "brave_web_search"
//   args = { query = "{query}", count = "{n}" }
//   list = "results"          # where the result list is (dotted path; "" = the top level)
//   fields = { url = "url", title = "title", snippet = "description" }
//   cost = 0.003
//
// Stdio servers (`command`) and HTTP servers (`url`) are both supported.
import { loadConfig } from "../core/config.ts";
import { getSecret } from "../core/keychain.ts";
import { failure } from "../core/trace.ts";
import type { Capability, Provider } from "./types.ts";

type ToolMap = {
  tool: string;
  args?: Record<string, unknown>;
  list?: string;
  fields?: Record<string, string>;
  cost?: number;
};
type ServerConfig = {
  label?: string;
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
} & Partial<Record<Capability, ToolMap>>;

const CAPS: Capability[] = ["search", "read", "people", "contact"];

function resolveSecret(v: string): string {
  return v.startsWith("keychain:") ? (getSecret(v.slice(9)) ?? "") : v;
}

export function fill(template: unknown, vars: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const whole = template.match(/^\{(\w+)\}$/);
    if (whole) return vars[whole[1]!];
    return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, vars));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, vars)]));
  }
  return template;
}

export function pick(obj: unknown, dotted: string | undefined): unknown {
  if (!dotted) return obj;
  return dotted.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

/** MCP tool results are content blocks; JSON in a text block is parsed. */
export function toolPayload(result: {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "");
  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

// --- a minimal MCP client (JSON-RPC 2.0) ------------------------------------------
type Rpc = (method: string, params?: unknown) => Promise<unknown>;

async function stdioClient(cfg: ServerConfig): Promise<{ rpc: Rpc; close: () => void }> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = resolveSecret(v);
  const proc = Bun.spawn(cfg.command!, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
  let id = 0;
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            pending.get(msg.id)!(msg);
            pending.delete(msg.id);
          }
        } catch {}
      }
    }
  })();
  const send = (obj: unknown) => {
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
    proc.stdin.flush();
  };
  const rpc: Rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 60_000);
      pending.set(myId, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      });
      send({ jsonrpc: "2.0", id: myId, method, params });
    });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "job-signal", version: "0.1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { rpc, close: () => proc.kill() };
}

async function httpClient(cfg: ServerConfig): Promise<{ rpc: Rpc; close: () => void }> {
  let session: string | null = null;
  let id = 0;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = resolveSecret(v);
  const post = async (body: unknown) => {
    const res = await fetch(cfg.url!, {
      method: "POST",
      headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      return data.length ? JSON.parse(data.at(-1)!) : {};
    }
    return text ? JSON.parse(text) : {};
  };
  const rpc: Rpc = async (method, params) => {
    const msg = await post({ jsonrpc: "2.0", id: ++id, method, params });
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "job-signal", version: "0.1" },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  return { rpc, close: () => {} };
}

export async function callTool(cfg: ServerConfig, tool: string, args: unknown): Promise<unknown> {
  const client = cfg.url ? await httpClient(cfg) : await stdioClient(cfg);
  try {
    const result = (await client.rpc("tools/call", { name: tool, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    if (result.isError) throw new Error(`MCP tool ${tool}: ${JSON.stringify(result.content).slice(0, 200)}`);
    return toolPayload(result);
  } finally {
    client.close();
  }
}

function mapList(payload: unknown, map: ToolMap): Record<string, unknown>[] {
  const list = pick(payload, map.list);
  const rows = Array.isArray(list) ? list : list ? [list] : [];
  return rows.map((row) =>
    map.fields
      ? Object.fromEntries(Object.entries(map.fields).map(([to, from]) => [to, pick(row, from)]))
      : (row as Record<string, unknown>),
  );
}

export function mcpProviders(): Provider[] {
  const servers = (loadConfig().provider.mcp ?? {}) as Record<string, ServerConfig>;
  return Object.entries(servers).map(([name, cfg]) => {
    const p: Provider = { name, label: cfg.label ?? name, cost: {} };
    for (const cap of CAPS) {
      const map = cfg[cap];
      if (!map) continue;
      // A tool with no declared price could spend past the cap unseen: it doesn't run.
      if (typeof map.cost !== "number") {
        failure(
          "provider",
          `mcp ${name} ${cap}`,
          `no cost in config.toml: add [provider.mcp.${name}.${cap}] cost = 0 if it's free`,
        );
        continue;
      }
      p.cost[cap] = map.cost;
      const run = async (vars: Record<string, unknown>) =>
        mapList(await callTool(cfg, map.tool, fill(map.args ?? {}, vars)), map);
      if (cap === "search") {
        p.search = async (query, opts) =>
          (await run({ query, n: opts.n ?? 10, ...opts })).map((r) => ({
            url: String(r.url ?? ""),
            title: String(r.title ?? ""),
            snippet: String(r.snippet ?? ""),
          }));
      } else if (cap === "read") {
        p.read = async (url, opts) => {
          const [r] = await run({ url, ...opts });
          return { url, text: String(r?.text ?? r?.markdown ?? ""), fetched_at: new Date().toISOString() };
        };
      } else if (cap === "people") {
        p.people = async (domain, roles) =>
          (await run({ domain, roles: roles.join(", ") })).map((r) => ({
            name: String(r.name ?? ""),
            role: String(r.role ?? ""),
            profile_urls: ([] as string[]).concat((r.profile_urls as string[]) ?? []),
            source: name,
          }));
      } else if (cap === "contact") {
        p.contact = async (person) =>
          (await run({ ...person })).map((r) => ({
            channel: String(r.channel ?? "email"),
            value: String(r.value ?? ""),
            confidence: (["verified", "pattern"].includes(String(r.confidence))
              ? r.confidence
              : "guessed") as "guessed",
            source: name,
          }));
      }
    }
    return p;
  });
}

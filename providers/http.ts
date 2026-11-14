// Shared JSON POST/GET for paid providers (their own APIs, not arbitrary pages).
export async function api<T>(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw Object.assign(new Error(`${new URL(url).host}: HTTP ${res.status} ${text.slice(0, 160)}`), {
      status: res.status,
      retryAfter: res.headers.get("retry-after") ?? undefined,
    });
  return (text ? JSON.parse(text) : {}) as T;
}

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

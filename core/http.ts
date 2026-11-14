// Polite fetching for Job Signal's own requests (the ATS runner has its own, isolated copy):
// a clear User-Agent, at most one request per host per interval, robots.txt respected,
// conditional requests with a stored ETag, and no requests to private addresses.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { isLinkedIn } from "../apply/linkedin.ts";
import { loadConfig } from "./config.ts";
import { failure } from "./trace.ts";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** Without a DNS lookup: is this URL plain http(s) and not a private address or localhost? */
export function isPublicUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || (!h.includes(".") && !isIP(h))) return false;
  const fam = isIP(h);
  return !fam || !blocked.check(h, fam === 6 ? "ipv6" : "ipv4");
}

/** Can a role keep this link? A web page or a mail link (a careers page may give one), or none
 * at all; never a file or another app's scheme, which a scraped page could name and a click open.
 * The link is only checked, never changed: a role's link is its identity elsewhere. */
export function roleLinkOk(url: string): boolean {
  if (!url) return true;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** LinkedIn's pages are never read (README): asked of every page read, each redirect hop included. */
export function refuseLinkedIn(url: string | URL): void {
  if (isLinkedIn(String(url)))
    throw Object.assign(new Error("LinkedIn pages are never read"), { linkedin: true });
}

/**
 * Refuse a host any of whose addresses is private, loopback, link-local or reserved. A known limit:
 * the name is looked up here and again by the fetch that follows, so a name that answers a public
 * address here and a private one a moment later (DNS rebinding) gets past it. The board runner's
 * vendored readers check at the moment of connecting instead (vendor/career-ops/providers/_ip-guard.mjs).
 */
export async function assertPublicHost(host: string): Promise<void> {
  const h = host.replace(/^\[|\]$/g, "");
  const addrs = isIP(h) ? [{ address: h, family: isIP(h) }] : await lookup(h, { all: true });
  for (const a of addrs) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked as the IPv4 address it carries.
    const mapped = a.address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
    const [addr, fam] = mapped
      ? [mapped, "ipv4" as const]
      : [a.address, a.family === 6 ? ("ipv6" as const) : ("ipv4" as const)];
    if (blocked.check(addr, fam)) throw new Error(`refused private address for ${host}`);
  }
}

// A robots.txt is bounded when read: longer rules are ignored, and reading stops after this many.
const ROBOTS_MAX_RULE = 2000;
const ROBOTS_MAX_RULES = 1000;

type Robots = { allow: string[]; disallow: string[]; delay: number; sitemaps: string[] } | null;

export function parseRobots(text: string): NonNullable<Robots> {
  const rules = { allow: [] as string[], disallow: [] as string[], delay: 0, sitemaps: [] as string[] };
  let applies = false;
  let inAgents = false;
  for (const raw of text.split("\n")) {
    const m = raw
      .replace(/#.*/, "")
      .trim()
      .match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const v = m[2]!;
    if (key === "user-agent") {
      if (!inAgents) applies = false;
      inAgents = true;
      if (v === "*" || /jobsignal/i.test(v)) applies = true;
      continue;
    }
    // Sitemap lines belong to no group of agents.
    if (key === "sitemap") {
      if (v) rules.sitemaps.push(v.trim());
      continue;
    }
    inAgents = false;
    if (!applies) continue;
    if ((key === "disallow" || key === "allow") && v.length > ROBOTS_MAX_RULE) continue;
    if (rules.allow.length + rules.disallow.length >= ROBOTS_MAX_RULES) break;
    if (key === "disallow" && v) rules.disallow.push(v);
    else if (key === "allow" && v) rules.allow.push(v);
    else if (key === "crawl-delay") rules.delay = Math.min(10_000, Number(v) * 1000 || 0);
  }
  return rules;
}

/**
 * Google-style matching: `*` is any run of characters, a trailing `$` anchors the end. Done by
 * finding each literal piece in order rather than with a regular expression, which a rule with
 * many `*` can make take forever (any site can serve one).
 */
export function robotsMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = pieces[0]!;
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;
  let at = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = path.indexOf(pieces[i]!, at);
    if (found < 0) return false;
    at = found + pieces[i]!.length;
  }
  const last = pieces[pieces.length - 1]!;
  if (anchored) return path.length - last.length >= at && path.endsWith(last);
  return path.indexOf(last, at) >= 0;
}

export function robotsAllow(rules: Robots, pathAndQuery: string): boolean {
  if (!rules) return true;
  const longest = (list: string[]) =>
    Math.max(-1, ...list.filter((p) => robotsMatch(p, pathAndQuery)).map((p) => p.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

const nextSlot = new Map<string, number>();
const robotsCache = new Map<string, Robots>();

async function gate(host: string, delay: number): Promise<void> {
  const min = 1000 / loadConfig().polling.per_host_rps;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + Math.max(min, delay));
  if (at > now) await Bun.sleep(at - now);
}

const ua = () => loadConfig().polling.user_agent;

async function robotsFor(u: URL): Promise<Robots> {
  if (robotsCache.has(u.host)) return robotsCache.get(u.host)!;
  let rules: Robots = null;
  try {
    await gate(u.host, 0);
    // Redirects are followed by hand, each hop's address checked, as RFC 9309 asks (Dayforce's
    // us59.dayforcehcm.com/robots.txt is www.dayforcehcm.com's).
    let at = new URL(`${u.origin}/robots.txt`);
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicHost(at.hostname);
      const res = await fetch(at, {
        headers: { "user-agent": ua() },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        at = new URL(loc, at);
        if (!/^https?:$/.test(at.protocol)) break;
        continue;
      }
      if (res.ok) rules = parseRobots(await readCapped(res, 500_000));
      break;
    }
  } catch {}
  robotsCache.set(u.host, rules);
  return rules;
}

/** The sitemaps a site's robots.txt names (read once per host, with its rules). */
export async function sitemapsFor(url: string): Promise<string[]> {
  return (await robotsFor(new URL(url)))?.sitemaps ?? [];
}

/** Read a body up to `max` bytes, then stop downloading: a huge page is truncated, not buffered. */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= max) await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/** A configured exception to robots.txt for this URL, logged once per URL per process. */
const excepted = new Set<string>();
export function robotsException(url: string): boolean {
  const hit = loadConfig().robots.exceptions.find((x) => url.startsWith(x.prefix));
  if (!hit) return false;
  if (!excepted.has(url)) {
    excepted.add(url);
    failure("robots-exception", new URL(url).hostname, `robots.txt overridden: ${hit.reason}`, { url });
  }
  return true;
}

/** Does this site's robots.txt let us read this URL (or does a configured exception)? */
export async function robotsAllowed(url: string): Promise<boolean> {
  const u = new URL(url);
  return robotsAllow(await robotsFor(u), u.pathname + u.search) || robotsException(url);
}

export type Fetched = {
  status: number;
  url: string;
  text: string;
  etag?: string;
  lastModified?: string;
  notModified: boolean;
};

/**
 * GET a page politely. Redirects are followed by hand, re-checking each hop's address.
 * Pass the previous etag/lastModified to get `notModified: true` instead of a body.
 */
export async function politeGet(
  url: string,
  opts: {
    etag?: string;
    lastModified?: string;
    accept?: string;
    maxBytes?: number;
    timeoutMs?: number;
    userAgent?: string;
  } = {},
): Promise<Fetched> {
  let current = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if (!/^https?:$/.test(current.protocol)) throw new Error(`refused scheme ${current.protocol}`);
    refuseLinkedIn(current);
    await assertPublicHost(current.hostname);
    const rules = await robotsFor(current);
    if (!robotsAllow(rules, current.pathname + current.search) && !robotsException(current.href))
      throw Object.assign(new Error(`robots.txt disallows ${current.href}`), { robots: true });
    await gate(current.host, rules?.delay ?? 0);
    const headers: Record<string, string> = {
      "user-agent": opts.userAgent ?? ua(),
      accept: opts.accept ?? "*/*",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
    const res = await fetch(current, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      continue;
    }
    const base = {
      status: res.status,
      url: current.href,
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
    };
    if (res.status === 304) return { ...base, text: "", notModified: true };
    if (!res.ok)
      throw Object.assign(new Error(`HTTP ${res.status} for ${current.href}`), { status: res.status });
    return { ...base, text: await readCapped(res, opts.maxBytes ?? 3_000_000), notModified: false };
  }
  throw new Error(`too many redirects from ${url}`);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};
const ENTITY = /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi;

/**
 * "Operations &amp;amp; Platform" → "Operations & Platform": a title or place as a page's tags
 * or JSON-LD write it, its entities decoded, twice-encoded ones too (Workday's og:title).
 */
export function unescapeHtml(s: string): string {
  for (let i = 0; i < 3 && s.search(ENTITY) >= 0; i++)
    s = s.replace(ENTITY, (m, e: string) => {
      if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? m;
      const n = /^#x/i.test(e) ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    });
  return s;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

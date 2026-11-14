// Politeness and safety helpers for the ATS runner (kept apart so they can be tested).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedAddress } from "../vendor/career-ops/providers/_ip-guard.mjs";

/** LinkedIn's pages are never read: a linkedin.com host (uk.linkedin.com too) or lnkd.in. */
export const isLinkedInHost = (host) =>
  /(^|\.)(linkedin\.com|lnkd\.in)$/i.test(String(host).replace(/\.+$/, ""));

/**
 * Refuse hosts that resolve to loopback, private or link-local addresses. The same known limit as
 * core/http.ts assertPublicHost: a plain fetch after it looks the name up again (the vendored
 * readers' own requests are checked as they connect).
 */
export async function assertPublic(host) {
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) if (isBlockedAddress(a.address)) throw new Error(`blocked address for ${host}`);
}

/**
 * A site's robots.txt text, or null when it has none or can't be read. Redirects are followed by
 * hand, each hop's address checked before it is asked (a board's robots.txt can point anywhere,
 * an address inside the person's own network included), up to 5 hops. `fetchImpl` and `check`
 * are swappable in tests.
 */
export async function readRobots(origin, userAgent, { fetchImpl = fetch, check = assertPublic } = {}) {
  let at = new URL("/robots.txt", origin);
  for (let hop = 0; hop < 5; hop++) {
    if (at.protocol !== "https:" && at.protocol !== "http:") return null;
    await check(at.hostname.replace(/^\[|\]$/g, ""));
    const res = await fetchImpl(at, {
      headers: { "user-agent": userAgent },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      at = new URL(loc, at);
      continue;
    }
    return res.ok ? await res.text() : null;
  }
  return null;
}

// A robots.txt is bounded when read: longer rules are ignored, and reading stops after this many.
const ROBOTS_MAX_RULE = 2000;
const ROBOTS_MAX_RULES = 1000;

export function parseRobots(text) {
  const rules = { disallow: [], allow: [], delay: 0 };
  let applies = false;
  let sawAgent = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    const key = k.toLowerCase();
    if (key === "user-agent") {
      if (!sawAgent) applies = false;
      sawAgent = true;
      if (v === "*" || /jobsignal/i.test(v)) applies = true;
    } else {
      sawAgent = false;
      if (!applies) continue;
      if ((key === "disallow" || key === "allow") && v.length > ROBOTS_MAX_RULE) continue;
      if (rules.allow.length + rules.disallow.length >= ROBOTS_MAX_RULES) break;
      if (key === "disallow" && v) rules.disallow.push(v);
      if (key === "allow" && v) rules.allow.push(v);
      if (key === "crawl-delay") rules.delay = Math.min(10_000, Number(v) * 1000 || 0);
    }
  }
  return rules;
}

/**
 * Google-style matching: `*` is any run of characters, a trailing `$` anchors the end. Done by
 * finding each literal piece in order rather than with a regular expression, which a rule with
 * many `*` can make take forever (any site can serve one).
 */
export function robotsMatch(pattern, path) {
  const anchored = pattern.endsWith("$");
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = pieces[0];
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;
  let at = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const found = path.indexOf(pieces[i], at);
    if (found < 0) return false;
    at = found + pieces[i].length;
  }
  const last = pieces[pieces.length - 1];
  if (anchored) return path.length - last.length >= at && path.endsWith(last);
  return path.indexOf(last, at) >= 0;
}

/** Longest match wins, allow on a tie, as Google reads robots.txt. */
export function allowed(rules, pathAndQuery) {
  if (!rules) return true;
  const longest = (list) =>
    Math.max(-1, ...list.filter((p) => robotsMatch(p, pathAndQuery)).map((p) => p.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

/** Is this URL under one of the configured robots.txt exception prefixes? */
export function excepted(url, prefixes) {
  return prefixes.some((p) => url.startsWith(p));
}

// The count a board reports for itself, to check our read against (`jobsignal report`): a total
// where the API gives one (Greenhouse meta.total, Workday total, SmartRecruiters totalFound,
// Dover count), else the length of the list it answered with (Ashby, Lever).
export function countOf(body, store) {
  if (!store || !body || typeof body !== "object") return;
  const total = [body.meta?.total, body.total, body.totalFound, body.count].find(Number.isFinite);
  if (total !== undefined) store.total = Math.max(store.total ?? 0, total);
  else if (store.total === undefined) {
    const list = Array.isArray(body) ? body : Array.isArray(body.jobs) ? body.jobs : null;
    if (list) store.listed = (store.listed ?? 0) + list.length;
  }
}

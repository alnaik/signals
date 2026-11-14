// Work, part one: gather what's free and checkable before any model runs.
// Every finding becomes a fact on the thread with its source and exact quote, the same entry
// the link checker reads. A step that fails or costs more than the cap allows is skipped and
// said so; the run goes on.

import { isLinkedIn } from "../apply/linkedin.ts";
import { open } from "../core/db.ts";
import { derive, type Role } from "../core/derive.ts";
import { htmlToText, politeGet } from "../core/http.ts";
import * as index from "../core/index-db.ts";
import { append, type Entry, read } from "../core/log.ts";
import { applyEmailOf, companyOfThread, fundingOf, signalsOf } from "../intake/companies.ts";
import { findContact } from "../providers/contact.ts";
import { gh, orgFor } from "../providers/github.ts";
import { duplicateCheck } from "../providers/github-issues.ts";
import { api } from "../providers/http.ts";
import { call, getProvider, isAvailable, people, search } from "../providers/registry.ts";
import type { Confidence, ContactHit, Person } from "../providers/types.ts";

const DAY = 86_400_000;
type Progress = (line: string) => void;
type Fact = { group: string; text: string; url: string; quote: string; provider?: string };

export type Gathered = { facts: number; skipped: string[]; person: string | null };

/** The manager, from the posting's own words: "reports to the Head of X", "join Maria's team". */
export function managerFromPosting(body: string): { title?: string; name?: string; quote: string } | null {
  const sentences = body.split(/(?<=[.!?\n])\s+/);
  const patterns: [RegExp, (m: RegExpMatchArray) => { title?: string; name?: string }][] = [
    [
      /\breport(?:s|ing)? (?:directly )?(?:in)?to (?:the |our |a )?([A-Z][\w&/,\- ]{2,60}?)(?=[.,;:)]|\s+(?:and|who|on|in|at)\b|$)/,
      (m) => ({ title: m[1]!.trim() }),
    ],
    [/\b[Jj]oin ([A-Z][a-z]+)['’]s team\b/, (m) => ({ name: m[1]! })],
    [
      /\bwork (?:directly|closely) with (?:our |the )?(CTO|CEO|founders?|co-?founders?|Head of [A-Z]\w+|VP of [A-Z]\w+)/i,
      (m) => ({ title: m[1]! }),
    ],
  ];
  for (const s of sentences) {
    for (const [re, pick] of patterns) {
      const m = s.match(re);
      if (m) return { ...pick(m), quote: s.trim().slice(0, 400) };
    }
  }
  return null;
}

/** Engineering, Design, Product, Data: from the title, when the board doesn't say. */
export function departmentOf(title: string): string {
  if (/design/i.test(title)) return "Design";
  if (/product manager|\bpm\b/i.test(title)) return "Product";
  if (/data|machine learning|\bml\b|analytics/i.test(title)) return "Data";
  if (/sales|account exec|business development/i.test(title)) return "Sales";
  return "Engineering";
}

/** A role as the board reads kept it: when it was first seen, when it left, when an earlier one by that title was. */
export type Seen = {
  url: string;
  title: string;
  first_seen: string;
  closed_at: string | null;
  reposted: string | null;
};

/** Days open, reposts and roles added the same week, from the roles table. */
export function hiringHistory(seen: Seen[], roles: Role[], asOf = new Date()): string[] {
  if (!seen.length) return [];
  const out: string[] = [];
  const byUrl = new Map(seen.map((s) => [s.url, s]));
  for (const r of roles) {
    const s = r.url ? byUrl.get(r.url) : undefined;
    if (!s) continue;
    const until = s.closed_at ? Date.parse(s.closed_at) : asOf.getTime();
    const days = Math.round((until - Date.parse(s.first_seen)) / DAY);
    const week = seen.filter(
      (j) => j.url !== s.url && Math.abs(Date.parse(j.first_seen) - Date.parse(s.first_seen)) < 7 * DAY,
    );
    const parts = [`${r.title}: on the board ${days} days (first seen ${s.first_seen.slice(0, 10)})`];
    if (s.reposted)
      parts.push(`reposted (an earlier one by this title was first seen ${s.reposted.slice(0, 10)})`);
    if (week.length)
      parts.push(
        `${week.length} other roles added that week: ${week
          .map((j) => j.title)
          .slice(0, 5)
          .join("; ")}`,
      );
    out.push(parts.join(" · "));
  }
  return out;
}

/** New subdomains in the certificate log over the last 90 days: what they're about to launch. */
export async function newSubdomains(
  domain: string,
  now = new Date(),
): Promise<{ name: string; first: string }[]> {
  const certs = await api<{ name_value: string; not_before: string }[]>(
    `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`,
    { headers: { "user-agent": "JobSignal" }, timeoutMs: 45_000 },
  );
  const first = new Map<string, string>();
  for (const c of certs) {
    for (const n of c.name_value.split("\n")) {
      const name = n.trim().toLowerCase();
      if (!name.endsWith(`.${domain}`) || name.startsWith("*.") || name.startsWith("www.")) continue;
      const prev = first.get(name);
      if (!prev || c.not_before < prev) first.set(name, c.not_before);
    }
  }
  const cutoff = new Date(now.getTime() - 90 * DAY).toISOString();
  return [...first.entries()]
    .filter(([, t]) => t >= cutoff)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([name, t]) => ({ name, first: t.slice(0, 10) }));
}

type Issue = {
  html_url: string;
  title: string;
  comments: number;
  reactions?: { total_count?: number };
  user?: { login: string };
  comments_url: string;
};

export async function gather(
  thread: string,
  progress: Progress = () => {},
  now = new Date(),
): Promise<Gathered> {
  const d = derive(read(thread));
  const known = new Set(d.facts.map((f) => `${f.source?.url}|${f.source?.quote}`));
  const out: Gathered = { facts: 0, skipped: [], person: null };
  const add = (f: Fact): Entry | null => {
    const quote = f.quote.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!quote || known.has(`${f.url}|${quote}`)) return null;
    known.add(`${f.url}|${quote}`);
    out.facts++;
    return append(thread, {
      actor: f.provider ?? "gather",
      kind: "fact",
      data: { group: f.group, text: f.text.slice(0, 300) },
      source: {
        type: f.provider ? "provider_record" : "page",
        url: f.url,
        quote,
        fetched_at: now.toISOString(),
        ...(f.provider ? { provider: f.provider } : {}),
      },
    });
  };
  const step = async (label: string, fn: () => Promise<void>) => {
    progress(label);
    try {
      await fn();
    } catch (err) {
      out.skipped.push(`${label}: ${(err as Error).message.slice(0, 120)}`);
    }
  };
  const roles = d.roles.filter((r) => r.status !== "dismissed");
  const company = companyOfThread(thread);
  // The company's roles as its boards listed them, with the text kept of those that fit.
  const seen = company
    ? (open()
        .query(
          `SELECT r.url, r.title, r.first_seen, r.closed_at, r.reposted, t.text FROM roles r
           LEFT JOIN role_text t ON t.role_id = r.id WHERE r.company_id = ? ORDER BY r.first_seen`,
        )
        .all(company.id) as (Seen & { text: string | null })[])
    : [];
  const board = company
    ? (open()
        .query("SELECT url FROM boards WHERE company_id = ? AND status = 'ok' LIMIT 1")
        .get(company.id) as {
        url: string;
      } | null)
    : null;
  const bodies: { role: Role; body: string }[] = [];

  // 0. What named the company: the posts themselves, as the source delivered them (stored, so
  // never fetched again). A company with no role has nothing else that says why it is here.
  if (company)
    for (const s of signalsOf(company.id, 3)) {
      if (s.source === "linkedin" || !s.text || s.text.trim().length < 40) continue;
      if (roles.some((r) => r.url === s.url)) continue; // a posting: read below
      add({
        group: s.source === "hn" || s.kind === "posting" ? "hiring" : "product",
        text: `${company.name}, named in a post (${s.source_tag})${s.title ? `: ${s.title}` : ""}`,
        url: s.url,
        quote: s.text,
        provider: s.source,
      });
    }

  // 1. The postings themselves. LinkedIn is never read (a role from its alert has no page we read).
  for (const r of roles) {
    if (!r.url || isLinkedIn(r.url)) continue;
    await step(`reading ${new URL(r.url).hostname}`, async () => {
      const fromBoard = seen.find((j) => j.url === r.url)?.text;
      const body = fromBoard
        ? htmlToText(fromBoard)
        : htmlToText((await politeGet(r.url!, { accept: "text/html" })).text);
      if (body.length < 80) throw new Error("the posting page has no readable text");
      bodies.push({ role: r, body });
      add({ group: "hiring", text: `Posting: ${r.title}`, url: r.url!, quote: body.slice(0, 900) });
    });
  }

  // 2. Hiring history, from our own reads of the board.
  for (const line of hiringHistory(seen, roles, now)) {
    add({
      group: "hiring",
      text: line,
      url: board?.url ?? `https://${thread}`,
      quote: line,
      provider: "board reads",
    });
  }

  // Money: its last Form D filing (sources/form-d), a stored record; link check never fetches SEC.
  const funding = company ? fundingOf(company) : null;
  if (funding)
    add({
      group: "money",
      text: `Form ${funding.form} filed ${funding.date}`,
      url: funding.url,
      quote: `Form ${funding.form} filed ${funding.date} (CIK ${funding.cik})`,
      provider: "sec-edgar",
    });

  // How it takes applications when it has no board: the address on its careers page (or its own
  // HN post). Detection read it, perhaps Cloudflare-encoded, so the page text may not hold it as is.
  const email = company ? applyEmailOf(company) : null;
  if (email)
    add({
      group: "hiring",
      text: `Applies by email: ${email.address}`,
      url: email.page,
      quote: email.address,
      provider: "detection",
    });

  // 3–4. GitHub: the issues people want fixed, who triages them, and employees' upstream work.
  let org: string | null = null;
  await step("reading GitHub", async () => {
    org = await orgFor(thread, company?.name);
    if (!org) return;
    progress(`reading github.com/${org}`);
    const q = `org:${org} is:issue is:open no:assignee reactions:>=5`;
    const found = await gh<{ items: Issue[] }>(
      `/search/issues?q=${encodeURIComponent(q)}&sort=reactions&order=desc&per_page=5`,
    );
    const commenters = new Map<string, number>();
    for (const i of found.items) {
      const flags = await duplicateCheck(i.html_url).catch(() => []);
      add({
        group: "product",
        text: `Open issue, ${i.reactions?.total_count ?? 0} reactions, no one assigned: ${i.title}${flags.length ? ` (${flags.join("; ")})` : ""}`,
        url: i.html_url,
        quote: `${i.title} · ${i.reactions?.total_count ?? 0} reactions · ${i.comments} comments`,
        provider: "github-issues",
      });
      const comments = await gh<{ user: { login: string; type?: string } }[]>(
        `${new URL(i.comments_url).pathname}?per_page=100`,
      ).catch(() => []);
      for (const c of comments) {
        if (c.user.type === "Bot" || c.user.login === i.user?.login) continue;
        commenters.set(c.user.login, (commenters.get(c.user.login) ?? 0) + 1);
      }
    }
    const top = [...commenters.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) {
      add({
        group: "people",
        text: `${top[0]} replies most on these issues (${top[1]} comments)`,
        url: `https://github.com/${top[0]}`,
        quote: `${top[0]}: ${top[1]} comments on the top unassigned issues in ${org}`,
        provider: "github-issues",
      });
    }
    // Employees' upstream work: public members' recent commits to repositories outside the org.
    const members = await gh<{ login: string }[]>(`/orgs/${org}/public_members?per_page=10`).catch(() => []);
    for (const m of members.slice(0, 5)) {
      const commits = await gh<{
        items: { html_url: string; commit: { message: string }; repository: { full_name: string } }[];
      }>(
        `/search/commits?q=${encodeURIComponent(`author:${m.login} -org:${org}`)}&sort=author-date&order=desc&per_page=3`,
      ).catch(() => ({ items: [] }));
      for (const c of commits.items.slice(0, 2)) {
        add({
          group: "product",
          text: `${m.login} (${org}) committed upstream to ${c.repository.full_name}`,
          url: c.html_url,
          quote: c.commit.message.split("\n")[0]!,
          provider: "github",
        });
      }
    }
  });

  // 5. Certificate transparency: subdomains that appeared in the last 90 days.
  await step("reading the certificate log", async () => {
    const subs = await newSubdomains(thread, now);
    if (!subs.length) return;
    const line = subs
      .slice(0, 12)
      .map((s) => `${s.name} (${s.first})`)
      .join(", ");
    add({
      group: "product",
      text: `New subdomains in the last 90 days: ${line}`,
      url: `https://crt.sh/?q=%25.${thread}`,
      quote: line,
      provider: "crt.sh",
    });
  });

  // 8. What's said about them: GitHub issues and HN threads naming the company's domain. The
  // name alone finds namesakes: on 2026-10-27 "Juicebox" gave 0 of 10 hits about juicebox.ai
  // on both, while "plaid.com" gave 7 of 10 about Plaid.
  // One step each, so one failing doesn't skip the other.
  for (const [name, label, q] of [
    ["hn", "HN", thread],
    ["github-issues", "GitHub issues", `"${thread}" is:issue is:open`], // GitHub answers 422 without is:issue or is:pr
  ] as const) {
    await step(`searching ${label}`, async () => {
      const p = await getProvider(name);
      if (!p?.search || !isAvailable(p)) return;
      const results = await call(p, "search", [q, { n: 3 }], { station: "work", thread });
      for (const r of results)
        add({ group: "product", text: r.title, url: r.url, quote: r.snippet, provider: name });
    });
  }

  // 6. The hiring manager, cheapest first, stopping at the first named person.
  progress("looking for the hiring manager");
  let person: {
    name: string;
    role: string;
    confidence: Confidence;
    profile_urls: string[];
    github?: string;
  } | null = null;
  let wanted: string | null = null;
  for (const { role, body } of bodies) {
    const m = managerFromPosting(body);
    if (!m) continue;
    add({
      group: "people",
      text: `The posting says who the ${role.title} works for`,
      url: role.url!,
      quote: m.quote,
    });
    wanted ??= m.title ?? null;
    if (m.name)
      person = { name: m.name, role: m.title ?? "hiring manager", confidence: "verified", profile_urls: [] };
    if (person) break;
  }
  if (!person) {
    // Who shared the posting: the author of "we're hiring on my team" with that link.
    await step("searching for who shared the posting", async () => {
      for (const r of roles.filter((x) => x.url).slice(0, 2)) {
        const hits = (await search(r.url!, { n: 5 }, { station: "work", thread })).result ?? [];
        const own = hits.find(
          (h) =>
            /my team|we('| a)re hiring|i('| a)m hiring|join (me|us)/i.test(h.snippet) &&
            !h.url.includes(thread),
        );
        if (!own) continue;
        const handle =
          own.url.match(/(?:x|twitter)\.com\/([\w]+)\/status/)?.[1] ??
          own.url.match(/linkedin\.com\/posts\/([\w-]+?)_/)?.[1];
        if (!handle) continue;
        add({
          group: "people",
          text: `${handle} shared the ${r.title} posting`,
          url: own.url,
          quote: own.snippet,
          provider: "search",
        });
        person = {
          name: handle,
          role: "shared the posting",
          confidence: "verified",
          profile_urls: [own.url],
        };
        break;
      }
    });
  }
  if (!person) {
    // From the department and the company's size to a title, then people who hold it. Open roles
    // stand in for size: a board with under ten is a company where a founder or lead hires.
    const listed = seen.filter((j) => !j.closed_at).length;
    const small = (board ? listed : roles.length) < 10;
    const dept = departmentOf(roles[0]?.title ?? "");
    const titles = wanted
      ? [wanted]
      : small
        ? ["CTO", "co-founder", "founder", `Head of ${dept}`]
        : [`${dept} Manager`, `Head of ${dept}`, `Director of ${dept}`];
    await step(`looking for the ${titles[0]}`, async () => {
      const r = await people(thread, titles, { station: "work", thread }, d.company || undefined);
      const found: Person[] = r.result ?? [];
      const match = found.find((p) =>
        titles.some((t) => p.role.toLowerCase().includes(t.toLowerCase().split(" ")[0]!)),
      );
      if (!match) {
        // Who the search saw, by name and title only, so a later look can tell why no one matched.
        append(thread, {
          actor: "gather",
          kind: "note",
          data: {
            event: "no_manager",
            text: `Looked for ${titles.join(" / ")} at ${thread}${r.by ? ` on ${r.by}` : ""}: ${found.length} people seen, none with those titles`,
            seen: found.slice(0, 20).map((p) => ({ name: p.name, role: p.role })),
          },
        });
        return;
      }
      add({
        group: "people",
        text: `${match.name}: ${match.role}`,
        url: match.profile_urls[0] ?? `https://${thread}`,
        quote: [match.name, match.role].filter(Boolean).join(" · "),
        provider: match.source,
      });
      person = {
        name: match.name,
        role: match.role,
        confidence: "pattern",
        profile_urls: match.profile_urls,
      };
    });
  }

  // Then the channel for that person, through the contact waterfall.
  const p = person as typeof person;
  if (p) {
    out.person = p.name;
    let hits: ContactHit[] = [];
    await step(`finding how to reach ${p.name}`, async () => {
      hits = (await findContact({ ...p, source: "work", domain: thread }, { station: "work", thread })).hits;
    });
    append(thread, {
      actor: "gather",
      kind: "contact",
      data: { name: p.name, role: p.role, confidence: p.confidence, channels: hits },
    });
  }
  index.reindex(thread);
  return out;
}

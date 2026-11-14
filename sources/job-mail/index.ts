// Job mail: one door for alert emails, read two ways. Recommended: a spare mailbox that holds
// only job mail (alerts sent or forwarded there), read over IMAP with an app password from the
// Keychain, opened read-only (mail/imap.ts). Or: the Gmail job label, through the read-only
// Google app (gmail/client.ts). Known senders have their own parsers (LinkedIn's job alerts;
// Grok's daily mail, whose posts are read through the X API); a forwarded mail is read as the
// one inside it. Mail from anyone else is read by the small model when one is connected.
// Replaces the LinkedIn alerts and Grok mail sources: their signals keep their source keys.
import { loadFilters, passes } from "../../ats/filters.ts";
import { loadConfig } from "../../core/config.ts";
import { getSecret } from "../../core/keychain.ts";
import { canUseSmallModel, NoModelKey, OverCap, smallJson } from "../../core/model.ts";
import { updateState } from "../../core/state.ts";
import { isConnected as gmailConnected, type Message, search } from "../../gmail/client.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { type ImapLogin, readMailbox } from "../../mail/imap.ts";
import { parseRaw } from "../../mail/mime.ts";
import { readSourceState, writeSourceState } from "../../signals/state.ts";
import { postIdFromUrl, readPosts, isConnected as xConnected } from "../../xapi/client.ts";
import { toLead } from "../x-bookmarks/index.ts";

export const KEY = "job-mail";
export const PASSWORD = "job_mail_password";
const cfg = () => loadConfig().source[KEY] ?? {};
const DAYS = 3;
const MODEL_MAILS = 10; // unknown senders read by the model per run, at most

/** The spare mailbox's details, when set: host and address in config, the app password in the Keychain. */
export function imapLogin(): ImapLogin | null {
  const c = cfg();
  const password = getSecret(PASSWORD);
  if (!c.imap_host || !c.imap_user || !password) return null;
  return { host: String(c.imap_host), port: Number(c.imap_port) || 993, user: String(c.imap_user), password };
}

// ---------------------------------------------------------------------------------------------
// Forwarded mail: Gmail's "---------- Forwarded message ---------", Apple Mail's "Begin
// forwarded message:", Outlook's "From: … Sent: …" block, quoted with "> " or not. A mail that a
// filter forwards on its own keeps its sender and needs nothing.

const FORWARD =
  /^(?:>\s*)?(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:|-{2,}\s*Original Message\s*-{2,})\s*$/im;

/** The mail inside a forwarded one, with its own sender; the mail itself when it isn't one. */
export function unforward(m: Message): Message {
  const at = m.body.search(FORWARD);
  const block = at >= 0 ? m.body.slice(at) : /^From:.*\n(?:.*\n){0,3}?Sent:/m.test(m.body) ? m.body : null;
  if (!block) return m;
  const lines = block.split(/\r?\n/).map((l) => l.replace(/^>\s?/, ""));
  const start = at >= 0 ? 1 : lines.findIndex((l) => /^From:/i.test(l));
  let i = start;
  while (i < lines.length && !lines[i]!.trim()) i++; // a blank line may follow the marker
  const head: Record<string, string> = {};
  for (; i < lines.length && lines[i]!.trim(); i++) {
    const h = lines[i]!.match(/^\*?(From|Date|Sent|Subject|To|Cc):\*?\s*(.*)$/i);
    if (h) head[h[1]!.toLowerCase()] = h[2]!.trim();
  }
  if (!head.from) return m;
  const addr = head.from.match(/<([^>]+)>/)?.[1] ?? head.from.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? head.from;
  return {
    ...m,
    from: addr.trim().toLowerCase(),
    fromName: head.from
      .replace(/<[^>]+>/, "")
      .replace(/"/g, "")
      .trim(),
    subject: head.subject ?? m.subject,
    body: lines.slice(i).join("\n").trim(),
  };
}

// ---------------------------------------------------------------------------------------------
// LinkedIn's job alerts

export type Alert = { title: string; company: string; location: string; url: string };
const SKIP = /^(view job|apply|---|https?:)/i;

/**
 * Each "View job" link with the block of lines above it: title, company, location. LinkedIn
 * may put a line like "2 connections" or "This company is actively hiring" after a blank
 * line below the block, so the block is the last run of two or more consecutive lines.
 */
export function parseAlert(m: Pick<Message, "body">): Alert[] {
  const lines = m.body.split(/\r?\n/).map((l) => l.trim());
  const out: Alert[] = [];
  for (let i = 0; i < lines.length; i++) {
    const url = lines[i]!.match(/https:\/\/www\.linkedin\.com\/(?:comm\/)?jobs\/view\/\d+/)?.[0];
    if (!url) continue;
    const blocks: string[][] = [[]];
    for (const l of lines.slice(Math.max(0, i - 8), i)) {
      if (!l || l.startsWith("---")) blocks.push([]);
      else if (!SKIP.test(l)) blocks.at(-1)!.push(l);
    }
    const block = blocks.findLast((b) => b.length >= 2) ?? [];
    const [title, company, location] = block.slice(-3);
    if (title && company) out.push({ title, company, location: location ?? "", url });
  }
  return out;
}

function alertLeads(m: Message): Lead[] {
  const filters = loadFilters();
  // Only jobs inside the profile filters; only a name: discovery finds the company's domain and board.
  return parseAlert(m)
    .filter((a) => passes(a, filters))
    .map((a) => ({
      url: a.url,
      company_hint: a.company,
      title: a.title,
      ...(a.location ? { location: a.location } : {}),
      text: [a.title, a.company, a.location].filter(Boolean).join(" · "),
      kind: "posting" as const,
      posted_at: m.date,
      seen_at: m.date,
      source: "linkedin",
      source_tag: "LinkedIn alert",
    }));
}

// ---------------------------------------------------------------------------------------------
// Grok's daily mail: every post it names is read through the X API before it becomes a lead,
// so the lead is built from what the post says, never from Grok's summary.

async function grokLeads(mails: Message[]): Promise<Lead[]> {
  const ids = [...new Set(mails.flatMap((m) => m.links.map(postIdFromUrl).filter((x): x is string => !!x)))];
  const posts = ids.length ? await readPosts(ids) : [];
  return posts.map((p) => ({ ...toLead(p), source: "grok", source_tag: "Grok" }));
}

// ---------------------------------------------------------------------------------------------
// Anyone else: the small model lists the jobs a mail names, with a link from the mail itself.

const SYSTEM =
  "You read one email from a job-alert or job-newsletter sender. List each job opening it names: the hiring company, the job title, the location as written, and the link to that job taken exactly from the email's links. Leave out ads, courses, events and anything that is not a job opening. An email with no job openings gives an empty list.";
const SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          location: { type: "string" },
          url: { type: "string" },
        },
        required: ["company", "title", "location", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["jobs"],
  additionalProperties: false,
};

async function modelLeads(m: Message): Promise<Lead[]> {
  const user = `From: ${m.fromName} <${m.from}>\nSubject: ${m.subject}\n\n<body>\n${m.body.slice(0, 12_000)}\n</body>\n\n<links>\n${m.links.slice(0, 80).join("\n")}\n</links>`;
  const { jobs } = await smallJson<{ jobs: Alert[] }>({
    station: "job-mail",
    system: SYSTEM,
    user,
    schema: SCHEMA,
  });
  const filters = loadFilters();
  const links = new Set(m.links);
  return jobs
    .filter((j) => j.company.trim() && j.title.trim() && links.has(j.url) && passes(j, filters))
    .map((j) => ({
      url: j.url,
      company_hint: j.company.trim(),
      title: j.title.trim(),
      ...(j.location ? { location: j.location } : {}),
      text: [j.title, j.company, j.location].filter(Boolean).join(" · "),
      kind: "posting" as const,
      posted_at: m.date,
      seen_at: m.date,
      source: KEY,
      source_tag: m.fromName || m.from,
    }));
}

const sender = (m: Message, key: "linkedin" | "grok", fallback: string) =>
  m.from.endsWith(String(cfg()[`${key}_from`] ?? fallback));

// ---------------------------------------------------------------------------------------------

type State = { seen: string[]; uids: Record<string, number[]> };

const boxKey = (login: ImapLogin) => `${login.user}@${login.host}`;

/**
 * The mail of the last few days not read before: from the spare mailbox, the Gmail label, or both.
 * Nothing is counted read here: the run marks what it is done with (markRead).
 */
async function newMail(state: State): Promise<Message[]> {
  const seen = new Set(state.seen);
  const out: Message[] = [];
  const after = new Date(Date.now() - DAYS * 86_400_000);
  const login = imapLogin();
  if (login) {
    const box = await readMailbox(login, { since: after, skip: new Set(state.uids[boxKey(login)] ?? []) });
    for (const r of box.messages) out.push(parseRaw(r.raw, `imap:${box.uidValidity}:${r.uid}`));
  }
  if (gmailConnected())
    out.push(...(await search({ label: true, after, max: 30 })).filter((m) => !seen.has(m.id)));
  return out;
}

/**
 * The mails a run is done with, counted read: a spare mailbox's by their UID, the Gmail label's by
 * their id. A held one is neither, so the next run reads it again, by either route.
 */
function markRead(state: State, done: Message[]): void {
  const login = imapLogin();
  const uids = done.filter((m) => m.id.startsWith("imap:")).map((m) => Number(m.id.split(":")[2]));
  if (login && uids.length)
    state.uids[boxKey(login)] = [...uids, ...(state.uids[boxKey(login)] ?? [])].slice(0, 500);
  state.seen = [...done.map((m) => m.id), ...state.seen].slice(0, 500);
}

const jobMail: Source = {
  key: KEY,
  name: "Job mail",
  schedule: "every_6h",
  connected: () => !!imapLogin() || gmailConnected(),
  status: () => (imapLogin() ? "spare mailbox" : gmailConnected() ? "Gmail label" : undefined),
  fetch: async () => {
    // The LinkedIn alerts source's read mails count as read here, so nothing comes in twice.
    const state = readSourceState<State>(KEY, {
      seen: readSourceState<{ seen: string[] }>("linkedin", { seen: [] }).seen,
      uids: {},
    });
    const all = (await newMail(state)).map(unforward);
    const mails = all.filter((m) => !m.autoReply);
    // The two sources this replaces leave the board's list.
    updateState((s) => {
      delete s.sources.linkedin;
      delete s.sources.grok;
    });
    const leads: Lead[] = [];
    const grok: Message[] = [];
    // Mails read again at the next run (within the last days): a Grok mail while X isn't
    // connected, and another sender's past this run's share or the model's limit.
    const held = new Set<string>();
    let modelRead = 0;
    let unread = 0;
    for (const m of mails) {
      if (sender(m, "linkedin", "linkedin.com")) leads.push(...alertLeads(m));
      else if (sender(m, "grok", "x.ai")) {
        grok.push(m);
        if (!xConnected()) held.add(m.id);
      } else if (!canUseSmallModel()) unread++;
      else if (modelRead >= MODEL_MAILS) held.add(m.id);
      else {
        modelRead++;
        try {
          leads.push(...(await modelLeads(m)));
        } catch (err) {
          if (err instanceof OverCap) held.add(m.id);
          else if (err instanceof NoModelKey) unread++;
          else throw err;
        }
      }
    }
    if (grok.length && xConnected()) leads.push(...(await grokLeads(grok)));
    const later = held.size - (xConnected() ? 0 : grok.length);
    const notes = [
      grok.length && !xConnected() ? `${grok.length} Grok mail${grok.length > 1 ? "s" : ""} wait for X` : "",
      later ? `${later} from other senders wait for the next run` : "",
      unread ? `${unread} from other senders unread: no model` : "",
    ].filter(Boolean);
    jobMail.note = notes.join("; ") || undefined;
    jobMail.read = mails.length;
    markRead(
      state,
      all.filter((m) => !held.has(m.id)),
    );
    writeSourceState(KEY, state);
    return leads;
  },
  // Grok's posts aren't filtered by title (as before): only alert and model jobs are re-checked.
  keys: ["linkedin", KEY],
  stillPasses: (s) => passes({ title: s.title ?? "", location: s.location ?? "" }, loadFilters()),
};

export default jobMail;

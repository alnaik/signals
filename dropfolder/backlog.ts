// A big drop, parked as a backlog. The nightly classifier takes 50 posts a night, so a drop that
// leaves more than BIG posts with no company (8,285 X bookmarks) would take it months. Its posts
// are parked instead (classify_tries PARKED, which the nightly run skips) and the rail offers
// Sort now. Then the tick sorts them all at once: their t.co links followed, one batch to the
// small model, its answers checked and filed. On the API key the batch is a Message Batch (half
// price); on the subscription it is asked here through Claude Code, a few at once, a few minutes
// a tick (localBatches). Each step keeps its state in the db (and the subscription's answers in a
// file), so a restart picks up where it stopped, and a batch is never sent twice.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  BatchCreateParams,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";
import { isLinkedIn } from "../apply/linkedin.ts";
import { loadConfig } from "../core/config.ts";
import { DAY, open, tx } from "../core/db.ts";
import { assertPublicHost, isPublicUrl } from "../core/http.ts";
import { canSpend, entries, record } from "../core/ledger.ts";
import {
  anthropic,
  CONNECT_MODEL,
  connection,
  firstLook,
  NoModelKey,
  OverCap,
  smallJson,
} from "../core/model.ts";
import { dataDir } from "../core/paths.ts";
import { modelCost } from "../core/prices.ts";
import { setAgent } from "../core/state.ts";
import { failure } from "../core/trace.ts";
import {
  type Answer,
  check,
  type Decision,
  inputOf,
  LABELS,
  MAX_TOKENS,
  place,
  SCHEMA,
  SYSTEM,
  userMessage,
} from "../intake/classify.ts";
import { companyByName, nameKey, type Signal } from "../intake/companies.ts";

export const BIG = 150; // posts left waiting for the classifier past which a drop is parked
export const PARKED = 100; // classify_tries of a parked post: the nightly run takes those under 2
const LINK_SECONDS = 300; // a tick's time for following links (2,453 took 6 minutes); the rest wait

export type Backlog = {
  id: number;
  file: string;
  posts: number;
  created_at: string;
  requested_at: string | null;
  stage: "waiting" | "links" | "sent" | "filing" | "done";
  link_cursor: number;
  batch_id: string | null;
  done_at: string | null;
  outcome: string | null;
};
export type Outcome = { file: number; unknown: number; answered: number; failed: number; usd: number };

/** The Batches API, as the tick uses it. Tests pass their own. */
export type Batches = {
  send: (requests: BatchCreateParams.Request[]) => Promise<string>;
  ended: (id: string) => Promise<boolean>;
  results: (id: string) => Promise<AsyncIterable<MessageBatchIndividualResponse>>;
};
export const anthropicBatches: Batches = {
  send: async (requests) => (await anthropic().messages.batches.create({ requests })).id,
  ended: async (id) => (await anthropic().messages.batches.retrieve(id)).processing_status === "ended",
  results: (id) => anthropic().messages.batches.results(id),
};

// On the subscription: the requests kept in a file, asked through Claude Code SORT_SECONDS a tick,
// 4 at once, each answer appended to the batch's answers file as it comes. Its id says so.
const SORT_SECONDS = 300;
const LOCAL = "subscription-";
const localFile = (id: string, kind: "requests" | "answers") =>
  path.join(dataDir(), "backlogs", `${id}.${kind}.jsonl`);
const jsonl = <T>(f: string): T[] =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
export const localBatches: Batches = {
  send: async (requests) => {
    const id = `${LOCAL}${Date.now()}`;
    mkdirSync(path.dirname(localFile(id, "requests")), { recursive: true });
    writeFileSync(localFile(id, "requests"), requests.map((r) => JSON.stringify(r)).join("\n"));
    return id;
  },
  ended: async (id) => {
    const asked = new Set(
      jsonl<MessageBatchIndividualResponse>(localFile(id, "answers")).map((r) => r.custom_id),
    );
    const todo = jsonl<BatchCreateParams.Request>(localFile(id, "requests")).filter(
      (r) => !asked.has(r.custom_id),
    );
    const until = Date.now() + SORT_SECONDS * 1000;
    let stop = false;
    const one = async (r: BatchCreateParams.Request): Promise<MessageBatchIndividualResponse | null> => {
      const p = r.params;
      const system = Array.isArray(p.system)
        ? p.system.map((b) => b.text).join("\n")
        : String(p.system ?? "");
      const user = String(p.messages[0]?.content ?? "");
      const schema =
        (p.output_config as { format?: { schema?: Record<string, unknown> } }).format?.schema ?? {};
      try {
        const json = await smallJson({ station: "classify", system, user, schema });
        const message = {
          content: [{ type: "text", text: JSON.stringify(json) }],
          stop_reason: "end_turn",
          usage: {},
        };
        return {
          custom_id: r.custom_id,
          result: { type: "succeeded", message },
        } as unknown as MessageBatchIndividualResponse;
      } catch (err) {
        // Signed out meanwhile, or the day's background checks are used: the rest wait, unasked.
        if (err instanceof NoModelKey || err instanceof OverCap) {
          stop = true;
          return null;
        }
        return {
          custom_id: r.custom_id,
          result: { type: "errored", error: {} },
        } as unknown as MessageBatchIndividualResponse;
      }
    };
    let left = todo.length;
    const worker = async () => {
      while (!stop && Date.now() < until) {
        const r = todo.shift();
        if (!r) return;
        const a = await one(r);
        if (!a) return;
        appendFileSync(localFile(id, "answers"), `${JSON.stringify(a)}\n`);
        left--;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return left === 0;
  },
  results: async (id) =>
    (async function* () {
      yield* jsonl<MessageBatchIndividualResponse>(localFile(id, "answers"));
    })(),
};

/** The batch on whichever model connection there is: a Message Batch on the key, else localBatches. */
export const modelBatches: Batches = {
  send: (requests) =>
    connection() === "subscription" ? localBatches.send(requests) : anthropicBatches.send(requests),
  ended: (id) => (id.startsWith(LOCAL) ? localBatches.ended(id) : anthropicBatches.ended(id)),
  results: (id) => (id.startsWith(LOCAL) ? localBatches.results(id) : anthropicBatches.results(id)),
};

/** May the batch go now: a model connected and, on the key, room under the cap for its most. */
const canSend = (id: number) => {
  const via = connection();
  return via === "subscription" || (via === "api-key" && canSpend(costOf(id).most));
};

export type Deps = { batches: Batches; follow: (url: string) => Promise<string> };

const get = (id: number) => open().query("SELECT * FROM backlogs WHERE id = ?").get(id) as Backlog | null;
const parkedPosts = (id: number) =>
  open()
    .query(
      "SELECT * FROM signals WHERE backlog_id = ? AND classify_tries = ? AND company_id IS NULL ORDER BY id",
    )
    .all(id, PARKED) as Signal[];

// ---------------------------------------------------------------------------------------------
// Parking

/** Park a drop's posts left for the classifier when there are more than BIG. The backlog's id, or null. */
export function park(file: string, signalIds: number[], now = new Date()): number | null {
  if (signalIds.length <= BIG) return null;
  return tx(() => {
    const d = open();
    const { id } = d
      .query("INSERT INTO backlogs (file, posts, created_at) VALUES (?, ?, ?) RETURNING id")
      .get(file, 0, now.toISOString()) as { id: number };
    const mark = d.query(
      "UPDATE signals SET classify_tries = ?, backlog_id = ? WHERE id = ? AND company_id IS NULL",
    );
    const posts = signalIds.reduce((n, s) => n + mark.run(PARKED, id, s).changes, 0);
    d.query("UPDATE backlogs SET posts = ? WHERE id = ?").run(posts, id);
    return id;
  });
}

/**
 * Posts sorted before, asked again as one backlog (the Sources screen's "Try again for all"):
 * parked under a new backlog already marked Sort now. Its id.
 */
export function parkAgain(label: string, signalIds: number[], now = new Date()): number {
  return tx(() => {
    const d = open();
    const { id } = d
      .query(
        "INSERT INTO backlogs (file, posts, created_at, requested_at, stage) VALUES (?, ?, ?, ?, 'links') RETURNING id",
      )
      .get(label, signalIds.length, now.toISOString(), now.toISOString()) as { id: number };
    const mark = d.query(
      "UPDATE signals SET classify_tries = ?, backlog_id = ? WHERE id = ? AND company_id IS NULL",
    );
    for (const s of signalIds) mark.run(PARKED, id, s);
    return id;
  });
}

/** Stop a backlog not sent yet: its parked posts go back to how they were sorted before. */
export function unpark(id: number, prev: Record<number, number>): void {
  tx(() => {
    const d = open();
    const b = get(id);
    if (!b || (b.stage !== "links" && b.stage !== "waiting")) return;
    const back = d.query("UPDATE signals SET classify_tries = ? WHERE id = ? AND classify_tries = ?");
    for (const s of parkedPosts(id)) back.run(prev[s.id] ?? 0, s.id, PARKED);
    d.query("UPDATE signals SET backlog_id = NULL WHERE backlog_id = ?").run(id);
    d.query("DELETE FROM backlogs WHERE id = ?").run(id);
  });
}

/** Sort now: the next tick starts on it. False when it isn't waiting. */
export function requestSort(id: number, now = new Date()): boolean {
  return (
    open()
      .query("UPDATE backlogs SET stage = 'links', requested_at = ? WHERE id = ? AND stage = 'waiting'")
      .run(now.toISOString(), id).changes > 0
  );
}

/**
 * What sorting the posts still parked should cost, by batch (half price): about (the system
 * prompt cached, a short answer, as the X bookmarks went) and at most (nothing cached, long answers).
 */
export function costOf(id: number): { about: number; most: number } {
  const r = open()
    .query(
      `SELECT count(*) AS n, coalesce(sum(length(url) + length(coalesce(text, '')) + length(coalesce(author, ''))
         + length(coalesce(note, ''))), 0) AS chars
       FROM signals WHERE backlog_id = ? AND classify_tries = ? AND company_id IS NULL`,
    )
    .get(id, PARKED) as { n: number; chars: number };
  const model = loadConfig().models.small;
  // About 4 characters a token; each message adds its own labels ("URL: ", "Text:").
  const system = (r.n * SYSTEM.length) / 4;
  const user = (r.chars + 40 * r.n) / 4;
  return {
    about:
      modelCost(model, { cache_read_input_tokens: system, input_tokens: user, output_tokens: 40 * r.n }) / 2,
    most: modelCost(model, { input_tokens: system + user, output_tokens: 300 * r.n }) / 2,
  };
}

// ---------------------------------------------------------------------------------------------
// Links

const TCO = /https:\/\/t\.co\/[A-Za-z0-9]+/g;
const MEDIA_PAGE =
  /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+\/(?:photo|video)\/\d+/i;

/** Where a link lands: its redirects followed without reading bodies, up to 5 hops, 10 s each. */
export async function follow(url: string): Promise<string> {
  let at = url;
  try {
    for (let hops = 0; hops < 5; hops++) {
      // Each address is checked before it is asked, by name and by where the name points.
      if (!isPublicUrl(at) || isLinkedIn(at)) return at; // named, never asked (LinkedIn is never read)
      await assertPublicHost(new URL(at).hostname);
      const r = await fetch(at, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "Mozilla/5.0 (compatible; jobsignal/1)" },
      });
      const loc = r.headers.get("location");
      await r.body?.cancel().catch(() => {});
      if (r.status < 300 || r.status >= 400 || !loc) return at;
      at = new URL(loc, at).toString();
    }
  } catch {}
  return at;
}

/** A post's text with each t.co link replaced by where it lands; an X photo or video page is "[media]". */
export function expandLinks(text: string, landed: Map<string, string>): string {
  return text.replace(TCO, (u) => {
    const to = landed.get(u) ?? u;
    return MEDIA_PAGE.test(to) ? "[media]" : to;
  });
}

/** Follow the links in the backlog's posts, 50 posts at a time, a few links at once. True once all are done. */
async function followLinks(b: Backlog, follow: Deps["follow"], until: number): Promise<boolean> {
  let cursor = b.link_cursor;
  for (;;) {
    const rows = open()
      .query("SELECT id, text FROM signals WHERE backlog_id = ? AND id > ? ORDER BY id LIMIT 50")
      .all(b.id, cursor) as { id: number; text: string | null }[];
    if (!rows.length) return true;
    if (Date.now() > until) return false;
    const todo = [...new Set(rows.flatMap((r) => r.text?.match(TCO) ?? []))];
    const landed = new Map<string, string>();
    const worker = async () => {
      for (let u = todo.pop(); u; u = todo.pop()) landed.set(u, await follow(u));
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    cursor = rows.at(-1)!.id;
    tx(() => {
      const write = open().query("UPDATE signals SET text = ? WHERE id = ?");
      for (const r of rows) {
        const text = r.text && expandLinks(r.text, landed);
        if (text !== r.text) write.run(text, r.id);
      }
      open().query("UPDATE backlogs SET link_cursor = ? WHERE id = ?").run(cursor, b.id);
    });
    say(b.id);
  }
}

// ---------------------------------------------------------------------------------------------
// The batch

/** Send the parked posts as one batch, within the cap. False when it can't yet (no model, past the cap). */
async function send(b: Backlog, batches: Batches): Promise<boolean> {
  await firstLook(); // where it goes (the subscription or the key) follows the real connection
  if (!canSend(b.id)) return false;
  const posts = parkedPosts(b.id);
  if (!posts.length) {
    open().query("UPDATE backlogs SET stage = 'filing' WHERE id = ?").run(b.id);
    return true;
  }
  const model = loadConfig().models.small;
  const id = await batches.send(
    posts.map((s) => ({
      custom_id: String(s.id),
      params: {
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text" as const, text: SYSTEM, cache_control: { type: "ephemeral" as const } }],
        messages: [{ role: "user" as const, content: userMessage(inputOf(s)) }],
        output_config: { effort: "low" as const, format: { type: "json_schema" as const, schema: SCHEMA } },
      },
    })),
  );
  open().query("UPDATE backlogs SET stage = 'sent', batch_id = ? WHERE id = ?").run(id, b.id);
  return true;
}

type Tokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** The good answers by signal id, and what the batch used. Cut off, refused or unreadable counts as failed. */
async function readResults(id: string, batches: Batches) {
  const answers = new Map<number, Answer>();
  const usage: Tokens = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for await (const r of await batches.results(id)) {
    if (r.result.type !== "succeeded") continue;
    const m = r.result.message;
    for (const k of Object.keys(usage) as (keyof Tokens)[]) usage[k] += m.usage[k] ?? 0;
    const text = m.content.find((x) => x.type === "text");
    if (m.stop_reason === "max_tokens" || m.stop_reason === "refusal" || text?.type !== "text") continue;
    try {
      const a = JSON.parse(text.text) as Answer;
      if (LABELS.includes(a.signal)) answers.set(Number(r.custom_id), a);
    } catch {}
  }
  return { answers, usage };
}

/**
 * The domain each name is filed under: the one its company already has, else the one most of
 * its posts give. A name stated with a second domain (OpenAI with chatgpt.com, Meta with
 * meta.com) would otherwise become a second company of that name.
 */
export function domainsByName(ds: Decision[]): Map<string, string> {
  const seen = new Map<string, { name: string; n: Map<string, number> }>();
  for (const d of ds) {
    if (d.state !== "file" || !d.domain) continue;
    const k = nameKey(d.name);
    const g = seen.get(k) ?? { name: d.name, n: new Map<string, number>() };
    g.n.set(d.domain, (g.n.get(d.domain) ?? 0) + 1);
    seen.set(k, g);
  }
  const out = new Map<string, string>();
  for (const [k, g] of seen)
    out.set(k, companyByName(g.name)?.domain ?? [...g.n].sort((a, b) => b[1] - a[1])[0]![0]);
  return out;
}

/**
 * File the answers as the nightly run would. Hiring posts go last and, within each, the oldest
 * post first, a millisecond apart: discovery (newest last_signal_at first) starts with the newest
 * hiring posts. A post already placed is left alone but still counted, so a rerun says the same.
 */
function fileAnswers(id: number, answers: Map<number, Answer>, now: Date) {
  const posts = open().query("SELECT * FROM signals WHERE backlog_id = ?").all(id) as Signal[];
  const rows = posts
    .filter((s) => answers.has(s.id))
    .map((s) => ({
      s,
      hiring: answers.get(s.id)!.signal === "hiring",
      d: check(inputOf(s), answers.get(s.id)!),
    }))
    .sort(
      (a, b) =>
        Number(a.hiring) - Number(b.hiring) ||
        a.s.received_at.localeCompare(b.s.received_at) ||
        a.s.id - b.s.id,
    );
  const domains = domainsByName(rows.map((r) => r.d.decision));
  const n = { file: 0, unknown: 0, answered: 0 };
  rows.forEach(({ s, d: { decision } }, i) => {
    const d =
      decision.state === "file" && decision.domain
        ? { ...decision, domain: domains.get(nameKey(decision.name))! }
        : decision;
    if (s.company_id === null && s.classify_tries === PARKED)
      try {
        place(s.id, d, new Date(now.getTime() + i));
      } catch (err) {
        failure("job", "drop-backlog", err);
        return; // still parked: back to the nightly classifier with the failed ones
      }
    n[d.state]++;
  });
  return n;
}

/** File the batch's answers, send what failed back to the nightly classifier, and record the cost once. */
async function finish(b: Backlog, batches: Batches, now: Date): Promise<void> {
  const d = open();
  // A backlog is old news: each post is dated by its post, so the Inbox (three weeks back from
  // received_at) doesn't take it as new.
  d.query("UPDATE signals SET received_at = coalesce(posted_at, received_at) WHERE backlog_id = ?").run(b.id);
  const { answers, usage } = b.batch_id
    ? await readResults(b.batch_id, batches)
    : { answers: new Map<number, Answer>(), usage: null };
  const n = fileAnswers(b.id, answers, now);
  const model = loadConfig().models.small;
  // Message Batches are half price; the subscription's answers carry no usage and cost nothing real.
  const usd = usage ? modelCost(model, usage) / 2 : 0;
  const note = `drop backlog ${b.id} batch ${b.batch_id}`;
  if (usage && usd > 0 && !entries().some((e) => e.note === note))
    record({ kind: "model", station: "classify", model, usd, usage, note });
  tx(() => {
    const failed = d
      .query(
        "UPDATE signals SET classify_tries = 0 WHERE backlog_id = ? AND classify_tries = ? AND company_id IS NULL",
      )
      .run(b.id, PARKED).changes;
    const outcome: Outcome = { ...n, failed, usd };
    d.query("UPDATE backlogs SET stage = 'done', done_at = ?, outcome = ? WHERE id = ?").run(
      now.toISOString(),
      JSON.stringify(outcome),
      b.id,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// The tick's step

/** One backlog as far as it can go now: links, then the batch, then (once it has ended) filing. */
async function advance(id: number, deps: Deps, now: Date): Promise<void> {
  let b = get(id)!;
  if (b.stage === "links") {
    say(id);
    if (!(await followLinks(b, deps.follow, Date.now() + LINK_SECONDS * 1000))) return;
    if (!(await send(get(id)!, deps.batches))) return;
    b = get(id)!;
  }
  if (b.stage === "sent") {
    if (!(await deps.batches.ended(b.batch_id!))) return;
    open().query("UPDATE backlogs SET stage = 'filing' WHERE id = ?").run(id);
    b = get(id)!;
  }
  if (b.stage === "filing") {
    say(id);
    await finish(b, deps.batches, now);
  }
}

/** Every backlog Sort now was pressed on, each moved on as far as it goes. What the rail says of them. */
export async function sortBacklogs(
  deps: Deps = { batches: modelBatches, follow },
  now = new Date(),
): Promise<string | undefined> {
  const ids = (
    open().query("SELECT id FROM backlogs WHERE stage IN ('links', 'sent', 'filing') ORDER BY id").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
  for (const id of ids) await advance(id, deps, now);
  return ids.map((id) => lineOf(get(id)!).line).join("; ") || undefined;
}

// ---------------------------------------------------------------------------------------------
// The rail

export type BacklogLine = { id: number; line: string; sort: boolean };

const num = (x: number) => x.toLocaleString("en-US");
const usd = (x: number) => `$${Math.max(x, 0.01).toFixed(2)}`;
const NEEDS_MODEL = `needs a model: ${CONNECT_MODEL}`;

function lineOf(b: Backlog): BacklogLine {
  const posts = `${num(b.posts)} posts from ${b.file}`;
  const line = (text: string, sort = false) => ({ id: b.id, line: text, sort });
  const sorting = `Sorting ${posts}`;
  switch (b.stage) {
    case "waiting": {
      const via = connection();
      if (!via) return line(`${posts} are waiting. Sorting them ${NEEDS_MODEL}`);
      if (via === "subscription")
        return line(`${posts} are waiting. Sort them on your Claude Code subscription (no charge)`, true);
      const cost = costOf(b.id);
      if (!canSpend(cost.most))
        return line(
          `${posts} are waiting. Sorting them may cost up to ${usd(cost.most)}, past this month's cap`,
        );
      return line(`${posts} are waiting. Sort them for about ${usd(cost.about)}`, true);
    }
    case "links": {
      if (!b.link_cursor) return line(`${sorting}: starts with the next tick, within 15 minutes`);
      const done = (
        open()
          .query("SELECT count(*) AS n FROM signals WHERE backlog_id = ? AND id <= ?")
          .get(b.id, b.link_cursor) as { n: number }
      ).n;
      if (done < b.posts) return line(`${sorting}: following links (${num(done)} of ${num(b.posts)})`);
      if (!connection()) return line(`${sorting}: ${NEEDS_MODEL}`);
      if (!canSend(b.id)) return line(`${sorting}: past this month's cap, waits for next month`);
      return line(`${sorting}: sending to the model`);
    }
    case "sent": {
      if (!b.batch_id?.startsWith(LOCAL))
        return line(`${sorting}: sent to the model, waiting for its answers`);
      const n = jsonl(localFile(b.batch_id, "answers")).length;
      return line(`${sorting}: on your subscription, ${num(n)} of ${num(b.posts)} asked`);
    }
    case "filing":
      return line(`${sorting}: filing`);
    case "done": {
      const o = JSON.parse(b.outcome ?? "{}") as Outcome;
      return line(
        [
          `${b.file}: filed ${num(o.file)}`,
          `${num(o.unknown)} company unknown`,
          `${num(o.answered)} not a signal`,
          o.failed > 0 && `${num(o.failed)} back to the nightly classifier`,
          usd(o.usd),
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
  }
}

/** The tick's progress, on the rail: the backlog's line as the Intake agent's. */
function say(id: number): void {
  setAgent("intake", "working", lineOf(get(id)!).line);
}

/** What the rail says of each backlog not done, and of those done in the last week. */
export function backlogLines(now = new Date()): BacklogLine[] {
  const week = new Date(now.getTime() - 7 * DAY).toISOString();
  return (
    open()
      .query("SELECT * FROM backlogs WHERE stage != 'done' OR done_at >= ? ORDER BY id")
      .all(week) as Backlog[]
  ).map(lineOf);
}

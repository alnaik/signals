// jobsignal.db: companies, their boards and roles, and every signal as received. The one store
// the tick, the server and the CLI all write; SQLite (WAL, busy timeout) does the locking.
// Not index.db: that file is a cache of the thread folders, dropped and rebuilt when its
// version changes. These tables are the record itself, so they live apart and are only ever
// migrated forward.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.ts";

let db: Database | null = null;
let dbPath = "";

export const dbFile = () => path.join(dataDir(), "jobsignal.db");

// Each entry moves the schema one version forward; never edit a shipped one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  -- A company. Its domain is an attribute, not its key: fixing one is one UPDATE.
  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT UNIQUE,
    created_at TEXT NOT NULL,
    last_signal_at TEXT,
    watched_at TEXT,
    watch_sources TEXT,          -- JSON list: manual (Add), inbox (Watch), past, ...
    dismissed_at TEXT,           -- Dismiss on the company: it and whatever it posts later
    apply_email TEXT,            -- JSON {address, page}: takes applications by email
    funding TEXT,                -- JSON {form, date, url, cik}: its last Form D
    careers_url TEXT,            -- the careers page discovery saw
    discovery TEXT,              -- queued | found | none
    discovery_at TEXT,           -- the last look
    discovery_note TEXT          -- how it was found, or why nothing was
  );
  CREATE INDEX companies_discovery ON companies(discovery, discovery_at);

  -- Every name a company goes by, normalized: six alerts naming Amazon land on one row.
  CREATE TABLE company_names (
    name_key TEXT PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id)
  );
  CREATE INDEX company_names_company ON company_names(company_id);

  CREATE TABLE boards (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id),
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,    -- provider:slug, however the link is written
    status TEXT NOT NULL DEFAULT 'ok',   -- ok | broken
    partial INTEGER NOT NULL DEFAULT 0,  -- read through its own search, not whole
    found_by TEXT,
    list_hash TEXT,
    etag TEXT,
    last_modified TEXT,
    last_read_at TEXT,
    next_read_at TEXT,
    fails INTEGER NOT NULL DEFAULT 0,
    role_count INTEGER,
    lease_until TEXT,            -- a read in progress: never two at once
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX boards_company ON boards(company_id);
  CREATE INDEX boards_due ON boards(status, next_read_at);

  CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    company_id INTEGER NOT NULL REFERENCES companies(id),
    ext_id TEXT,                 -- the board's own id; null until a read names it (imported rows)
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'unknown',
    posted_at TEXT,
    updated_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    misses INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT,
    reposted TEXT,               -- first seen of the same role, closed before this one came
    fits INTEGER NOT NULL DEFAULT 0,
    matched TEXT,                -- what in the filters it matched
    state TEXT NOT NULL DEFAULT 'new',   -- new | dismissed | applied | archived
    state_at TEXT,
    UNIQUE (board_id, ext_id)
  );
  CREATE INDEX roles_inbox ON roles(company_id, first_seen)
    WHERE state = 'new' AND fits = 1 AND closed_at IS NULL;
  CREATE INDEX roles_open ON roles(board_id) WHERE closed_at IS NULL;
  CREATE INDEX roles_company ON roles(company_id, fits);
  CREATE INDEX roles_url ON roles(url);

  CREATE TABLE role_text (
    role_id INTEGER PRIMARY KEY REFERENCES roles(id),
    text TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  -- Every signal as received (an alert, a post, a filing, a bookmark, a drop, an Add).
  CREATE TABLE signals (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_tag TEXT NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    company_id INTEGER REFERENCES companies(id),   -- null: waiting for the classifier
    name TEXT,
    domain TEXT,
    title TEXT,
    location TEXT,
    url TEXT NOT NULL,
    text TEXT,
    author TEXT,
    kind TEXT,
    note TEXT,
    posted_at TEXT,
    received_at TEXT NOT NULL,
    classify_tries INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX signals_company ON signals(company_id, received_at);
  CREATE INDEX signals_received ON signals(received_at);
  `,
  `
  -- discovery gains "unreadable": its careers site was found, but no reader here reads it.
  ALTER TABLE companies ADD COLUMN search_at TEXT;   -- its last web search for a board
  -- Where its domain came from: 'stated' (a signal's own link or post, Form D, Add, a board naming
  -- the site) or 'looked up' (a name-to-domain lookup). A stated domain replaces a looked-up one.
  ALTER TABLE companies ADD COLUMN domain_from TEXT;

  -- Web search results, kept so a company is never searched for twice in 30 days.
  CREATE TABLE web_searches (
    query TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    results TEXT NOT NULL,       -- JSON [{url, title, snippet}]
    at TEXT NOT NULL
  );
  `,
  `
  -- What a board's last read asked it: '' its whole list, else its search terms (JSON). An
  -- undated role is news only on a read that asked the same (refresh.ts, arrives). A board last
  -- searched starts unknown (its search now comes newest first): its next read is the baseline.
  ALTER TABLE boards ADD COLUMN read_terms TEXT;
  UPDATE boards SET read_terms = '' WHERE partial = 0 AND last_read_at IS NOT NULL;
  `,
  `
  -- A big drop, parked: its posts wait outside the nightly classifier until Sort now, then are
  -- sorted by one batch in the tick (dropfolder/backlog.ts).
  CREATE TABLE backlogs (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL,          -- the dropped file's name
    posts INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    requested_at TEXT,           -- Sort now
    stage TEXT NOT NULL DEFAULT 'waiting',   -- waiting | links | sent | filing | done
    link_cursor INTEGER NOT NULL DEFAULT 0,  -- links followed in its posts up to this signal id
    batch_id TEXT,               -- the batch sent: never sent twice
    done_at TEXT,
    outcome TEXT                 -- JSON {file, unknown, answered, failed, usd}
  );
  ALTER TABLE signals ADD COLUMN backlog_id INTEGER REFERENCES backlogs(id);
  CREATE INDEX signals_backlog ON signals(backlog_id) WHERE backlog_id IS NOT NULL;
  `,
  `
  -- A careers page the small model reads (intake/pages.ts): read rendered (1) or from its plain
  -- HTML (0), the hash of its text when the model last read it, and when that was (once a day at
  -- most). discovery gains "blocked": robots.txt refuses the careers page or the board it names.
  ALTER TABLE boards ADD COLUMN render INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE boards ADD COLUMN text_hash TEXT;
  ALTER TABLE boards ADD COLUMN model_at TEXT;
  `,
  `
  -- A board on a host that serves every company (Gem, Moka, JOIN, Jobvite, PageUp, AppliTrack,
  -- Eightfold's app host) was keyed by the host alone, so one company's board stood for all of
  -- them: keyed by the company its path or query names now (ats/reader.ts, TENANT_IN_PATH).
  WITH p AS (
    SELECT id, provider,
      lower(substr(url, 9, instr(substr(url, 9) || '/', '/') - 1)) AS host,
      replace(substr(url, 9 + instr(substr(url, 9) || '/', '/')), '?', '/') || '/' AS rest
    FROM boards WHERE url LIKE 'https://%'
  ), s AS (
    SELECT id, provider, host, substr(rest, 1, instr(rest, '/') - 1) AS s1,
      substr(rest, instr(rest, '/') + 1) AS r2
    FROM p
  ), t AS (
    SELECT id, provider, host, CASE
      WHEN host IN ('jobs.gem.com', 'jobs.jobvite.com', 'careers.pageuppeople.com', 'www.applitrack.com', 'applitrack.com') THEN s1
      WHEN host = 'mokahr.com' OR host LIKE '%.mokahr.com' THEN substr(r2, 1, instr(r2, '/') - 1)
      WHEN host = 'join.com' AND s1 = 'companies' THEN substr(r2, 1, instr(r2, '/') - 1)
    END AS tenant
    FROM s
  )
  UPDATE boards SET key = lower(t.provider || ':' || t.host || '/' || t.tenant)
  FROM t WHERE boards.id = t.id AND t.tenant <> '';
  UPDATE boards SET key = lower('eightfold:app.eightfold.ai/' ||
      substr(substr(url, instr(url, 'domain=') + 7) || '&', 1, instr(substr(url, instr(url, 'domain=') + 7) || '&', '&') - 1))
  WHERE url LIKE 'https://app.eightfold.ai/%domain=%';
  `,
  `
  -- A careers page read from the sitemap its robots.txt names (ats/sitemap.ts): that sitemap's
  -- address, "none <when checked>" (checked again after 30 days), or null: not checked yet.
  ALTER TABLE boards ADD COLUMN sitemap TEXT;
  `,
  `
  -- A careers page read from its sitemap: the listed pages read with no role on them (gone, or not
  -- a role's page), JSON {page: {at, n}}: each tried again after a day, then twice as long each time.
  ALTER TABLE boards ADD COLUMN sitemap_misses TEXT;
  `,
  `
  -- A paid provider's raw answers, kept so the same question isn't paid for twice
  -- (providers/kept.ts): Context.dev's People Search and People Enrich.
  CREATE TABLE provider_answers (
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,          -- what was asked: people-search, people-enrich
    key TEXT NOT NULL,           -- the question, lower case, single spaces
    answer TEXT NOT NULL,        -- JSON: the response as received
    at TEXT NOT NULL,
    PRIMARY KEY (provider, kind, key)
  );
  `,
  `
  -- The roles you decided on (applied, dismissed), by company: the Inbox asks each recent
  -- signal's company for its latest decision (inbox/query.ts afterDecided), on every list read.
  CREATE INDEX roles_decided ON roles(company_id, state_at) WHERE state IN ('applied', 'dismissed');
  `,
  `
  -- An Ashby board whose company turned Ashby's hosted pages off (intake/refresh.ts ownPages): the
  -- company's own careers page as Ashby states it, "" while the hosted pages are on, null: not
  -- checked yet; and when it was checked (weekly).
  ALTER TABLE boards ADD COLUMN own_page TEXT;
  ALTER TABLE boards ADD COLUMN own_page_at TEXT;
  `,
  `
  -- Hide on the Signals screen (signals/query.ts): the company leaves that list only; a role that
  -- fits later still reaches the Inbox. Dismiss stays the company's own (dismissed_at).
  ALTER TABLE companies ADD COLUMN hidden_at TEXT;
  -- What the Signals screen asks of each company: its open roles, those that fit, its near misses.
  CREATE INDEX roles_open_company ON roles(company_id, fits, matched) WHERE closed_at IS NULL;
  `,
  `
  -- When a signal reached you. received_at is a post's own date for posts that came from a file
  -- or the earlier app (X bookmarks back to 2017, filed on one day), so it can't say. Signals are
  -- numbered as they are recorded: each one before this is given the latest date any signal up to
  -- it was received, which is its own for one recorded as it came in.
  ALTER TABLE signals ADD COLUMN arrived_at TEXT;
  UPDATE signals SET arrived_at = m.a
    FROM (SELECT id, max(received_at) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS a FROM signals) m
    WHERE m.id = signals.id;
  `,
  `
  -- Look up (lookup/lookup.ts): a person's email, or the people at a company, asked by hand and
  -- run in the server; nothing reaches a thread until Save. The last 50 are kept, and the emails
  -- they found 30 days unless saved to a thread.
  CREATE TABLE lookups (
    id INTEGER PRIMARY KEY,
    mode TEXT NOT NULL,          -- person | people
    inputs TEXT NOT NULL,        -- JSON: what was typed
    status TEXT NOT NULL,        -- running | done | failed
    results TEXT,                -- JSON {company, people: [{name, role, hits, saved}], error}
    usd REAL NOT NULL DEFAULT 0, -- what its presses cost
    started_at TEXT NOT NULL,
    finished_at TEXT,
    seen_at TEXT                 -- shown in the panel once finished
  );
  `,
  `
  -- Review titles (ats/filters.ts reviewOf): a role in your places that names a job and has none
  -- of your title words, by its group ("Data Engineer + science", "security engineer"); null
  -- otherwise. Filled by the rescore SCORE_RULES 6 brings.
  ALTER TABLE roles ADD COLUMN review TEXT;
  CREATE INDEX roles_review ON roles(review) WHERE closed_at IS NULL AND fits = 0 AND review IS NOT NULL;
  -- When an open role started to fit after it was first seen (a title word added, the title rules
  -- changed, its place read from its page): the Inbox counts it new from then (inbox/query.ts
  -- cameAt). Null while it fits from the start, and for every role that fit before this.
  ALTER TABLE roles ADD COLUMN fit_at TEXT;
  `,
];

// The meta keys the one-time repairs set once they ran (intake/repair.ts, sources/hn/index.ts).
const REPAIRS = ["repair:discovery-search", "repair:hn-seekers"];

export function open(): Database {
  const file = dbFile();
  if (db && dbPath === file) return db;
  db?.close();
  mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db!.exec(MIGRATIONS[v]!);
      // A database made new holds nothing an older version stored: its one-time repairs are done.
      if (v === 0)
        for (const key of REPAIRS)
          db!.query("INSERT INTO meta (key, value) VALUES (?, 'new database')").run(key);
      db!.exec(`PRAGMA user_version = ${v + 1}`);
    }).immediate();
  }
  dbPath = file;
  return db;
}

export function close(): void {
  db?.close();
  db = null;
  dbPath = "";
}

/** One write transaction, taken at once (BEGIN IMMEDIATE) so two writers queue instead of failing. */
export function tx<T>(fn: () => T): T {
  return open().transaction(fn).immediate();
}

export function getMeta(key: string): string | null {
  const r = open().query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  open()
    .query(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/**
 * Intake changed what the Inbox shows (a read, a signal). The server's watcher compares this
 * mark, not the file: the board's own clicks don't move it, so they don't refetch the whole page.
 */
export function markChanged(now = new Date()): void {
  setMeta("intake_changed_at", now.toISOString());
}

export const DAY = 86_400_000;

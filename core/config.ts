// config.toml in the data folder: provider order, caps, schedule, paths.
// Missing keys fall back to these defaults, so an empty file is a valid config.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./paths.ts";

export const DEFAULTS = {
  postings: { max_age_days: 10 },
  // Real money only. month_usd: every paid provider (and the model, on an API key) together,
  // per calendar month; past it, paid steps are skipped and runs go on with what's free.
  // run_provider_usd: one Work run's paid lookups; run_usd: its model run, on an API key (a run
  // costs a few cents: a hung one that is stopped is counted at this, not at the month's rest).
  // run_minutes stops a hung run. pages_month_usd:
  // the small model reading careers pages no reader reads (ats/read-page.ts), inside month_usd.
  // background_day: on a Claude subscription, the small model's background calls a day (not
  // money: they draw on the plan); past it they wait until tomorrow. Work is never held by it.
  caps: {
    month_usd: 5,
    run_provider_usd: 0.15,
    run_usd: 0.5,
    run_minutes: 20,
    pages_month_usd: 3,
    background_day: 300,
  },
  models: { worker: "claude-sonnet-5-5", small: "claude-haiku-5-5" },
  runner: {
    mode: "claude-code-subscription" as "claude-code-subscription" | "claude-code-api-key" | "agent-sdk",
  },
  schedule: { night_start: "01:00", night_end: "06:00" },
  polling: { per_host_rps: 1, user_agent: "JobSignal/0.1 (personal job search; contact via repo)" },
  // robots.txt is honoured everywhere except these URL prefixes; each use is logged.
  robots: {
    exceptions: [
      {
        prefix: "https://app.dover.com/api/v1/careers-page/",
        reason: "the public careers page's own request, a few per company per day",
      },
      {
        prefix: "https://app.dover.com/api/v1/inbound/application-portal-job/",
        reason: "the public posting page's own request; it then calls careers-page/<uuid>/jobs",
      },
    ] as { prefix: string; reason: string }[],
  },
  providers: {
    search: ["contextdev", "exa"],
    read: ["contextdev", "crawl4ai", "public"],
    people: ["contextdev", "github", "exa"],
    // Free first: Exa (paid per lookup) only runs when nothing before it verified an email.
    // Context.dev isn't asked: its People Enrich finds the person but gives no email (0 of 113).
    contact: ["github", "hunter", "exa", "pattern"],
  } as Record<string, string[]>,
  // Finding a company's board (intake/discover.ts, intake/search.ts). Web search is its last
  // step: on by default, at most search_daily companies a day, Exa (paid) only inside
  // exa_month_usd. Each company gets company_seconds; a tick gives discovery tick_seconds, beside
  // the board reads, and what's left waits for the next tick, or for a batch run the person starts
  // on Sources (intake/batch.ts), which has no time limit.
  discovery: {
    search: true,
    search_daily: 50,
    exa_month_usd: 10,
    company_seconds: 20,
    tick_seconds: 120,
  },
  // biome-ignore lint/suspicious/noExplicitAny: free-form per-provider and per-source settings
  provider: {} as Record<string, Record<string, any>>,
  // Weekly on Mondays (from the 01:00 night window), off until `on = true`; board search's own
  // Context.dev credit limits (see the source file).
  source: {
    "board-search": { day: "monday", every_hours: 168, run_credits: 112, month_credits: 500 },
    // Fund portals: weekly on Tuesdays; the ticked funds are `picks`.
    funds: { day: "tuesday", every_hours: 168 },
    // biome-ignore lint/suspicious/noExplicitAny: free-form per-source settings
  } as Record<string, Record<string, any>>,
};

export type Config = typeof DEFAULTS;

function merge<T>(base: T, over: unknown): T {
  if (typeof over !== "object" || over === null || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

export function loadConfig(): Config {
  const file = paths.config();
  if (!existsSync(file)) return DEFAULTS;
  return merge(DEFAULTS, Bun.TOML.parse(readFileSync(file, "utf8")));
}

export const STARTER = `# Job Signal settings. Anything left out uses the defaults.

[caps]
month_usd = 5.00        # real money, all paid providers together, per month; past it, paid steps are skipped
run_provider_usd = 0.15 # paid lookups per Work run; past it, free providers only
pages_month_usd = 3.00  # the small model reading careers pages no reader reads; past it, those pages wait

[robots]
# robots.txt is honoured except under these prefixes (each use goes to logs/failures.jsonl).
exceptions = [
  { prefix = "https://app.dover.com/api/v1/careers-page/", reason = "the public careers page's own request, a few per company per day" },
  { prefix = "https://app.dover.com/api/v1/inbound/application-portal-job/", reason = "the public posting page's own request; it then calls careers-page/<uuid>/jobs" },
]

[providers]
# Waterfall order per capability; the first confident result wins.
search = ["contextdev", "exa"]
read = ["contextdev", "crawl4ai", "public"]
people = ["contextdev", "github", "exa"]
contact = ["github", "hunter", "exa", "pattern"]

[discovery]
search = true        # web search, the last step of finding a company's board (the [providers] search order)
search_daily = 50    # companies searched a day at most
exa_month_usd = 10   # Exa's free tier: past it Exa isn't asked
# tick_seconds = 120     # discovery's time in each 15-minute read

# [provider.exa]
# cost = { search = 0.007, people = 0.007, contact = 0.045 }   # overrides the price in the provider file
`;

export function writeStarterConfig(): void {
  if (!existsSync(paths.config())) writeFileSync(paths.config(), STARTER);
}

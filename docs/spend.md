# Spend

Job Signal pays for a model only where judgment is needed, and caps real money only:

| Station | Model | When |
| --- | --- | --- |
| Work | Sonnet, one run per press, at most 12 turns; presses during a run go back to back after it | when you press Work |
| Work on a company with no known website (`discover-domain`) | Haiku, two calls, and one web search plus one company search (cached 30 days), after the free checks (its Ashby board, its posts) | when you press Work on it, and when discovery looks up the website of a company that came with a board (once, again after 30 days, within `search_daily`) |
| Lead classification, link-check paraphrase | Haiku, one call each | nightly |
| Unknown drop-file formats | Haiku, once per new format | when the file lands |
| Discovery's web-search pick (`discover-pick`) | Haiku, one call per company searched | when discovery searches |
| Board search's employer check (`board-search-employer`) | Haiku, one call per board whose company would be new (is it the employer, an agency or a job board?), and per Workday board (the same call names the employer from the posting's words: Workday gives only a payroll entity), kept | when board search runs |
| Board search's web searches | none: one search per city × board host on the first web search connected, in the `[providers]` search order; `run_credits` (112) a run and `month_credits` (500) a month, counted in searches (Settings > Spend sets it) | weekly, when switched on |
| Look up (`lookup`) | none: your own providers, in the `[providers]` contact order (Find a person, Find email) or people order (People at a company); each press says the most it can cost first and runs with that as its own budget, apart from Work's; inside `month_usd` | when you press Run or Find email in Look up (top bar, or Find an email on a thread) |
| Careers-page reader (`read-page`) | Haiku, one call per careers page no reader reads, again only when its text changes and at most once a day; its own cap `pages_month_usd` ($3) | when discovery or a refresh reads such a page |

Every model step runs on whichever connection there is: a signed-in Claude Code subscription
or the Anthropic API key (`[runner] mode` picks when both are). On the subscription the model
costs nothing extra and isn't counted; the ledger keeps what it would have cost, for your own
interest. Paid lookups (Exa, Context.dev, Hunter
past its free 50, X post reads) are the spend.

- **Per month**: `month_usd` ($5) covers every paid provider together. Past it, paid steps are
  skipped, free ones still run, and the thread says what was skipped (`Exa skipped · monthly cap`).
  A cap never fails a run.
- **Per Work run**: paid lookups stop at `run_provider_usd` ($0.15); after that the run uses only
  the free ones (GitHub, public pages, the certificate log, HN, email patterns).
- **Stuck runs**: a run still going after `run_minutes` (20) is stopped.
- **Background checks on the subscription**: the small model's background calls (sorting posts,
  finding websites and boards, reading careers pages) draw on your plan. `background_day` (300) is
  how many a day; past it they wait until tomorrow. Work you start yourself is never held by it.
  The Sources screen shows today's count; Settings > Spend sets the limit.
- **With an API key** instead of the subscription, model spend is real and counts against the same
  `month_usd`; each Work run gets `--max-budget-usd` of its own share, `run_usd` ($0.50), or
  what's left of the month when that is less.
- **Providers**: each records its cost per call; set the X developer account's spend limit too.

## What each lookup provider costs

From each provider's pricing page, checked 12 Nov 2026, for what Job Signal calls (Settings >
Keys shows the same line beside each key, from `price` in `providers/<name>.ts`):

| Provider | Free each month | One use |
| --- | --- | --- |
| Context.dev | 1,000 credits; 10 requests a minute | web search or page read 1 credit, company lookup 2, people search 10; a credit is $0.002 on the $20 plan of 10,000 |
| Parallel | $5 with a card on file | web search $0.005 (basic mode, the default; turbo and fast are $0.001); people or email lookup $0.01 (a Task run on the base processor) |
| Exa | $10, no card | web search about $0.007 (Exa reports each call's cost); page read $0.001 |
| Firecrawl | 1,000 credits | web search 2 credits (about $0.008 on the $19 plan of 5,000); page read 1 |
| Hunter | 50 credits | one credit per email found, none when it finds nothing (about $0.025 on the $49 plan of 2,000) |

Context.dev is the only one that covers everything Job Signal asks for, and after the free
allowance the cheapest web search as called; Parallel's search would be cheaper in its fast mode
(`[provider.parallel] search_mode = "fast"`).

Settings (**Spend**) and `jobsignal spend` show one row per service, by station:

- **Context.dev**: its own count (`GET /org/usage`, free), over its own period: credits used
  since its grant day (the 10th), credits left and the next refill. Below it, Job Signal's count
  for the same period, and how many more Context.dev counts: ledger rows from before 2026-10-31
  kept no credit count, and scripts run on a copy of the data folder write to that copy's ledger.
- **Exa**: dollars this month as Exa reported each call; a call it gave no cost for is priced
  from the list and counted as estimated.
- **Anthropic API key**: dollars this month, from each call's tokens and `core/prices.ts`.
- **Claude Code subscription**: runs this month, not charged; what they would have cost.
- Any other paid provider (X post reads), then the free lookups as a count of calls.

A call that fails is marked so: an error the provider answered costs nothing (Context.dev
charges a processed 404), a timeout keeps the estimate. Money spent by a script on a copy of the
data folder never reaches this ledger or the monthly cap. `jobsignal report` shows this month
against the cap. Spend is never shown on the Threads screen.
Change caps in `config.toml`:

```toml
[caps]
month_usd = 5.00
run_provider_usd = 0.15
run_minutes = 20
pages_month_usd = 3.00
```

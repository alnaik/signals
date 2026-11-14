# Sources

Every source is optional and fills the Inbox; none adds to your Watchlist. One failing never
stops the rest; after three failures in a row its tile on the Sources screen turns red with the reason.

| Source | How to connect | Runs |
| --- | --- | --- |
| Watched boards | **Add** a company (top bar or Watchlist), or **Apply + Watch** in the Inbox. Greenhouse, Lever, Ashby, Workday, iCIMS, Taleo, SuccessFactors and 80+ more are read through career-ops' providers; a company with no ATS has its own careers page read | every 6 hours, and now on Add |
| Boards table | On, nothing to set up. The app ships with a table of companies and their public job boards and careers pages, as Job Signal itself found them (`ats/boards.csv`; `jobsignal boards export` writes it from an install). A company an alert, a post or a filing names has its board found (that table first, then its own site) and read for 60 days: roles posted in the last 10 days that fit, then new ones; a role seen on LinkedIn takes the board's link when its exact title is there. Boards over 500 roles bring only that role and say how many more fit | every 6 hours |
| X bookmarks (backlog) | Export once with the twitter-web-exporter userscript (JSON) and drop the file into `drop/` | once |
| X bookmarks (ongoing) | Create an X developer app, then `jobsignal x connect` (follow its steps); set a spend limit in the X console | nightly |
| Job mail | Recommended: a spare mailbox that only gets job mail (alerts sent or forwarded there), connected on Sources > Job mail with its IMAP server, address and an app password, never your main mailbox's password. It is opened read-only (EXAMINE, BODY.PEEK): nothing is sent, moved, marked or deleted, and the build fails if the mail code holds any other IMAP command. Or Gmail's read-only label. LinkedIn job alerts and Grok's daily mail (each post checked through the X API, so X must be connected) have their own readers; a forwarded mail is read as the original; other senders are read by the model when one is connected. Only jobs inside your filters come in | every 6 hours |
| Feeds (RSS or Atom) | Paste a feed's address on Sources > Feeds (a Substack's is its address with `/feed`); a16z's jobs newsletter is offered there, off until added. With a model, the small model names every hiring company a new entry is about, with its website when the entry links it; without one, only links to a job board or to a site the link's own text names come in | every 6 hours |
| GitHub stars | Your GitHub username on Sources > GitHub stars, or in first run's Your signals step (no key; the optional GitHub token in Settings > Keys raises GitHub's limit from 60 requests an hour to 5,000). Your public stars are read once in full, a few dozen requests a run, then only new ones. Only a repository an organisation owns counts, never a person's; the organisation comes in as a company when its stated website is its own domain and plain rules don't mark it a foundation, university, community, list or docs project, and, with a model connected, the small model says it is a company that hires (without one, a .org website is left out too). Its homepage still has to confirm the website | every 6 hours |
| HN "Who is hiring" | Nothing to do; set location and title words in setup to keep it focused | every 6 hours |
| Funding (Form D) | Your email in Settings > About you (SEC asks for a contact; `[source.form-d] user_agent` in `config.toml` overrides it) | nightly |
| Fund portals | Tick a fund on the Sources screen. Its job site's companies that are hiring come in once each; the fund names their website, their own homepage has to confirm it. Offered: a16z (its job site's one companies page) and Index Ventures (its companies page and its jobs sitemap; a newly hiring company's website is read once from its page there). Left out because their terms forbid automated reading: Y Combinator (ycombinator.com/jobs and Work at a Startup), and the funds on Consider (Sequoia, USV, Bessemer, Lightspeed) and Getro (Accel, General Catalyst, Khosla) | weekly, Tuesdays |
| Replies | Gmail ([gmail-setup.md](gmail-setup.md)), plus **Got a reply** on the board for any channel | every 6 hours |
| hiring.cafe | Browse by hand; save links as a text file or JSONL in `drop/` | — |
| Instagram | Instagram → Settings → Download your information → JSON; drop `saved_posts.json` | when you export |
| Your own agent | Write JSON Lines into `drop/`, one per line: `{"url": "...", "kind": "post", "source": "muse", "note": "..."}`. Only `url` is required; `note` is a hint, never a fact | any time |
| Past applications | A CSV with Company, Role, Link, Date applied, Status, Notes in `drop/`; or a Google Takeout `.mbox`; or `jobsignal past gmail` | once |

Anything else with links in it (CSV with a URL column, plain text) works in `drop/` too.
Processed files move to `drop/done/`; files it can't read go to `drop/unreadable/`.

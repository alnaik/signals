# Security

## Reporting a problem

Please report a security problem privately, through GitHub: on this repository, open the
**Security** tab and choose **Report a vulnerability**. Don't open a public issue for it.

Say what you found, how to reproduce it, and what it lets someone do. Leave out any real keys,
mail or personal data; invented ones show the problem just as well. You'll get an answer there.

## In scope

- The board and its API on 127.0.0.1 (`server/`), including requests from other web pages
- The Chrome extension (`extension/`) and what it fills
- Anything that reads from the internet: board readers, careers pages, lookup providers, the drop
  folder's link follower, feeds, mail (`core/http.ts`, `ats/`, `providers/`, `sources/`, `mail/`)
- The model steps and Work's locked-down run (`core/model.ts`, `worker/`), including instructions
  hidden in a page or post
- Where keys, tokens and personal data are kept, and anything that could leak them into logs, the
  bug report, the repo or a provider
- The installer (`scripts/install.sh`)

Out of scope: problems that need someone already in control of your Mac or your user account,
and the services Job Signal talks to (report those to them).

## How Job Signal protects you

- **This Mac only.** The board listens on 127.0.0.1. Every API request must name this Mac as its
  host (against DNS rebinding), and a change must come from the board's own page; the extension
  is the one exception, on its own routes, checked by its fixed ID.
- **Keys in the Keychain.** Keys and sign-in tokens live in the macOS Keychain, never in the data
  folder, the logs or the bug report. Job board readers run in a separate process with no keys.
- **No private addresses.** Every page address, each redirect included, is checked to be a
  public one before it is asked. LinkedIn pages are refused by code. robots.txt is honoured.
- **A model with no reach.** The small model has no tools. Work runs Claude Code with no built-in
  tools, no user settings and one tool of its own (write the brief); it can't read files, open
  pages or contact anyone, and it is told that everything it is given came from the web and is
  data.
- **Read-only mail.** A spare mailbox is opened read-only, and the build fails if the mail code
  holds any command that isn't a read. Gmail is asked for read-only access.
- **Nothing is sent for you.** The extension never presses Submit, and Job Signal sends no
  message.

## Known limit

Outside the job board readers, a site's name is looked up once for the public-address check and
again by the request that follows, so a site that switches its address between the two could get
past the check. It is written down beside the check in `core/http.ts` and in the README.

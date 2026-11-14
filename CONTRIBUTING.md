# Contributing

Thank you for wanting to help. A few rules keep Job Signal safe and simple.

- **Pull requests are merged only when the owner approves them.** Please open an issue first for
  anything bigger than a small fix, so we can agree on it before you build it.
- **One change per pull request.** A fix and an unrelated tidy-up are two pull requests.
- **`bun run check` must pass** (lint, typecheck and tests). Add a test when your change guards
  safety, money or data, or fixes a bug; not otherwise.
- **No real personal data in tests or fixtures**: no real person's name, CV, mail or handle, and
  no saved copies of other people's or companies' pages. Invent them.
- **No new network call without the guards.** Read the web only through `politeGet` in
  `core/http.ts` (or the board runner): it checks that the address is public at every redirect,
  honours robots.txt and refuses LinkedIn.
- Write any words people see in plain language: short sentences, no jargon.
- A new dependency needs a reason, an exact version, and `bun audit` clean. Code in `vendor/` is
  not edited here.

## What won't be accepted

These were decided against on purpose:

- A hosted version, an account, or any server other than the one on your own Mac.
- A packaged app. Job Signal installs from this repository.
- Opening the board from a phone or another computer.
- Following X accounts.
- Anything that submits an application, sends a message, or answers a form's legal or voluntary
  questions for you.
- Reading LinkedIn pages, or ignoring a site's robots.txt.
- Fund portals switched on by default, or anything heavy that starts without being asked.
- Turning Job Signal into a high-volume job board: the point is a few focused applications.

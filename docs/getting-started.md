# Getting started

Job Signal runs on your Mac. It reads the boards of the companies you watch, and your other
sources, into an Inbox on a local board. You choose what to apply to and who to write to. You
write and send every message yourself.

## Install

In Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/alnaik/signals/main/scripts/install.sh | bash
```

This installs Bun and Claude Code if you don't have them, gets Job Signal, creates your data
folder (`~/JobSignal`), starts the board and the background schedule, and opens the board at
http://127.0.0.1:4317. The board's first run sets you up to go, in six steps; every step but the
first can be skipped, and each has Back:

1. **About you**: your name, your cities and the title words you want; the rest (email, links,
   work authorisation) later in Settings.
2. **Connect the model**: whether Claude Code is signed in (sign in from Terminal, then Check
   again), or an Anthropic API key. With Claude Code signed in the key box isn't shown: to use a
   key instead, save it later in Settings under Keys and choose it under The model. Skipped, posts
   aren't sorted, careers pages aren't read and Work doesn't run.
3. **A search provider**: one key, each with its free allowance and price (see
   [spend.md](spend.md)). Skipped, companies named in posts can't have their website or job board
   looked up.
4. **Your signals**: Hacker News is already on. Add the websites of companies you already like
   (each one's job board is found and read at once), your GitHub username, a spare mailbox for job
   mail, or X bookmarks; and, if you like, have the job boards of everything the first read brings
   in looked for all at once.
5. **For applying**: drop your CV (one or more PDFs, each with its text file if you like; they go
   into `me/`) and add the form filler to Chrome, with its steps and a mark that turns on once it
   is connected.
6. **Positioning**: the page Work reads, made in a Claude chat with the prompt it gives you.

Finishing opens **Sources**, whose **Start here** lists only what you skipped. Funds are never
offered there: tick one on Sources > Fund portals if you want its hiring companies.

Everything is also in **Settings**: the data folder (a plain folder in your home directory, never
iCloud Drive or Dropbox), About you in full, the model (see [spend.md](spend.md)), keys (each paid
provider is optional; keys go into the macOS Keychain), providers, spend limits and the
positioning page (the first time you press **Work** without one, the thread offers it; **Not now**
lets Work run anyway).

For applying (also in Settings), drop your CV as a PDF; it goes into `me/`. With more than one
PDF there, Apply asks which, once per company. Then drop its text file: a plain `.md` or `.txt`
with the PDF's name, shaped like the example the screen shows. The PDF is attached to forms; the
text file is what is typed into their work history and education, so it should say what the PDF
says. Each CV's row shows what was read from it. A file dropped again replaces the old one, and
Remove takes away both. Then add the Job Signal extension to Chrome, once:
open `chrome://extensions`,
turn on **Developer mode**, click **Load unpacked** and pick `~/.jobsignal-app/extension/dist`
(in the folder picker, Cmd+Shift+. shows hidden folders). It updates itself with the app.
Without it, Apply still opens the form, just unfilled.

## Each day

- **North star**: your goal in one sentence, in the left margin on a wide window (a tab under the
  top bar on a smaller one). Click it and type; Return keeps it. It stays in `me/` on your Mac.
- **Inbox**: companies with new roles that fit you. Per role, **Apply**, **Apply + Watch** or
  **Dismiss**; per company, **Watch** or **Dismiss**. A company with roles that fit but none new
  shows here again when a signal names it. A watched company shows here, marked Watched (with how
  many of its roles are new this week), with the roles first seen since you watched it; **Clear**
  takes them out of the Inbox. Below it, **Everything else**: every other company with a board.
- **Signals**: the companies a signal named that have nothing open that fits you, so they aren't
  in the Inbox: the signals that reached you in the last 90 days, newest first (a bookmark of an
  old post counts from when you filed it), each with its source, the post's date, what it said and
  its link, in three groups:
  - **Hiring, nothing that fits you**: near misses, a role with your title words in a place or a
    way of working that isn't yours. Open a company to see each role and why it doesn't fit;
    **Apply** and **Apply + Watch** work as in the Inbox. Companies hiring only for other kinds of
    work are folded below.
  - **Nothing posted**: no open role (an empty board or careers page, or none found). **Work**
    writes to them anyway: it opens the company's thread and starts Work, its cost said first.
  - **Couldn't be read**: a careers page the app couldn't read. Open it and look yourself, or
    **Try again**.

  Where no board was found or read, **Paste its board** takes its careers page or job board from
  you, as Sources' Board found step does: it's looked at now and its roles read within 15 minutes;
  if one fits you, the company moves to the Inbox. Nothing is searched for.

  Per company: **Work**, **Watch**, **Hide** (off this list only: a role that fits later still
  reaches the Inbox) or **Dismiss** (it and whatever it posts later stay out). Folds at the end:
  older than 90 days; noise set aside without asking (no signal on record, a fund rather than a
  company hiring, a name that names no company, no website known, a website that doesn't answer);
  and the companies you hid, with **Unhide**. Search and the source switch narrow every list.
- **Apply** opens the form in a Chrome tab, filled from your profile, your saved answers and
  the PDF in `me/`; you submit, then press **Done**. What you type there is saved, so the same
  question fills itself on the next form. On any other page, click the extension's button to fill it.
- **Threads**: one per company you acted on. **Work** gathers facts and writes Problem /
  Person / Proof, now, with progress on the row; copy it and write the message yourself, then
  **Mark sent** or **Got a reply**. A role you're done with: **Done** once applied, or **Dismiss**.
- **Watchlist**: the companies you chose. **Add** one by its website, careers page, board or a
  posting; its board is read now.

## Your data

Everything personal is in the data folder; keys and tokens are in the Keychain. Back it up
with Time Machine, or `jobsignal export` for a zip. `jobsignal reindex` rebuilds the board
from the folders if anything looks wrong.

## Commands

`jobsignal` lists them: `serve`, `tick`, `add`, `work`, `report`, `spend`, `providers`, `provider`,
`x connect`, `gmail connect`, `past gmail`, `portfolio`, `migrate`, `export`, `reindex`,
`schedule install|uninstall|status`, `repair offline|boards|name`.

With no internet a read skips itself and counts nothing as failed. A time offline from before that
left boards broken: `jobsignal repair offline <from> <to>` (times in ISO; `--dry` shows the counts
first) reads them again and puts the companies it found nothing for back in line.

`jobsignal repair boards` puts right what `boards export` leaves out of the shipped table: a link
written into a company's name goes, a careers page that is one posting moves to the listing above
it (its roles kept), and a board that is another company's goes, with the company looked for again.
`jobsignal repair name <id> <name>` renames one company. Both take `--dry` to say what they would do.

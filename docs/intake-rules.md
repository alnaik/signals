# Intake rules, in full

For contributors and the very curious: exactly how a signal becomes a company, a website, a job
board and roles, and how the Inbox picks what to show. The plain version is
[how-it-works.md](how-it-works.md). Every rule here is in the code under `intake/`, `ats/` and
`inbox/`; when they disagree, the code is right and this page is out of date.

## Three jobs, one file

Everything the app knows about companies and roles is in one SQLite file in the data folder,
`jobsignal.db` (companies, their names, boards, roles, role text, signals). Threads, `me/`, the
ledger and `config.toml` stay files.

1. **Signals in.** Job mail, HN, X, Form D filings, feeds, fund portals, GitHub stars, board
   search, the drop folder and **Add** each record a signal against a company. A signal is what puts a company in the Inbox.
2. **Discovery, once per company.** Its board is looked for in this order: the board a signal
   links to, the boards table (`ats/boards.csv`, shipped with the app: companies and their public
   job boards and careers pages as Job Signal found them; a local lookup confirmed by one read),
   then the company's own site, then (once, again after 30 days) a web search on the searches
   connected, in the `[providers]` search order (Exa within its monthly cap), at most `[discovery] search_daily` a day, cached in the db. The
   search is one query, `<domain> careers`; the small model, on whichever model connection there is,
   reads the company's posts and the results and picks its own board or careers page, or none.
   Our own readers then read the pick; with no model connected, or past the monthly cap, the company
   waits for another day. A board whose own page states another website is refused, and so is one whose own API or page names another company (a fund's site linked Box's board for a16z); a page that links several companies' boards (a portfolio jobs page) gives only a board bearing the company's name, and a YC
   jobs page, a Notion page or an empty board is kept as its careers page. A careers page on
   another site counts only when that page links back to the company's proven domain and names
   the company in its title or site name (lifeatcanva.com for canva.com).
   A company's domain is set only with proof, and the company says which (`domain_from`): its
   own posts link or email it, its board states it (Ashby names its website), or its homepage
   names the company in its title or site name. It is never a job board's, nor a page on a host
   where people post or link through (foo.substack.com, medium.com/@x, a Notion page); such a
   host itself (substack.com) only for the company that runs it, with proof. A company with
   none gets one web search for its site first (its name and what its posts say of it): the
   small model picks its domain from the results (an address, or a domain a result or a post
   writes out) and the domains its posts give, and the pick needs the same proof; a search hit alone never sets one. With a domain, its own site is
   looked at, then the careers search. A company that came with a board and no website (a board
   search lead) gets the same lookup after those, in the same daily cap, once and again after 30
   days: the website its Ashby board states, one its posts prove, then the site search, whose pick
   must also share a word with its board or its name, and its own careers pages must not give
   another board (flex.com gives Flex Ltd's Workday board; Flex's Greenhouse board is
   getflex.com's). It keeps its board; only the domain is set, and its stand-in thread moves to
   the real one. Two companies become one only on a proven domain (one
   board shared by two companies stays the first's unless their domains are one site).
   Every vendored reader is tried on a careers site and the page picked (a
   branded Avature, Jibe or SuccessFactors site, Google Careers through your saved-search titles,
   a SmartRecruiters posting id; YC company jobs pages, Homerun and Polymer have their own).
   A careers page none of them reads (one its own site gives is sent here directly, with no
   web search first, and once read is not searched for again) is then read, cheapest first: rendered (Playwright, 20
   seconds a page, robots.txt honoured for the page, its frames and its data requests), a job
   board in its links, frames or requests is read by its provider; else the small model
   reads its visible text and links and names its roles, the employer
   they are at, or the board it sends people to. A role is kept only when its title is on the
   page word for word and its link is one of the page's (or a mailto, or the page itself); a page
   that lists several employers' roles, or another company's (a job marketplace), gives none;
   on the company's proven domain or its second site, the one employer a page names is the
   company (Cal.com's "Foundation" is a team). A front page that shows no roles, or a featured
   few, and links to its full listing on the same site has that one page read the same way (a
   board it runs, else the model, when the model reads it whole); what it gives, when more, is
   kept, and its address becomes the careers page read from then on.
   robots.txt refusing the page or its board shows "its site refuses readers · open careers
   page"; a page that is gone sends the company back to discovery; one with no roles is "no
   board found", checked. While the model can't run (no key, past its cap) the pages wait,
   unread. Apple's, Microsoft's
   and one company's roles on Google Careers (DeepMind) are read through their own sites'
   search, by your saved-search titles, newest first. A page counts as a
   careers page only by its address (`/careers`, `/jobs`, `/join-us`, `careers.<domain>`), never
   a home page, help or docs site, forum, store page or article that mentions careers. One that
   lists its roles in its page data (a job list no ATS claims) or names a jobs feed is read as
   the board without a model; one posting under it is not. A list or feed whose roles are at 4 or
   more employers (a fund's job board; a job site's feed, its titles "Engineer @ Acme") is no
   company's: discovery refuses it, and a board that reads as one is out of use from then on,
   its roles closed and its company with no board found, saying whose roles they are. Discovery runs
   beside the board reads, within `[discovery] tick_seconds`; what it doesn't reach waits for
   the next tick. Sources says how many companies wait and offers "Find their boards now": a
   batch run (`jobsignal find-boards`, its own process and lock, `batch.lock`) that looks for
   all of them in one go, inside the same limits, while the ticks go on; the tick skips its
   discovery while one runs. Only the person starts one; Stop ends it after the companies in
   hand, and starting again resumes it.
3. **Refresh.** A board is read about every 6 hours (with jitter) while its company is watched
   or had a signal in the last 60 days, and daily after that (never once dismissed), list only:
   8 at a time, at most 2 per shared ATS host and 1 per company site, backing off on 429/5xx.
   A role closes on its second miss; a failed or suspect read closes nothing; three failures in
   a row mark the board broken and send the company back to discovery. A board too big to read
   whole in about 30 seconds (or whose whole read timed out) is read through its own search
   (partial). A careers page the model read is read daily: from its plain HTML (with its ETag)
   when that showed the same roles at discovery, else rendered (at most 6 a pass). The model
   reads it again only when its text changed, at most once a day, within `[caps]
   pages_month_usd` ($3, part of `month_usd`); until then, and past the cap, it stays as it was.
   After three failed reads (no roles counts) it is read weekly, and after a month with nothing
   its company goes back to discovery. **Refresh** on a
   company, or **Refresh all** with live progress, reads now.

A signal whose company no rule can tell (an X bookmark, an Instagram save, a bare link) waits for
the small model, 50 a night. A drop that leaves more than 150 of them is parked instead: the rail
says how many and about what sorting them costs, with **Sort now**. The tick then sorts them all at
once on your Anthropic API key, within the monthly cap: each post's t.co links are followed, one
batch goes to the small model (half price, about $0.03 per 1,000 posts), and its answers are filed,
dated by their posts so the Inbox doesn't take them as new. What fails goes back to the nightly run.

The **Inbox** pages 50 companies at a time and loads a company's roles when you open it. Dismiss,
Apply and Watch each change one row. A role leaves the Inbox 21 days after it was first seen.
A watched company is in the Inbox, marked Watched, while it has roles that fit first seen since
you watched it (only those count; a signal alone doesn't bring it back); **Clear** takes them out
of the Inbox, still open on its Watchlist page, and it stays watched.
Below it, **Everything else** lists every other company with a board (not watched or dismissed),
the most roles that fit first, to browse and reach out when nothing is new; a company there opens
to all its open roles, those that fit first. The city switch keeps, in both, the companies with an
open role that fits in that city: a city is a group of places, set under **Settings > About you**
(kept as `filters.metros` in `me/profile.json`, e.g. `"Colorado": ["Denver", "Boulder", "CO"]`),
and each part of a role's location is read on its own, so a company hiring in Boulder and San Jose
is under both. A state's two letters match only in capitals ("Co. Dublin" isn't Colorado), and with
American places a part that names another country is that country's ("Cambridge, United Kingdom"
isn't Cambridge, MA); a place that names only the US or how the role is worked ("United States",
"Hybrid") counts as no place given. With no cities, there is no switch. **Remote only** narrows both lists to remote roles.

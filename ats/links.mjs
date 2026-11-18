// Pure link helpers for the ATS runner: no network, no providers, so they can be tested.

/** Every link in a page, absolute, plus board URLs rebuilt from embed snippets. */
export function linksIn(html, base) {
  const out = new Set();
  const add = (u) => {
    try {
      // A URL quoted inside an HTML attribute ends at its encoded quote.
      const clean = u.replace(/&(?:quot|#34|#x22);.*$/i, "");
      const x = new URL(clean.replace(/\\\//g, "/").replace(/&amp;/g, "&"), base);
      if (x.protocol === "https:" || x.protocol === "http:") {
        x.hash = "";
        out.add(x.href);
      }
    } catch {}
  };
  for (const m of html.matchAll(/(?:href|src|data-[\w-]+|action)\s*=\s*["']([^"'\s]+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/https?:(?:\\?\/){2}[^\s"'<>()\\]+(?:\\\/[^\s"'<>()\\]*)*/gi)) add(m[0]);
  // A board's public API, seen as a request when the page builds its job list in JavaScript.
  for (const m of html.matchAll(
    /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)|(?:boards-)?api\.greenhouse\.io\/v1\/boards\/([\w-]+)/gi,
  ))
    add(`https://boards.greenhouse.io/${m[1] ?? m[2]}`);
  for (const m of html.matchAll(/api\.ashbyhq\.com\/posting-api\/job-board\/([\w.-]+)/gi))
    add(`https://jobs.ashbyhq.com/${m[1]}`);
  for (const m of html.matchAll(/api\.lever\.co\/v0\/postings\/([\w.-]+)/gi))
    add(`https://jobs.lever.co/${m[1]}`);
  for (const m of html.matchAll(/ats\.rippling\.com\/embed\/([\w-]+)/gi))
    add(`https://ats.rippling.com/${m[1]}/jobs`);
  // Workable's widget names the account by number (whr_embed(81866, …)) and calls its widget
  // API; career-ops' Workable provider reads both as apply.workable.com/<account>.
  for (const m of html.matchAll(
    /whr_embed\(\s*(\d+)|apply\.workable\.com\/api\/v1\/widget\/accounts\/([\w-]+)/gi,
  ))
    add(`https://apply.workable.com/${m[1] ?? m[2]}`);
  return [...out];
}

/**
 * The page's links a person can click, absolute, for following careers links: <a href>, and
 * "href" values in the page's own data (Next's app router ships its links there, escaped).
 */
export function hrefsIn(html, base) {
  const out = new Set();
  const found = [
    ...[...html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/\\?"href\\?"\s*:\s*\\?"([^"\\]+)\\?"/g)].map((m) => m[1]),
  ];
  for (const href of found) {
    try {
      const x = new URL(href.replace(/&amp;/g, "&"), base);
      if (x.protocol === "https:" || x.protocol === "http:") {
        x.hash = "";
        out.add(x.href);
      }
    } catch {}
  }
  return [...out];
}

// Career sites a platform serves on the company's own domain: the platform gives itself away
// in the page (an asset host, its own meta tags or markup), and its vendored provider reads the
// board from the URL named here, on the site itself. The runner hands that URL to the provider
// as its `api` when the provider knows only its own hosts (Avature's *.avature.net).
//   on "text": the page's HTML and links; on "url": the page's own address (a company whose
//   careers site is its own provider: Google's).
const careersPath = (pageUrl) =>
  new URL(pageUrl).pathname.match(/^(.*?\/careers)(?:\/|$)/i)?.[1] ?? "/careers";
const BRANDED = [
  {
    re: /rmkcdn\.successfactors\.(?:com|eu)|jobs2web\.com/i,
    provider: "successfactors",
    url: (o) => `${o}/`,
  },
  { re: /cdn\.phenompeople\.com/i, provider: "phenom", url: (o) => `${o}/` },
  { re: /tbcdn\.talentbrew\.com/i, provider: "radancy", url: (o) => `${o}/` },
  // Avature's portal names itself in meta tags; its list is the careers path's SearchJobs.
  {
    re: /<meta\s+name=["']avature\.portal\./i,
    provider: "avature",
    url: (o, page) => `${o}${careersPath(page)}/SearchJobs`,
  },
  // A branded Jibe site (iCIMS): the same JSON as *.jibeapply.com, at /api/jobs.
  { re: /jibe-container|jibe\.analytics/i, provider: "jibeapply", url: (o) => `${o}/api/jobs` },
  // Google Careers: read through its own results page, one query per saved-search term.
  {
    re: /^https:\/\/(?:www\.google\.com\/about\/careers|careers\.google\.com)\b/i,
    on: "url",
    provider: "google",
    url: () => "https://www.google.com/about/careers/applications/jobs/results/",
  },
];

/**
 * Boards on the company's own domain, as { provider, careers_url }, from what a page gives away:
 * `text` is its links (an array) or its HTML and links (a string).
 */
export function brandedBoards(text, pageUrl) {
  const hay = Array.isArray(text) ? text.join("\n") : String(text);
  const origin = new URL(pageUrl).origin;
  return BRANDED.filter((b) => b.re.test(b.on === "url" ? pageUrl : hay)).map((b) => ({
    provider: b.provider,
    careers_url: b.url(origin, pageUrl),
  }));
}

/**
 * SmartRecruiters posting ids in links (a company's own posting page often carries one:
 * careers.servicenow.com/jobs/744000158119381/…). Checked against SmartRecruiters by id.
 */
export function smartRecruitersIds(links) {
  const ids = new Set();
  for (const u of links) for (const m of String(u).matchAll(/\/(7\d{14})(?=[/?#-]|$)/g)) ids.add(m[1]);
  return [...ids];
}

// Words in many boards' addresses or many names: a page's site "jobs" (jobs.usv.com) or a
// company's "Labs" says nothing about whose a board is.
const SHARED =
  /^(jobs?|careers?|www|boards?|apply|hiring|the|inc|and|labs?|tech|technologies|technology|company|group|systems|capital|ventures|partners|holdings|global|solutions|health|software|studio|app|team|work)$/;

/**
 * Does a board's address bear the company's name or site? Its name's words, and its site's
 * first label with the punctuation gone (matter-labs.io → "matterlabs"), each of 3 letters or
 * more and not a word many boards share. `site`: the company's real site only, never a key
 * standing in for one (a company id would match a job id).
 */
export function boardBearer(name, site) {
  const words = [
    ...String(name ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/),
    site
      ? String(site)
          .split(".")[0]
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
      : "",
  ].filter((w) => w && w.length >= 3 && !SHARED.test(w));
  return (url) =>
    words.some((w) =>
      url
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .includes(w),
    );
}

const ASSET = /\.(?:css|js|mjs|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|pdf|mp4|zip)$/i;

// --- What counts as a company's careers page ---------------------------------------------
// One rule for everything that saves a careers page (detection, web search, import, the
// cleanup): the address must say so where a careers page says it. A home page, a help or docs
// site, a forum, a store category, or an article whose slug merely mentions careers is not one.

// A path segment that is a careers page's own name: /careers, /jobs, /join-us, /open-roles.
const CAREERS_SEGMENT =
  /^(?:careers?|jobs?|join|join-?us|join-?(?:the|our)-?team|work-?with-?us|work-?at-?\w+|we-?are-?hiring|were-?hiring|hiring|open-?(?:roles|positions|jobs)|openings?|positions?|vacanc(?:y|ies)|opportunities)$/i;
// Or a short name with a careers word in it: /neuralframe-careers, /careers-2, a Notion
// "Jobs-at-Crossmint-<id>" page. At most three words, so an article's slug doesn't pass.
const CAREERS_WORD = /^(?:careers?|jobs?|hiring)$/i;
// Segments that may come before it: a locale (/en/, /en-us/), the about or company section.
const BEFORE = /^(?:[a-z]{2}(?:[-_][a-z]{2,4})?|about|about-?us|company|corporate|us|team|global|intl)$/i;
// Hosts that are never a careers page whatever the path: help, docs, forums, blogs, stores.
const NOT_CAREERS_HOST =
  /^(?:help|docs?|support|community|forums?|discuss|discourse|blog|news|status|shop|store|archive|kb|wiki|learn|academy|developers?|api)$/i;
// A host that is a careers site itself: careers.acme.com, jobs.acme.com, careersatdoordash.com.
const CAREERS_HOST_LABEL = /career|^jobs?$|^join$|^hiring$|^apply$|^talent$|^recruiting$/i;
// A section that is never a careers page, on a careers host too: an article, a product page.
const NOT_CAREERS_SECTION =
  /^(?:blog|news|articles?|insights|press|stories|help|docs?|support|community|forums?|shop|store|products?|solutions|features|courses?|resources|events|podcasts?|guides?|learn|tools|apps?|templates)$/i;
// A job list a hosting site keeps for one company: YC's /companies/<slug>/jobs.
const HOSTED = [/^(?:www\.)?ycombinator\.com\/companies\/[^/]+\/jobs\/?$/i];

const words = (seg) =>
  decodeURIComponent(seg)
    .split(/[-_\s.]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !/^[0-9a-f]{12,}$/i.test(w));
const isCareersSegment = (seg) => {
  if (CAREERS_SEGMENT.test(seg)) return true;
  const ws = words(seg);
  return ws.length > 0 && ws.length <= 3 && ws.some((w) => CAREERS_WORD.test(w));
};

/**
 * The careers page this address is, as a careers site's root (up to its careers segment, or
 * the careers host itself), or null when it isn't one. robots.txt and reading are the caller's.
 */
export function careersPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const labels = host.split(".");
  const segs = u.pathname.split("/").filter(Boolean);
  if (HOSTED.some((re) => re.test(host + u.pathname))) return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  // Every label but the last: a subdomain names the site's purpose (help.kagi.com).
  if (labels.slice(0, -1).some((l) => NOT_CAREERS_HOST.test(l))) return null;
  let i = 0;
  while (i < segs.length && BEFORE.test(segs[i]) && !isCareersSegment(segs[i])) i++;
  if (i < segs.length && isCareersSegment(segs[i])) return `${u.origin}/${segs.slice(0, i + 1).join("/")}`;
  const careersHost =
    labels.slice(0, -1).some((l) => CAREERS_HOST_LABEL.test(l)) || /^(?:jobs|careers)$/.test(labels.at(-1));
  if (careersHost && !(i < segs.length && NOT_CAREERS_SECTION.test(segs[i]))) return `${u.origin}/`;
  return null;
}

// --- A careers page's own jobs feed ---------------------------------------------------------
// Besides JobPosting data and a job list in its page data (careers.ts), a jobs feed it names.

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&rarr;|&#8594;|&#x2192;/gi, "→")
    .replace(/\s+/g, " ")
    .replace(/\s*[→›»]\s*$/, "")
    .trim();

/** The jobs feed a careers page names (<link rel="alternate" type="application/atom+xml" …>), if any. */
export function jobsFeed(html, pageUrl) {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type\s*=\s*["']application\/(?:rss|atom)\+xml["']/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    const title = tag.match(/title\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (!href || !/job|career|opening|vacanc|position/i.test(`${href} ${title}`)) continue;
    try {
      return new URL(href.replace(/&amp;/g, "&"), pageUrl).href;
    } catch {}
  }
  return null;
}

/** Is this a jobs feed's text: RSS, Atom, or the job-site XML feed (<source><job>…) ServiceNow's is? */
export const isFeed = (text) =>
  /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:rss|feed|source)\b/i.test(text);

/** A jobs feed's entries, as { id, title, url, location, postedAt, employer }; employer when it names one. */
export function feedJobs(xml, feedUrl) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry|job)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const body = m[2];
    const tag = (name) => {
      const t = body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1];
      return t === undefined ? undefined : decode(t.trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1"));
    };
    const href =
      body.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
      body.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] ??
      tag("link") ??
      tag("url");
    const title = tag("title");
    if (!title || !href) continue;
    let url;
    try {
      url = new URL(href.replace(/&amp;/g, "&"), feedUrl).href;
    } catch {
      continue;
    }
    const when = Date.parse(tag("published") ?? tag("pubDate") ?? tag("updated") ?? tag("date") ?? "");
    const remote = /^(?:fully |100% )?remote/i.test(tag("remotetype") ?? "") ? ["Remote"] : [];
    const place = [tag("city"), tag("state"), tag("country")].filter(Boolean).join(", ");
    out.push({
      id: tag("id") ?? tag("guid") ?? tag("referencenumber") ?? tag("requisitionid") ?? url,
      title,
      url,
      location: [place, ...remote].filter(Boolean).join(" · "),
      postedAt: Number.isNaN(when) ? null : new Date(when).toISOString(),
      employer: tag("company") ?? tag("employer") ?? tag("hiringorganization") ?? null,
    });
  }
  return out;
}

/**
 * Same-site links that look like a careers page ("Careers", "/jobs", "Join us"). A separate
 * jobs host (trimblecareers.trimble.com) comes first; the same page in other languages is skipped.
 */
export function careersLinks(links, domain, from) {
  const fromHost = new URL(from).hostname;
  const seen = new Set();
  return links
    .filter((u) => {
      const x = new URL(u);
      const host = x.hostname.replace(/^www\./, "");
      if (!(host === domain || host.endsWith(`.${domain}`))) return false;
      if (ASSET.test(x.pathname)) return false;
      if (
        !/career|jobs?\b|join-?us|work-?with-?us|opportunit|open-?(?:roles|positions)|hiring/i.test(
          x.hostname + x.pathname,
        )
      )
        return false;
      const key =
        x.hostname + x.pathname.replace(/^\/[a-z]{2}(?:[-_][a-z]{2})?(?=\/)/i, "").replace(/\/$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(new URL(a).hostname === fromHost) - Number(new URL(b).hostname === fromHost));
}

// --- Boards a careers page names without linking to them ------------------------------
// Vendor embed snippets carry the board's name in markup or script, not in a link. Each
// marker becomes the careers_url its career-ops provider accepts. Such a board is the
// company's own word, so it counts even when it lists no roles today.
const EMBEDS = [
  // Jobvite: <div class="jv-careersite" data-careersite="spectralogic">
  [/data-careersite=["']([\w-]+)["']/gi, (s) => `https://jobs.jobvite.com/${s}`],
  // Rippling: <div id="rr-job-board" data-job-board-id="…">, or its embed URL
  [/data-job-board-id=["']([\w-]+)["']/gi, (s) => `https://ats.rippling.com/${s}/jobs`],
  [/ats\.rippling\.com\/embed\/([\w-]+)/gi, (s) => `https://ats.rippling.com/${s}/jobs`],
  // Greenhouse: the embed script or its board API
  [
    /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/gi,
    (s) => `https://job-boards.greenhouse.io/${s}`,
  ],
  [/boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/gi, (s) => `https://job-boards.greenhouse.io/${s}`],
  // Greenhouse's job-alert sign-in link names the board: my.greenhouse.io/users/sign_in?job_board=…
  [/greenhouse\.io\/users\/sign_in\?job_board=([\w-]+)/gi, (s) => `https://job-boards.greenhouse.io/${s}`],
  // Ashby's documented embed script: jobs.ashbyhq.com/<slug>/embed
  [/jobs\.ashbyhq\.com\/([\w.-]+)\/embed/gi, (s) => `https://jobs.ashbyhq.com/${s}`],
  // Lever's postings API, as job widgets call it
  [/api\.lever\.co\/v0\/postings\/([\w.-]+)/gi, (s) => `https://jobs.lever.co/${s}`],
  // Workable's widget: whr_embed(81866, …) or its widget API
  [/whr_embed\(\s*(\d+)/gi, (s) => `https://apply.workable.com/${s}`],
  [/apply\.workable\.com\/api\/v1\/widget\/accounts\/([\w-]+)/gi, (s) => `https://apply.workable.com/${s}`],
  // BambooHR's embed widget: <tenant>.bamboohr.com/jobs/embed2.php
  [/([\w-]+)\.bamboohr\.com\/jobs\/embed/gi, (s) => `https://${s}.bamboohr.com/careers`],
  // A Polymer board on the company's own host (jobs.overjoy.ai) names its board in its settings.
  [
    /APP_JOBBOARD_ROOT_URL\s*=\s*"https:\/\/jobs\.polymer\.co"[\s\S]{0,600}?CAREERS_PAGE_SLUG\s*=\s*"([\w-]+)"/gi,
    (s) => `https://jobs.polymer.co/${s}`,
  ],
];

/** Board URLs named by embed markers anywhere in the page's text (HTML, scripts, page data). */
export function embedBoards(text) {
  const out = new Set();
  for (const [re, url] of EMBEDS) for (const m of text.matchAll(re)) out.add(url(m[1]));
  return [...out];
}

/** Raw embed addresses that a provider would misread ("embed" as the board name). */
export const isEmbedPath = (u) => /ats\.rippling\.com\/embed\//i.test(u);

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// --- Job lists carried in the page's own data -----------------------------------------
const pick = (o, keys) => keys.map((k) => o[k]).find((v) => typeof v === "string" || typeof v === "number");

function arraysIn(v, out) {
  if (Array.isArray(v)) {
    if (v.length >= 3 && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) out.push(v);
    for (const x of v.slice(0, 5000)) arraysIn(x, out);
  } else if (v && typeof v === "object") for (const x of Object.values(v)) arraysIn(x, out);
  return out;
}

/** Index just past the bracket closing the one at `i`, skipping strings; -1 if unclosed. */
function closing(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") {
      for (j++; j < s.length && s[j] !== c; j++) if (s[j] === "\\") j++;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      if (--depth === 0) return j + 1;
    }
  }
  return -1;
}

/** JSON values inside a page: <script> bodies that are JSON or `x = […];`, and whole JSON files. */
function jsonIn(text) {
  const out = [];
  const tryParse = (s) => {
    try {
      out.push(JSON.parse(s));
    } catch {}
  };
  if (/^\s*[[{]/.test(text)) tryParse(text);
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1].trim();
    if (/^[[{]/.test(body)) tryParse(body);
    for (const a of body.matchAll(/=\s*(?=[[{])/g)) {
      const end = closing(body, a.index + a[0].length);
      if (end > 0) tryParse(body.slice(a.index + a[0].length, end));
    }
  }
  return out;
}

/**
 * A job list in the page's data: 3 or more records that each have a title, an id or slug, and
 * an href or url. Returns { id, title, url } per record, from the largest such list.
 */
export function embeddedJobs(texts, base) {
  let best = [];
  for (const text of texts)
    for (const v of jsonIn(text))
      for (const arr of arraysIn(v, [])) {
        const recs = arr.map((o) => ({
          id: pick(o, ["id", "uuid", "slug", "jobId", "job_id", "shortcode"]),
          title: pick(o, ["title", "name", "text"]),
          url: pick(o, ["href", "url", "absolute_url", "externalLink", "hostedUrl", "applyUrl"]),
        }));
        if (
          !recs.every((r) => r.id !== undefined && typeof r.title === "string" && typeof r.url === "string")
        )
          continue;
        if (recs.length > best.length)
          best = recs.map((r) => {
            let url = String(r.url);
            try {
              url = new URL(url, base).href;
            } catch {}
            return { id: String(r.id), title: r.title.trim(), url };
          });
      }
  return best;
}

/**
 * The page's own job list, as a careers page is read: embeddedJobs, when most of its records
 * link off the site (an ATS posting, YC's job page) or under a careers path of their own
 * (/jobs/1001, /careers/product-engineer). A site's navigation in its page data (apple.com's
 * /ipad/, /mac/, on jobs.apple.com too; a CMS's tag pages) has a title, an id and a url too.
 */
export function ownJobList(texts, base) {
  const list = embeddedJobs(texts, base);
  const origin = new URL(base).origin;
  const posting = (u) => {
    try {
      if (new URL(u).origin !== origin) return true;
      const root = careersPage(u);
      return root !== null && new URL(root).pathname !== "/";
    } catch {
      return false;
    }
  };
  return list.filter((r) => posting(r.url)).length * 2 > list.length ? list : [];
}

// --- Job boards by their address ---------------------------------------------------------
// ats/reader.ts gives these to the rest of the app; the runner reads them here.

// Job-board hosts: a link on one names a board, not a company (Add, intake, detection hints).
export const ATS_HOSTS = [
  "greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "apply.workable.com",
  "smartrecruiters.com",
  "recruitee.com",
  "bamboohr.com",
  "breezy.hr",
  "myworkdayjobs.com",
  "teamtailor.com",
  "pinpointhq.com",
  "ats.rippling.com",
  "app.dover.com",
  "homerun.co",
  "jobs.polymer.co",
  // Enterprise boards, named by their tenant's subdomain (netflix.eightfold.ai, jpmc.fa.oraclecloud.com).
  // iCIMS is recognised (a link there isn't the company's site) but not detected: see the proposal.
  "eightfold.ai",
  "oraclecloud.com",
  "taleo.net",
  "workforcenow.adp.com",
  "icims.com",
];
export const ATS_URL = new RegExp(`(${ATS_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|")})`, "i");

// Boards named by their subdomain (acme.recruitee.com, acme.wd1.myworkdayjobs.com).
export const SUBDOMAIN_BOARD =
  /\.(recruitee\.com|bamboohr\.com|breezy\.hr|homerun\.co|myworkdayjobs\.com|teamtailor\.com|pinpointhq\.com|eightfold\.ai|oraclecloud\.com|taleo\.net|workforcenow\.adp\.com|icims\.com)$/i;
export const ADP = /^workforcenow\.adp\.com$/i;

// Ashby's own demo board: its embed examples carry it, and a careers page built from one keeps
// it (priorlabs.ai's still loads jobs.ashbyhq.com/ashby-embed-demo-org/embed). Never a company's.
export const isDemoBoard = (url) =>
  /^https?:\/\/jobs\.ashbyhq\.com\/ashby-embed-demo-org(?:[/?#]|$)/i.test(url);

/** The board's company slug: jobs.ashbyhq.com/plaid/… → "plaid", acme.recruitee.com → "acme". */
export function boardSlug(url) {
  try {
    const u = new URL(url);
    // ADP Workforce Now is one host for every company: the board is its client id.
    if (ADP.test(u.hostname)) return u.searchParams.get("cid")?.toLowerCase() ?? null;
    if (SUBDOMAIN_BOARD.test(u.hostname)) return u.hostname.split(".")[0].toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);
    // A locale before the tenant isn't one (ats.rippling.com/en-GB/saturn/jobs/…); nor is an
    // API's path (boards-api.greenhouse.io/v1/boards/acme/jobs, api.lever.co/v0/postings/acme).
    if (/^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? "") && parts.length > 1) parts.shift();
    if (/^v\d+$/.test(parts[0] ?? "") && /^(boards|postings)$/.test(parts[1] ?? "")) parts.splice(0, 2);
    const embedded = /greenhouse\.io$/i.test(u.hostname) && parts[0] === "embed" && u.searchParams.get("for");
    const slug = embedded || (parts[0] === "jobs" || parts[0] === "embed" ? parts[1] : parts[0]);
    return slug ? slug.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Job boards that aren't among the hosts above (nothing here detects them by host) but whose
// links still name their employer: JOIN's and YC's company pages, Gem's boards.
const OTHER_BOARDS = [
  [/^join\.com$/, (p) => p[0] === "companies" && p[1]],
  [/^(?:www\.)?ycombinator\.com$/, (p) => p[0] === "companies" && p[1]],
  [/^jobs\.gem\.com$/, (p) => p[0]],
];

/**
 * The employer whose job board a link is on, as the board's host and tenant (greenhouse.io:acme;
 * a Workday tenant whatever its sites; a Dover posting's company), or null for a link on no job
 * board (a Notion page, a company's own site).
 */
export function employerOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  // A locale before the tenant isn't one (ats.rippling.com/en-GB/saturn/jobs/…).
  if (/^[a-z]{2}-[a-z]{2}$/i.test(parts[0] ?? "") && parts.length > 1) {
    parts.shift();
    u.pathname = `/${parts.join("/")}`;
  }
  const other = OTHER_BOARDS.find(([re]) => re.test(host));
  const on = other ? host : host.match(ATS_URL)?.[1]?.toLowerCase();
  if (!on) return null;
  // A Dover posting is /apply/<company>/<id>; its board /<company>/careers/<id>.
  const slug = other
    ? other[1](parts)
    : on === "app.dover.com" && parts[0] === "apply"
      ? parts[1]
      : boardSlug(u.href);
  return slug ? `${on}:${slug.toLowerCase()}` : null;
}

// "Applications Engineer @ Acme [$90,000 - 120,000]": the employer a job site writes after the title.
const AT_EMPLOYER = /\s@\s*([^@[\]()]+?)\s*(?:[[(].*)?$/;

/**
 * The employers a job list's roles are at, when they are 4 or more: no one company's list. By the
 * job boards its links sit on besides the page's own (a fund's job board: Getro's, for a16z, 8VC,
 * Thrive), else by the employer each role names (a feed's <company>, a JobPosting's
 * hiringOrganization, "Engineer @ Acme" in its title: a job site's feed, posted under one of its
 * employers' names). A link on no job board never counts. Detection (the runner) and the
 * careers-page read (careers.ts) both ask. `entries`: { url, title?, employer? }.
 */
export function otherEmployers(entries, pageUrl) {
  const own = employerOf(pageUrl);
  const boards = new Set(entries.map((e) => employerOf(e.url)).filter((e) => e && e !== own));
  if (boards.size >= 4) return [...boards].map((e) => e.split(":")[1]);
  // By its first word: one employer's legal entities ("Acme Inc", "Acme GmbH") are one.
  const named = new Map();
  for (const e of entries) {
    const name = (e.employer ?? e.title?.match(AT_EMPLOYER)?.[1] ?? "").trim();
    const first = name
      .toLowerCase()
      .replace(/^the\s+/, "")
      .match(/[\p{L}\p{N}]+/u)?.[0];
    if (first && !named.has(first)) named.set(first, name);
  }
  return named.size >= 4 ? [...named.values()] : [];
}

/** Do a job list's links sit on 4 or more employers' boards besides the page's own (otherEmployers)? */
export const manyEmployers = (urls, pageUrl) =>
  otherEmployers(
    urls.map((url) => ({ url })),
    pageUrl,
  ).length > 0;

/** Why a list of other employers' roles isn't this company's board, as the model's read says it. */
export const notTheirs = (name, employers) =>
  `its roles aren't ${name}'s: ${employers.join(", ").slice(0, 80) || "no employer named"}`;

/**
 * Job ids a page shows, by kind, for checking a board against: Ashby (ashby_jid), Greenhouse
 * (gh_jid, numeric ids in a job list), Dover (its apply links), and other uuids ending a link
 * on the company's own site (Dover posting ids, read through Dover's own lookup).
 */
export function jobIds(texts, base, domain) {
  const text = texts.join("\n");
  const ashby = new Set(
    [...text.matchAll(new RegExp(`ashby_jid=(${UUID})`, "gi"))].map((m) => m[1].toLowerCase()),
  );
  const greenhouse = new Set([...text.matchAll(/gh_jid=(\d+)/gi)].map((m) => m[1]));
  const dover = new Map(
    [...text.matchAll(new RegExp(`app\\.dover\\.com\\/apply\\/([\\w-]+)\\/(${UUID})`, "gi"))].map((m) => [
      m[2].toLowerCase(),
      m[1],
    ]),
  );
  for (const r of embeddedJobs(texts, base)) {
    if (/^\d{4,}$/.test(r.id)) greenhouse.add(r.id);
    else if (new RegExp(`^${UUID}$`, "i").test(r.id)) ashby.add(r.id.toLowerCase());
  }
  const own = new Set();
  for (const u of linksIn(texts[0] ?? "", base)) {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./, "");
    const m = x.pathname.match(new RegExp(`/(${UUID})/?$`, "i"));
    if (m && (host === domain || host.endsWith(`.${domain}`))) own.add(m[1].toLowerCase());
  }
  return { ashby, greenhouse, dover, own };
}

/** Dover's lookup from a posting id to its company and board, as the public posting page makes it. */
export const doverLookup = (id) => `https://app.dover.com/api/v1/inbound/application-portal-job/${id}`;

// Applying by email: an address on the company's own domain (or a subdomain), never a person's
// guessed one, whose name says it takes applications (careers@, jobs@, talent@…), on any page. A
// careers page may also offer one through a mailto: link that says so ("Apply", "Send your CV");
// a careers page's contact@ or hello@ is a contact, not an application. A post's own text (an HN
// post) may name any address that isn't for something else.
const NOT_APPLY =
  /^(?:no-?reply|donotreply|privacy|legal|press|media|pr|abuse|security|support|help|billing|sales|partners|investors|gdpr|dpo|postmaster|webmaster)(?![a-z])/i;
// Inside a longer name too: corporateprivacy@, recruitingaccommodations@ (disability requests, not applications).
const NOT_APPLY_IN =
  /(?:privacy|legal|security|support|billing|investor|accommodat|no-?reply|donotreply|abuse|gdpr|postmaster|webmaster)/i;
const APPLY_WORD = /^(?:careers?|jobs?|hiring|recruit\w*|talent\w*|people\w*|hr|apply|join\w*|work\w*)$/i;

/** Cloudflare's email protection: hex, the first byte is the XOR key for the rest. */
export function cfDecode(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2)
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

/** mailto: links (Cloudflare-protected ones decoded) whose text says they take applications. */
function applyLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(
    /<a\b[^>]*href=["'](?:mailto:([^"'?]+)|[^"']*\/cdn-cgi\/l\/email-protection#([0-9a-f]+))[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const text = m[3].replace(/<[^>]*>/g, " ");
    if (!/apply|resume|\bcv\b|application/i.test(text)) continue;
    const addr = m[1] ? decodeURIComponent(m[1]) : cfDecode(m[2]);
    if (addr) out.add(addr.toLowerCase().trim());
  }
  return out;
}

/**
 * The first address in a page (or a post's text) that takes applications for `domain`, or null.
 * `mode`: true for a careers page, false for the home page, "post" for a post's own text.
 */
export function applyEmailIn(html, domain, mode = true) {
  const careers = mode === true;
  const linked = careers ? applyLinks(html) : new Set();
  const found = [];
  for (const m of html.matchAll(
    /data-cfemail=["']([0-9a-f]+)["']|\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi,
  ))
    found.push(cfDecode(m[1] ?? m[2]) ?? "");
  for (const m of html.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) found.push(m[0]);
  const d = domain.toLowerCase().replace(/^www\./, "");
  for (const a of found) {
    const addr = a.toLowerCase().replace(/\.+$/, "");
    const [local, host] = addr.split("@");
    if (!local || !host || !(host === d || host.endsWith(`.${d}`))) continue;
    if (NOT_APPLY.test(local) || NOT_APPLY_IN.test(local)) continue;
    const word = local.split(/[._+-]/).some((w) => APPLY_WORD.test(w));
    if (mode === "post" || (careers ? word || linked.has(addr) : word)) return addr;
  }
  return null;
}

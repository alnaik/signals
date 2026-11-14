/// <reference types="chrome" />
// The extension's service worker. It links a tab to the company and role Apply opened it for (so
// the tab gets that role's CV), puts the form script into the frames it may fill, and carries the
// script's reads to the board. Chrome stops an idle worker, so the links live in
// chrome.storage.session, not in variables.
// @ts-expect-error plain JS module
import { employerOf } from "../../ats/links.mjs";
import { JOB_SITES } from "../hosts.ts";

declare const BOARD_PORT: number;
declare const BUILD: string;

const BOARD = `http://127.0.0.1:${BOARD_PORT}`;
// The board's own pages: the only ones that may ask the extension anything.
const BOARD_ORIGINS = [BOARD, `http://localhost:${BOARD_PORT}`];
// A thread id is a company domain (core/paths.ts), never a path.
const THREAD = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// Job boards whose forms fill in a linked tab without a click; anywhere else, the company's own site.
const JOB_HOSTS = new RegExp(`(^|\\.)(${JOB_SITES.map((h) => h.replace(/\./g, "\\.")).join("|")})$`, "i");
const NEVER = /(^|\.)(linkedin\.com|lnkd\.in)$/i;

type Link = {
  thread: string;
  role?: string; // the role's key, whose CV the tab gets
  company?: string; // the company's name, as the board knows it
  url: string; // the role's link Apply opened
  at?: string; // the page the tab is on now (its top frame)
  boards: string[]; // the job boards whose forms are this company's (employer())
  yes: string[]; // another company's forms you said Fill to, in this tab
  no: string[]; // and those you said Leave it to
};
// A form for another company than the one Apply opened the tab for: the notice asking you, by tab.
type Ask = { nonce: string; key: string; name: string; frame: number };

const host = (url: string | undefined): string => {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
};
// "careers.acme.co.uk" → "acme.co.uk": the site a host is part of (as ats/reader.ts registrable).
const site = (h: string): string => {
  const p = h
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const two = p.length > 2 && p.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(p.at(-2)!);
  return p.slice(two ? -3 : -2).join(".");
};
const linkKey = (tab: number) => `link:${tab}`;
const clickKey = (tab: number) => `click:${tab}`;
const askKey = (tab: number) => `ask:${tab}`;

async function linkOf(tab: number): Promise<Link | null> {
  return ((await chrome.storage.session.get(linkKey(tab)))[linkKey(tab)] as Link | undefined) ?? null;
}

// A job board's first host label that names no company (jobs.eu.lever.co, jobs.jobvite.com/acme).
const SHARED_LABEL = /^(jobs|apply|careers|app|ats|www|boards|job-boards|my|api)$/;

/**
 * Whose form a job board's page is: the board's site and the company's slug there, as ats/links.mjs
 * names a board's employer (greenhouse.io:acme, Greenhouse's embed by its ?for=; a Workday tenant
 * whatever its site), from the page's real address. Null off the job boards.
 */
function employer(url: string): string | null {
  const h = host(url).toLowerCase();
  if (!JOB_HOSTS.test(h)) return null;
  const p = new URL(url).pathname.split("/").filter(Boolean);
  const first = h.split(".")[0]!;
  const slug =
    // SmartRecruiters' apply step: /oneclick-ui/company/<company>/publication/<id>.
    (p[0] === "oneclick-ui" && p[1] === "company" && p[2]) ||
    (employerOf(url) as string | null)?.split(":")[1] ||
    // A job board links.mjs doesn't read (acme.workable.com, jobs.eu.lever.co/acme): the
    // subdomain, or on a shared host the path's first part.
    (h.split(".").length > 2 && !SHARED_LABEL.test(first) ? first : p[0]);
  return `${site(h)}:${(slug || h).toLowerCase()}`;
}
// "otherco on job-boards.greenhouse.io": a job board's company as the notice names it, plain text.
const employerName = (url: string): string => {
  const slug = employer(url)?.split(":")[1];
  return slug && slug !== host(url).toLowerCase() ? `${slug} on ${host(url)}` : host(url);
};

const own = (link: Link, h: string) => h === link.thread || h.endsWith(`.${link.thread}`);
// The company's own site, for handing off to its job board: its domain's, and the site of the
// role's link when that's no job board (a careers site on a domain of its own).
const home = (link: Link, url: string) => {
  const h = host(url);
  return !!h && !JOB_HOSTS.test(h) && (own(link, h) || site(h) === site(host(link.url)));
};

/**
 * The tab's page moved (a link, a redirect, a step of the form): a job board it reached straight
 * from the company's own site is the company's (a careers page handing off to its board); one
 * reached from a job board is not, until you say so. Each page once, whichever tells first.
 */
async function moved(tab: number, url: string): Promise<void> {
  const link = await linkOf(tab);
  if (!link || !/^https?:/.test(url) || link.at === url) return;
  const key = employer(url);
  if (key && home(link, link.at ?? link.url) && !link.boards.includes(key)) link.boards.push(key);
  link.at = url;
  await chrome.storage.session.set({ [linkKey(tab)]: link });
}
// Changes to a tab's link, one at a time (a page moving on and your answer to the notice both write it).
let moving: Promise<void> = Promise.resolve();
const serial = (fn: () => Promise<void>) => {
  moving = moving.then(fn).catch(() => {});
  return moving;
};
const move = (tab: number, url: string) => serial(() => moved(tab, url));

/**
 * Is a frame of a tab Apply opened the company's? Its own site's, or a job board of its: the one
 * the role is on, one its site handed off to, one you said Fill to; or any job board's frame in a
 * page of its own site (an embedded form). Decided from the frame's real address, never from what
 * the page says.
 */
async function theirs(tab: number, link: Link, url: string, frame: number): Promise<boolean> {
  const h = host(url);
  if (own(link, h)) return true;
  const key = employer(url);
  if (key && (link.boards.includes(key) || link.yes.includes(key))) return true;
  if (frame === 0) return false;
  const top = await chrome.tabs.get(tab).catch(() => null);
  return home(link, top?.url ?? "");
}

/**
 * May a frame be filled? Never on LinkedIn. In a tab Apply opened: on the company's own site or its
 * job board (theirs); another company's form there only once you say so (`other`: whose it is). In a
 * tab where you clicked the button, while the tab stays on that site: a frame of that site or a job
 * board's, never another site's (an ad, a widget).
 */
async function mayFill(
  tab: number,
  frameUrl: string,
  frame: number,
): Promise<{ ok: boolean; link: Link | null; other?: string }> {
  const h = host(frameUrl);
  if (!h || NEVER.test(h)) return { ok: false, link: null };
  await moving;
  const link = await linkOf(tab);
  const mine = !!link && (JOB_HOSTS.test(h) || own(link, h));
  if (link && mine && (await theirs(tab, link, frameUrl, frame))) return { ok: true, link };
  const clicked = (await chrome.storage.session.get(clickKey(tab)))[clickKey(tab)] as string | undefined;
  if (clicked && (JOB_HOSTS.test(h) || site(h) === site(clicked))) {
    const top = await chrome.tabs.get(tab).catch(() => null);
    if (host(top?.url) === clicked) return { ok: true, link };
  }
  return { ok: false, link, ...(mine ? { other: frameUrl } : {}) };
}

/**
 * Does a password show in any frame of the tab? Then it's a sign-in, and nothing in the tab fills
 * (the form script sees only its own frame).
 */
async function signingIn(tabId: number): Promise<boolean> {
  const found = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: () =>
        Array.from(document.querySelectorAll("input[type=password]")).some(
          (p) => p.getClientRects().length > 0 && getComputedStyle(p).visibility !== "hidden",
        ),
    })
    .catch(() => []);
  return found.some((f) => f.result === true);
}

const inject = (tabId: number, target: { frameIds: number[] } | { allFrames: true }) =>
  chrome.scripting.executeScript({ target: { tabId, ...target }, files: ["content.js"] }).catch(() => {});

async function post(body: object): Promise<Record<string, unknown>> {
  const r = await fetch(`${BOARD}/api/ext/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok ? ((await r.json()) as Record<string, unknown>) : {};
}

// A newer build is in the folder Chrome loads: reload into it once no tab is linked or clicked
// (a reload empties chrome.storage.session). Once per build, so a folder that isn't the board's
// can't make it reload over and over. Never at once: the board's hello wakes the worker and its
// open follows, which a reload would drop. A minute after the worker starts or a tab closes, by an
// alarm (it wakes a stopped worker; a timer dies with it).
let newer: string | null = null;
async function boardBuild(): Promise<void> {
  const r: Record<string, unknown> = await post({}).catch(() => ({}));
  if (typeof r.build === "string") newer = r.build;
}
async function reloadDue(): Promise<boolean> {
  if (!newer || newer === BUILD) return false;
  const { reloadedFor } = await chrome.storage.local.get("reloadedFor");
  return reloadedFor !== newer;
}
async function reloadLater(): Promise<void> {
  if (await reloadDue()) await chrome.alarms.create("build", { delayInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "build") return;
  await boardBuild();
  if (!(await reloadDue()) || Object.keys(await chrome.storage.session.get(null)).length) return;
  await chrome.storage.local.set({ reloadedFor: newer });
  chrome.runtime.reload();
});
boardBuild().then(reloadLater); // each time Chrome starts the worker

// Each page the tab moves to, before it loads: whose job boards are the company's.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) move(d.tabId, d.url);
});

// Each page or frame that finishes loading in a fillable tab gets the script; one with another
// company's form gets it too, to ask you (it fills nothing until you say so).
chrome.webNavigation.onCompleted.addListener(async (d) => {
  const may = await mayFill(d.tabId, d.url, d.frameId);
  if (may.ok || may.other) inject(d.tabId, { frameIds: [d.frameId] });
});

/** Take the notice away, wherever it shows in the tab. */
async function dropAsk(tab: number): Promise<void> {
  const ask = (await chrome.storage.session.get(askKey(tab)))[askKey(tab)] as Ask | undefined;
  if (!ask) return;
  await chrome.storage.session.remove(askKey(tab));
  chrome.tabs.sendMessage(tab, { type: "notice-done" }, { frameId: ask.frame }).catch(() => {});
}

// "Fill this page": any site, every frame, until the tab leaves the site.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined || !host(tab.url) || NEVER.test(host(tab.url))) return;
  await chrome.storage.session.set({ [clickKey(tab.id)]: host(tab.url) });
  await dropAsk(tab.id);
  inject(tab.id, { allFrames: true });
});

// The board: Apply opens the role in a tab linked to its company.
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (!BOARD_ORIGINS.includes(sender.origin ?? "")) return;
  if (msg?.type === "hello") {
    reply({ build: BUILD });
    return;
  }
  if (msg?.type !== "open" || !/^https?:\/\//.test(String(msg.url)) || !THREAD.test(String(msg.thread)))
    return;
  (async () => {
    const url = String(msg.url);
    const tab = await chrome.tabs.create({ url });
    const role = typeof msg.role === "string" ? msg.role.slice(0, 2000) : undefined;
    const company = typeof msg.company === "string" ? msg.company.slice(0, 200) : undefined;
    if (tab.id !== undefined) {
      const key = employer(url);
      const link: Link = {
        thread: msg.thread,
        ...(role ? { role } : {}),
        ...(company ? { company } : {}),
        url,
        boards: key ? [key] : [],
        yes: [],
        no: [],
      };
      await chrome.storage.session.set({ [linkKey(tab.id)]: link });
      // The tab may have moved on already (a redirect), before it was linked.
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (now?.url) await move(tab.id, now.url);
    }
    reply({ ok: true });
  })();
  return true;
});

// The notice, the extension's own page in a frame: what it says, and what you answered. Only that
// page, in the tab it was drawn for, with the number the form script gave it (a page can't load it
// and answer for you).
const NOTICE = chrome.runtime.getURL("notice.html");
async function answered(tab: number, nonce: unknown, fill?: boolean): Promise<{ text?: string }> {
  const ask = (await chrome.storage.session.get(askKey(tab)))[askKey(tab)] as Ask | undefined;
  const link = await linkOf(tab);
  if (!ask || !link || nonce !== ask.nonce) return {};
  if (fill === undefined)
    return { text: `This form is for ${ask.name}, not ${link.company ?? link.thread}. Fill it anyway?` };
  await serial(async () => {
    const now = await linkOf(tab);
    if (!now) return;
    (fill ? now.yes : now.no).push(ask.key);
    await chrome.storage.session.set({ [linkKey(tab)]: now });
  });
  await dropAsk(tab);
  // Fill: the frame's script runs a pass now, as when you click the button.
  if (fill) inject(tab, { frameIds: [ask.frame] });
  return {};
}

// The form script: a read of its frame, answered by the board.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tab = sender.tab?.id;
  if (tab === undefined) return;
  if (msg?.type === "notice" || msg?.type === "answer") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(NOTICE)) return;
    answered(tab, msg.nonce, msg.type === "answer" ? msg.fill === true : undefined).then(reply);
    return true;
  }
  const url = sender.url ?? "";
  // May this frame be filled? Asked first by each pass of the form script. Another company's form:
  // the notice's number, once per form, unless you said Leave it to that company.
  if (msg?.type === "may") {
    (async () => {
      const may = await mayFill(tab, url, sender.frameId ?? 0);
      if (may.ok || !may.other || !may.link) return reply({ ok: may.ok });
      const key = employer(may.other) ?? host(may.other);
      if (may.link.no.includes(key)) return reply({});
      const was = (await chrome.storage.session.get(askKey(tab)))[askKey(tab)] as Ask | undefined;
      const frame = sender.frameId ?? 0;
      const ask: Ask =
        was?.key === key && was.frame === frame
          ? was
          : { nonce: crypto.randomUUID(), key, name: employerName(may.other), frame };
      await chrome.storage.session.set({ [askKey(tab)]: ask });
      reply({ ask: ask.nonce });
    })();
    return true;
  }
  if (msg?.type !== "read") return;
  (async () => {
    const may = await mayFill(tab, url, sender.frameId ?? 0);
    if (!may.ok) return reply({});
    // A sign-in in another frame: the script tries again later.
    if (await signingIn(tab)) return reply({ signIn: true });
    const r: Record<string, unknown> = await post({
      tab,
      frame: sender.frameId ?? 0,
      ...(may.link ? { thread: may.link.thread, ...(may.link.role ? { role: may.link.role } : {}) } : {}),
      url,
      questions: msg.questions,
      want_cv: msg.want_cv === true,
      want_history: msg.want_history === true,
    }).catch(() => ({}));
    if (typeof r.build === "string") newer = r.build;
    reply(r);
  })();
  return true;
});

// A closed tab: the board learns what its form held.
chrome.tabs.onRemoved.addListener(async (tab) => {
  const keys = [linkKey(tab), clickKey(tab)];
  if (!Object.keys(await chrome.storage.session.get(keys)).length) return;
  await chrome.storage.session.remove([...keys, askKey(tab)]);
  await post({ tab, closed: true }).catch(() => {});
  await boardBuild();
  await reloadLater();
});

// A rendered read of a careers page, with the Chromium Playwright installed for Apply: free and
// local. Only for a page no reader here reads from its plain HTML (intake/pages.ts): many build
// their job list in JavaScript. A render gives the page's visible text and links (shadow roots and
// frames included), and every request it made: a job widget gives its board away by the API it
// calls. robots.txt is honoured for the page, every frame it opens and every request for data it
// makes; nothing loads from a private address; a page gets RENDER_MS.
import type { Browser, Page } from "playwright";
import { isLinkedIn } from "../apply/linkedin.ts";
import { assertPublicHost, refuseLinkedIn, robotsAllowed } from "../core/http.ts";

export const RENDER_MS = 20_000;

export type Link = { href: string; text: string };
export type Rendered = {
  url: string; // where the page ended up
  status: number | null;
  text: string;
  links: Link[];
  requests: string[];
  frames: string[];
  html: string; // the rendered DOM, for the markers a platform leaves (links.mjs EMBEDS)
  blocked?: string; // robots.txt refuses the page itself
};

/** For a browser page's request guard: may this request go out? Never to a private address or LinkedIn. */
export function publicRequests(): (url: string) => Promise<boolean> {
  const ok = new Map<string, Promise<boolean>>();
  return async (url) => {
    const u = new URL(url);
    // data: and blob: are the page's own assets; anything else (file:, ftp:) never loads.
    if (u.protocol === "data:" || u.protocol === "blob:") return true;
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (isLinkedIn(url)) return false;
    if (!ok.has(u.hostname))
      ok.set(
        u.hostname,
        assertPublicHost(u.hostname).then(
          () => true,
          () => false,
        ),
      );
    return ok.get(u.hostname)!;
  };
}

// Opened with no new windows: a page's popup would load outside every check below.
export const BROWSER_ARGS = ["--block-new-web-contents"];

export type Request = { url: string; type: string; mainFrame: boolean };

/**
 * Every request the page makes asks `allow` first, each hop of a redirect included, and is
 * refused when it says no. The browser's own request interception is used, not Playwright's
 * page.route, which sees only a redirect's first address: a public page that redirects to an
 * address inside the person's network would load there unchecked.
 */
export async function guardRequests(page: Page, allow: (r: Request) => Promise<boolean>): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const main = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  cdp.on("Fetch.requestPaused", async (e) => {
    const r = { url: e.request.url, type: e.resourceType, mainFrame: e.frameId === main };
    const ok = await allow(r).catch(() => false);
    await (ok
      ? cdp.send("Fetch.continueRequest", { requestId: e.requestId })
      : cdp.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" })
    ).catch(() => {});
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

// A read, not a visit: no images, video or fonts.
const SKIP = new Set(["Image", "Media", "Font"]);

/**
 * Runs in the page (passed to evaluate): its visible text, one line per block, and its links,
 * through open shadow roots (a web component's job list). Must stay self-contained.
 */
function visible(): { text: string; links: { href: string; text: string }[] } {
  const lines: string[] = [];
  const links: { href: string; text: string }[] = [];
  const BLOCK = /^(P|DIV|LI|H[1-6]|TR|SECTION|ARTICLE|HEADER|FOOTER|BR|DT|DD|UL|OL|TABLE|BUTTON|A)$/;
  const visit = (n: Node) => {
    if (n.nodeType === 3) {
      const t = n.textContent?.replace(/\s+/g, " ").trim();
      if (t) lines.push(t);
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|TEMPLATE)$/.test(e.tagName)) return;
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (e.tagName === "A" && (e as HTMLAnchorElement).href) {
      const text = ((e as HTMLElement).innerText || e.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      links.push({ href: (e as HTMLAnchorElement).href, text: text.slice(0, 160) });
    }
    if (BLOCK.test(e.tagName)) lines.push("\n");
    const root = (e as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (root) for (const c of Array.from(root.childNodes)) visit(c);
    for (const c of Array.from(e.childNodes)) visit(c);
  };
  if (document.body) visit(document.body);
  return {
    text: lines
      .join(" ")
      .replace(/ *\n[ \n]*/g, "\n")
      .trim(),
    links,
  };
}

export type Renderer = { render: (url: string) => Promise<Rendered>; close: () => Promise<void> };

/** One headless browser for a pass of renders; close it when the pass is done. */
export async function openRenderer(userAgent: string, ms = RENDER_MS): Promise<Renderer> {
  const { chromium } = await import("playwright");
  let browser: Browser | null = null;
  return {
    close: async () => {
      await browser?.close().catch(() => {});
      browser = null;
    },
    render: async (url) => {
      refuseLinkedIn(url);
      await assertPublicHost(new URL(url).hostname);
      if (!(await robotsAllowed(url)))
        return { url, status: null, text: "", links: [], requests: [], frames: [], html: "", blocked: url };
      browser ??= await chromium.launch({ headless: true, args: BROWSER_ARGS });
      const ctx = await browser.newContext({ userAgent, acceptDownloads: false, serviceWorkers: "block" });
      const until = Date.now() + ms;
      const left = () => Math.max(1, until - Date.now());
      // A page that hangs past its time is closed whatever it is doing.
      const timer = setTimeout(() => ctx.close().catch(() => {}), ms + 5000);
      try {
        const page = await ctx.newPage();
        const requests = new Set<string>();
        let blocked: string | undefined;
        const isPublic = publicRequests();
        await guardRequests(page, async (r) => {
          if (SKIP.has(r.type) || !(await isPublic(r.url))) return false;
          // The page names what it asks for, even what it isn't let have.
          if (/^https?:/.test(r.url)) requests.add(r.url);
          // The page, each frame it opens and the data it fetches are read: robots.txt decides
          // each. Its scripts and styles are how it draws itself.
          const read = ["Document", "XHR", "Fetch"].includes(r.type);
          if (read && !(await robotsAllowed(r.url).catch(() => false))) {
            if (r.type === "Document" && r.mainFrame) blocked = r.url;
            return false;
          }
          return true;
        });
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: left() }).catch((err) => {
          if (blocked) return null;
          throw err;
        });
        if (blocked)
          return { url, status: null, text: "", links: [], requests: [], frames: [], html: "", blocked };
        await page.waitForLoadState("networkidle", { timeout: Math.min(8000, left()) }).catch(() => {});
        // Lists that load as they scroll into view.
        for (let i = 0; i < 3 && left() > 3000; i++) {
          await page.mouse.wheel(0, 4000).catch(() => {});
          await page.waitForTimeout(500);
        }
        await page.waitForLoadState("networkidle", { timeout: Math.min(2000, left()) }).catch(() => {});
        const main = await page.evaluate(visible);
        const frames: string[] = [];
        for (const f of page.frames().slice(1)) {
          if (!/^https?:/.test(f.url())) continue;
          frames.push(f.url());
          const x = await f.evaluate(visible).catch(() => null);
          if (!x?.text) continue;
          main.text += `\n${x.text}`;
          main.links.push(...x.links);
        }
        return {
          url: page.url(),
          status: res?.status() ?? null,
          text: main.text,
          links: main.links,
          requests: [...requests],
          frames,
          html: await page.content(),
        };
      } finally {
        clearTimeout(timer);
        await ctx.close().catch(() => {});
      }
    },
  };
}

// The browser, swappable in tests.
let make: typeof openRenderer = openRenderer;
export function setRenderer(fn: typeof openRenderer): void {
  make = fn;
}
export const renderer = (userAgent: string) => make(userAgent);

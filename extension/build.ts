// Builds the Chrome extension into extension/dist, the folder Chrome loads ("Load unpacked"). The
// board builds it each time it starts, so an update reaches Chrome without a step of yours: the
// extension reloads itself when the board's build differs from its own (src/worker.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JOB_SITES } from "./hosts.ts";
import { EXTENSION_KEY } from "./id.ts";

export const DIST = path.join(import.meta.dir, "dist");
const ENTRIES = ["src/content.ts", "src/worker.ts", "src/notice.ts"].map((f) =>
  path.join(import.meta.dir, f),
);
const SOURCES = [
  ...ENTRIES,
  ...["../apply/page.ts", "../ats/links.mjs", "build.ts", "hosts.ts", "id.ts"].map((f) =>
    path.join(import.meta.dir, f),
  ),
];

// The notice on another company's form (src/notice.ts): plain words, the extension's own page.
const NOTICE_HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 14px 16px; font: 14px/1.4 -apple-system, system-ui, sans-serif; color: #1a1a1a; background: #fff; }
  p { margin: 0 0 12px; }
  b { color: #ff5a1f; }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; margin-right: 8px; }
  #fill { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
</style>
<p><b>Job Signal</b> · <span id="say"></span></p>
<button id="fill" type="button">Fill</button><button id="leave" type="button">Leave it</button>
<script src="notice.js"></script>
`;

const manifest = (version: string, port: number) => ({
  manifest_version: 3,
  name: "Job Signal",
  version: "1.0",
  version_name: version,
  description: "Fills job applications from your Job Signal profile and answer bank. You submit.",
  key: EXTENSION_KEY,
  // Every site, because a form can be on any company's site: the script goes only into a tab Apply
  // opened (on a job board or the company's own site) or one where you clicked the button.
  permissions: ["storage", "scripting", "webNavigation", "alarms"],
  host_permissions: ["<all_urls>"],
  // The notice the form script shows on another company's form: only job boards may load it, so
  // no other site can tell the extension is there by loading it.
  web_accessible_resources: [{ resources: ["notice.html"], matches: JOB_SITES.map((h) => `*://*.${h}/*`) }],
  background: { service_worker: "worker.js" },
  action: { default_title: "Fill this page with Job Signal" },
  // The board asks the extension to open a role, which links the tab to its company: the board's
  // pages only, on its port, so no other page on this Mac can reach the extension.
  externally_connectable: { matches: [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`] },
});

/** Build for a board on this port; returns the build's version (a hash of its sources). */
export async function buildExtension(port: number, outdir = DIST): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256").update(String(port));
  for (const f of SOURCES) hash.update(readFileSync(f));
  const version = hash.digest("hex").slice(0, 12);
  // Built already (the board restarted with no update): Chrome's folder is left as it is.
  const built = path.join(outdir, "build.txt");
  if (existsSync(built) && readFileSync(built, "utf8").trim() === version) return version;
  // Built beside it, then moved in file by file: Chrome reads content.js at each injection, so the
  // folder is never without one. build.txt goes last: the board offers the build once it's whole.
  const next = `${outdir}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const r = await Bun.build({
    entrypoints: ENTRIES,
    outdir: next,
    target: "browser",
    format: "iife", // content scripts aren't modules
    naming: "[name].js",
    define: { BOARD_PORT: String(port), BUILD: JSON.stringify(version) },
  });
  if (!r.success) throw new Error(`Extension build failed: ${r.logs.map(String).join("\n")}`);
  writeFileSync(path.join(next, "manifest.json"), JSON.stringify(manifest(version, port), null, 1));
  writeFileSync(path.join(next, "notice.html"), NOTICE_HTML);
  writeFileSync(path.join(next, "build.txt"), version);
  mkdirSync(outdir, { recursive: true });
  const files = readdirSync(next).sort((a, b) => Number(a === "build.txt") - Number(b === "build.txt"));
  for (const f of files) renameSync(path.join(next, f), path.join(outdir, f));
  rmSync(next, { recursive: true, force: true });
  return version;
}

// The folder Chrome loads, swappable in tests (like setRunner in ats/reader.ts).
let served = DIST;
export function setBuildDir(dir: string | null): void {
  served = dir ?? DIST;
}

/** The version in the folder Chrome loads: what the extension runs after its next reload. */
export function builtVersion(): string | null {
  const f = path.join(served, "build.txt");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
}

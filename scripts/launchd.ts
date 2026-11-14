// launchd agents: the board server (kept alive) and the scheduler tick (every 15 minutes).
// launchd runs a missed StartInterval once on wake, which is the catch-up after sleep.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../core/paths.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

export const LABELS = { board: "com.jobsignal.board", tick: "com.jobsignal.tick" };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Bun's stable path. Homebrew's real binary lives in a versioned Cellar folder that an upgrade
 * deletes, which would stop every job; its bin/ link survives upgrades.
 */
export function bunPath(exec = process.execPath, onPath = Bun.which("bun")): string {
  return exec.includes("/Cellar/") && onPath ? onPath : exec;
}

/**
 * `processType`: the board answers you, so it runs as a Standard process; Background, which macOS
 * throttles (the Inbox's queries took several times as long), is for the tick.
 */
export function plist(
  label: string,
  args: string[],
  extra: string,
  processType: "Standard" | "Background",
): string {
  const logs = path.join(dataDir(), "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(`${path.dirname(bunPath())}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string>
    <key>JOBSIGNAL_DATA</key><string>${esc(dataDir())}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(path.join(logs, `${label}.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logs, `${label}.log`))}</string>
  <key>ProcessType</key><string>${processType}</string>
${extra}
</dict>
</plist>
`;
}

export function plists(): Record<string, string> {
  const bin = [bunPath(), path.join(ROOT, "bin", "jobsignal.ts")];
  return {
    [LABELS.board]: plist(
      LABELS.board,
      [...bin, "serve"],
      "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>",
      "Standard",
    ),
    [LABELS.tick]: plist(
      LABELS.tick,
      [...bin, "tick"],
      "  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>900</integer>",
      "Background",
    ),
  };
}

const uid = () => process.getuid?.() ?? 501;

export function install(): string[] {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(path.join(dataDir(), "logs"), { recursive: true });
  const done: string[] = [];
  for (const [label, xml] of Object.entries(plists())) {
    const file = path.join(AGENTS_DIR, `${label}.plist`);
    Bun.spawnSync(["launchctl", "bootout", `gui/${uid()}`, file]);
    writeFileSync(file, xml);
    const p = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid()}`, file]);
    if (p.exitCode !== 0) throw new Error(`launchctl bootstrap ${label}: ${p.stderr.toString()}`);
    done.push(file);
  }
  return done;
}

export function uninstall(): void {
  for (const label of Object.values(LABELS)) {
    const file = path.join(AGENTS_DIR, `${label}.plist`);
    Bun.spawnSync(["launchctl", "bootout", `gui/${uid()}`, file]);
    if (existsSync(file)) unlinkSync(file);
  }
}

export function status(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of Object.values(LABELS)) {
    const p = Bun.spawnSync(["launchctl", "print", `gui/${uid()}/${label}`]);
    out[label] =
      p.exitCode === 0 ? (p.stdout.toString().match(/state = (\w+)/)?.[1] ?? "loaded") : "not installed";
  }
  return out;
}

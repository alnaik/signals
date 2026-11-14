// A lock a running process holds: a file in the data folder with its pid, touched every minute
// while held. A lock whose pid is gone (a crash, a restart) is stale, and so is one not touched in
// ten minutes (its pid reused by another process): either is taken over.
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.ts";

const TOUCH_MS = 60_000;
const STALE_MS = 10 * 60_000;
const file = (name: string) => path.join(dataDir(), `${name}.lock`);

/** The pid holding this lock while it is live, else null. */
export function lockHolder(name: string): number | null {
  try {
    const f = file(name);
    if (Date.now() - statSync(f).mtimeMs > STALE_MS) return null;
    const pid = Number(readFileSync(f, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Take the lock, or null while a live holder has it. The answer lets it go. */
export function takeLock(name: string): (() => void) | null {
  const f = file(name);
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(f, String(process.pid), { flag: "wx" });
      const timer = setInterval(() => {
        try {
          const t = new Date();
          utimesSync(f, t, t);
        } catch {}
      }, TOUCH_MS);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        try {
          if (readFileSync(f, "utf8") === String(process.pid)) unlinkSync(f);
        } catch {}
      };
    } catch {
      if (lockHolder(name) !== null) return null;
      try {
        unlinkSync(f);
      } catch {}
    }
  }
  return null;
}

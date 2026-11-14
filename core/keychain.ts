// API keys and tokens live in the macOS Keychain, never in the data folder or a shell profile.
// JOBSIGNAL_KEYCHAIN=memory swaps in an in-process store for tests.
const SERVICE = "jobsignal";
const memory = new Map<string, string>();
const inMemory = () => process.env.JOBSIGNAL_KEYCHAIN === "memory";

// Each read is a synchronous `security` spawn that blocks the board for it (Settings asked about
// 45 a load), so an answer is kept 60 s. A write here clears its name first. A write from another
// process shows within the minute; only x_refresh_token rotates, and only the tick uses it.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: string | null }>();

export function getSecret(name: string): string | null {
  if (inMemory()) return memory.get(name) ?? null;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const p = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
  const value = p.exitCode === 0 ? p.stdout.toString().trim() : null;
  cache.set(name, { at: Date.now(), value });
  return value;
}

export function setSecret(name: string, value: string): void {
  if (inMemory()) {
    memory.set(name, value);
    return;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Not a key name: ${name.slice(0, 40)}`);
  if (/[\r\n\0]/.test(value)) throw new Error("A key can't contain line breaks");
  cache.delete(name);
  // Sent on stdin to `security -i`, not as an argument, so it never shows in `ps`.
  const quoted = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const p = Bun.spawnSync(["/usr/bin/security", "-i"], {
    stdin: Buffer.from(`add-generic-password -U -s ${SERVICE} -a ${name} -w ${quoted}\n`),
  });
  if (p.exitCode !== 0 || getSecret(name) !== value.trim())
    throw new Error(`Keychain write failed: ${p.stderr.toString().trim()}`);
}

export function deleteSecret(name: string): void {
  if (inMemory()) {
    memory.delete(name);
    return;
  }
  cache.delete(name);
  Bun.spawnSync(["/usr/bin/security", "delete-generic-password", "-s", SERVICE, "-a", name]);
}

export function hasSecret(name: string): boolean {
  return getSecret(name) !== null;
}

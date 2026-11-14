import { afterAll, expect, test } from "bun:test";
import { copyFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { open } from "../core/db.ts";
import * as index from "../core/index-db.ts";
import { read } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { readState } from "../core/state.ts";
import { tempData } from "../core/testing.ts";
import { processAll } from "./process.ts";

const data = tempData();
afterAll(data.cleanup);
const FIX = path.join(import.meta.dir, "..", "fixtures", "drop");
const drop = (name: string) => {
  copyFileSync(path.join(FIX, name), paths.drop(name));
  return paths.drop(name);
};

// A company's newest signal, by its domain.
const signalOf = (domain: string) =>
  open()
    .query(
      "SELECT s.* FROM signals s JOIN companies c ON c.id = s.company_id WHERE c.domain = ? ORDER BY s.id DESC",
    )
    .get(domain) as { source_tag: string } | null;

test("every known format becomes leads; junk goes to unreadable", async () => {
  for (const f of readdirSync(FIX)) drop(f);
  const results = Object.fromEntries((await processAll()).map((r) => [r!.file, r]));
  expect(results["twitter-web-exporter.json"]).toMatchObject({
    format: "twitter-web-exporter",
    total: 2,
    kept: 2,
  });
  expect(results["saved_posts.json"]).toMatchObject({ format: "instagram saved posts", total: 2 });
  expect(results["muse.jsonl"]).toMatchObject({ format: "native jsonl", kept: 2 });
  // With F23, a notebook CSV (company + status/date) is past applications, not leads.
  expect(results["notebook.csv"]).toMatchObject({ format: "past applications (notebook)", kept: 2 });
  expect(results["links.txt"]).toMatchObject({ format: "text links", kept: 2 });
  expect(results["unknown-shape.json"]).toMatchObject({ format: "learned recipe", total: 2 });
  expect(results["junk.bin"]).toMatchObject({ format: null });

  const row = (domain: string) => signalOf(domain);
  expect(row("tessera.dev")?.source_tag).toBe("Muse");
  expect(row("orbit.health")?.source_tag).toBe("hiring.cafe");
  expect(row("quarry.so")).toBeTruthy();
  expect(row("cobalt.so")).toBeTruthy();
  // Drops are signals; the only threads are the notebook's past applications.
  expect(index.threadIds().filter((id) => read(id).some((e) => e.actor !== "import"))).toEqual([]);
  expect(read("tessera.dev")).toEqual([]);

  expect(readdirSync(paths.drop("done")).length).toBe(6);
  expect(readdirSync(paths.drop("unreadable"))[0]).toEndWith("junk.bin");
  expect(readState().agents.intake?.line).toBe("unreadable · junk.bin");
  // X and Instagram posts don't name a company: they wait for the classifier.
  expect(read("x.com").length).toBe(0);
});

test("the watcher picks a file up as soon as it lands", async () => {
  const { startServer } = await import("../server/main.ts");
  const app = await startServer({ port: 0 });
  try {
    await Bun.write(paths.drop("late.jsonl"), '{"url":"https://late.dev/jobs","source":"muse"}\n');
    // The watcher waits until the file stops growing (two size checks 300 ms apart), behind
    // anything already queued; under a full parallel test run that can take a few seconds.
    const late = () => signalOf("late.dev");
    for (let i = 0; i < 100 && !late(); i++) await Bun.sleep(100);
    expect(late()?.source_tag).toBe("Muse");
  } finally {
    app.stop();
  }
}, 15_000);

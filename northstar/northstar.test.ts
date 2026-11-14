import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { feature } from "./server.ts";

const data = tempData();
afterAll(data.cleanup);

test("the north star is kept as plain text on one line, 90 characters at most", async () => {
  const route = feature.routes!["/api/northstar"] as Record<string, (r: Request) => Promise<Response>>;
  const post = (text: unknown) =>
    route.POST!(
      new Request("http://127.0.0.1:4317/api/northstar", { method: "POST", body: JSON.stringify({ text }) }),
    );
  const saved = await (await post("  Ship\nthe\u0000 <b>thing</b>\u202e  people\ttrust  ")).json();
  expect(saved.text).toBe("Ship the <b>thing</b> people trust"); // shown as text, never as HTML
  expect(JSON.parse(readFileSync(paths.me("north-star.json"), "utf8")).text).toBe(saved.text);
  expect((await (await post("x".repeat(500))).json()).text).toHaveLength(90);
  // An emoji made of several, joined, stays whole.
  expect((await (await post("Build \u{1F469}\u200d\u{1F4BB} tools")).json()).text).toBe(
    "Build \u{1F469}\u200d\u{1F4BB} tools",
  );
  expect((await (await post({ not: "text" })).json()).text).toBe("");
  expect((await (await route.GET!(new Request("http://127.0.0.1:4317/api/northstar"))).json()).text).toBe("");
});

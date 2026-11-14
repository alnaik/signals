import { afterAll, expect, test } from "bun:test";
import { setPageReader } from "../ats/reader.ts";
import { politeGet } from "../core/http.ts";
import { leverPageGone } from "./domain.ts";

afterAll(() => setPageReader((u, v = {}) => politeGet(u, { accept: "text/html", ...v })));

test("a Lever page is checked as its link writes it: its pages are case-sensitive", async () => {
  const asked: string[] = [];
  setPageReader(async (url) => {
    asked.push(url);
    if (url.endsWith("/Grid") || url.endsWith("/Xpansiv%20")) return { text: "<html>jobs</html>" };
    throw Object.assign(new Error("HTTP 404"), { status: 404 });
  });
  expect(await leverPageGone("https://jobs.lever.co/Grid")).toBe(false);
  expect(await leverPageGone("https://jobs.lever.co/Xpansiv%20")).toBe(false);
  expect(await leverPageGone("https://jobs.lever.co/zuma")).toBe(true);
  expect(asked).toEqual([
    "https://jobs.lever.co/Grid",
    "https://jobs.lever.co/Xpansiv%20",
    "https://jobs.lever.co/zuma",
  ]);
});

import { expect, test } from "bun:test";
import { framed, roleHref, safeHref } from "./format.ts";

test("only http(s) links are clickable", () => {
  expect(safeHref("https://quillmark.dev/docs/")).toBe("https://quillmark.dev/docs/");
  expect(safeHref("javascript:alert(1)")).toBeUndefined();
  expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
  expect(safeHref("not a url")).toBeUndefined();
  expect(safeHref("file:///etc/passwd")).toBeUndefined();
  expect(safeHref("mailto:jobs@quillmark.dev")).toBeUndefined();
  expect(safeHref(undefined)).toBeUndefined();
});

test("a role's link may also be a mail link, and nothing else", () => {
  expect(roleHref("https://jobs.lever.co/acme/1")).toBe("https://jobs.lever.co/acme/1");
  expect(roleHref("http://acme.dev/careers/1")).toBe("http://acme.dev/careers/1");
  expect(roleHref("mailto:jobs@acme.dev?subject=Engineer")).toBe("mailto:jobs@acme.dev?subject=Engineer");
  expect(roleHref("javascript:alert(1)")).toBeUndefined();
  expect(roleHref("file:///etc/passwd")).toBeUndefined();
  expect(roleHref("vscode://file/x")).toBeUndefined();
  expect(roleHref("not a url")).toBeUndefined();
  expect(roleHref("")).toBeUndefined();
});

test("the board won't run inside another page's frame", () => {
  const own = { top: null as unknown, self: null as unknown };
  own.top = own.self = own;
  expect(framed(own)).toBe(false);
  expect(framed({ top: {}, self: own })).toBe(true);
});

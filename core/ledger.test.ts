import { afterAll, expect, test } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { entries, record } from "./ledger.ts";
import { paths } from "./paths.ts";
import { tempData } from "./testing.ts";

const data = tempData();
afterAll(data.cleanup);

test("spend recorded after a torn line still counts", () => {
  const before = entries().length;
  appendFileSync(paths.ledger(), '{"ts":"2026-11-01T00:00:00.000Z","kind":"pro');
  record({ kind: "provider", station: "t", provider: "exa", usd: 0.25 });
  expect(entries().length).toBe(before + 1);
  expect(entries().at(-1)!.usd).toBe(0.25);
});

test("the ledger is read as it grows: appended lines once, a line half-written when it's whole, a file cut or replaced whole again", () => {
  const line = (usd: number) =>
    `${JSON.stringify({ ts: "2026-11-02T00:00:00.000Z", kind: "provider", station: "t", usd })}\n`;
  writeFileSync(paths.ledger(), line(1) + line(2));
  expect(entries().map((e) => e.usd)).toEqual([1, 2]);
  appendFileSync(paths.ledger(), line(3));
  expect(entries().map((e) => e.usd)).toEqual([1, 2, 3]);
  // Half a line: not yet; whole: once.
  const half = line(4);
  appendFileSync(paths.ledger(), half.slice(0, 20));
  expect(entries().map((e) => e.usd)).toEqual([1, 2, 3]);
  appendFileSync(paths.ledger(), half.slice(20));
  expect(entries().map((e) => e.usd)).toEqual([1, 2, 3, 4]);
  // Cut shorter in place, then longer again with other lines: read whole.
  writeFileSync(paths.ledger(), line(5));
  expect(entries().map((e) => e.usd)).toEqual([5]);
  writeFileSync(paths.ledger(), line(6) + line(7) + line(8) + line(9) + line(10));
  expect(entries().map((e) => e.usd)).toEqual([6, 7, 8, 9, 10]);
  // Replaced by another file.
  writeFileSync(`${paths.ledger()}.new`, line(11));
  renameSync(`${paths.ledger()}.new`, paths.ledger());
  expect(entries().map((e) => e.usd)).toEqual([11]);
});

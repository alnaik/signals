// Append one JSON line to a .jsonl file. A process that dies mid-write leaves a last line with
// no newline; a plain append would glue the next line onto it and readers would skip both. When
// the file doesn't end in "\n", the line starts with one, so only the torn fragment is lost.
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";

export function appendLine(file: string, value: unknown): void {
  const fd = openSync(file, "a+");
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    // One write per line with O_APPEND (no position): concurrent writers can't interleave a line.
    // Two writers on a torn tail may both add the "\n": an empty line, which every reader skips.
    writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(value)}\n`);
  } finally {
    closeSync(fd);
  }
}

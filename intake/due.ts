import { loadConfig } from "../core/config.ts";
import type { Schedule } from "./types.ts";

const HOUR = 3_600_000;

/** The most recent time the night window opened (default 01:00 local). */
export function lastNightStart(now = new Date()): Date {
  const [h, m] = loadConfig().schedule.night_start.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h ?? 1, m ?? 0, 0, 0);
  if (d > now) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Is a job due? Missed runs catch up: a nightly job that didn't run because the Mac
 * was asleep runs at the first tick after waking.
 */
export function isDue(
  schedule: Schedule,
  lastRun: string | undefined,
  now = new Date(),
  everyHours?: number,
  day?: number,
): boolean {
  if (schedule === "manual") return false;
  if (!lastRun) return true;
  const last = Date.parse(lastRun);
  // A source's `day` in config.toml: once a week, from that day's night window.
  if (day !== undefined) return last < lastWeekdayStart(day, now).getTime();
  // A source's `every_hours` in config.toml replaces its own schedule.
  if (everyHours && everyHours > 0) return now.getTime() - last >= everyHours * HOUR - 60_000;
  switch (schedule) {
    case "every_tick":
      return true;
    case "every_6h":
      return now.getTime() - last >= 6 * HOUR - 60_000;
    case "daily":
      return new Date(last).toDateString() !== now.toDateString();
    case "nightly":
      return last < lastNightStart(now).getTime();
  }
}

/** The most recent night window (01:00 by default) on a weekday, 0 = Sunday. */
export function lastWeekdayStart(day: number, now = new Date()): Date {
  const d = lastNightStart(now);
  while (d.getDay() !== day) d.setDate(d.getDate() - 1);
  return d;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A source's weekday from `[source.<key>] day` ("monday"), if set. */
export function sourceDay(key: string): number | undefined {
  const i = DAYS.indexOf(String(loadConfig().source[key]?.day ?? "").toLowerCase());
  return i >= 0 ? i : undefined;
}

/** A source's run gap from `[source.<key>] every_hours`, if set. */
export function sourceEveryHours(key: string): number | undefined {
  const n = Number(loadConfig().source[key]?.every_hours);
  return n > 0 ? n : undefined;
}

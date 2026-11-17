import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { passes, profileStates } from "../ats/filters.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { setProviders } from "../providers/registry.ts";
import { METROS, wordsOf } from "./metros.ts";
import { placesFrom, placesOf } from "./places.tsx";
import { savePositioning, saveProfile, setDataDir, setLimit, status } from "./state.ts";

const data = tempData();
afterAll(data.cleanup);
afterEach(() => setProviders(null));

test("cloud-synced data folders are refused", () => {
  expect(() =>
    setDataDir(path.join(os.homedir(), "Library/Mobile Documents/com~apple~CloudDocs/JobSignal")),
  ).toThrow("cloud-synced");
});

test("profile, filters and the positioning chat's output are saved to me/", async () => {
  await saveProfile({
    full_name: "Sam Example",
    email: "sam@example.com",
    filters: { locations: ["London"], remote_ok: true },
    nope: 1,
  });
  const p = JSON.parse(readFileSync(paths.me("profile.json"), "utf8"));
  expect(p).toEqual({
    full_name: "Sam Example",
    email: "sam@example.com",
    filters: { locations: ["London"], remote_ok: true },
  });
  // Settings sends the filters it edits: the cities set by hand stay.
  writeFileSync(
    paths.me("profile.json"),
    JSON.stringify({ ...p, filters: { ...p.filters, metros: { London: ["London"] } } }),
  );
  await saveProfile({ filters: { locations: ["London", "Leeds"], remote_ok: false } });
  expect(JSON.parse(readFileSync(paths.me("profile.json"), "utf8")).filters).toEqual({
    locations: ["London", "Leeds"],
    remote_ok: false,
    metros: { London: ["London"] },
  });
  savePositioning(
    "# Positioning\n\n## Proofs\n- x",
    '{"claim":"a","url":"https://a.dev"}\nnot json\n{"claim":"b","url":"https://b.dev"}',
  );
  expect(readFileSync(paths.me("evidence.jsonl"), "utf8").trim().split("\n").length).toBe(2);
});

test("a spend limit set in Settings is one line of config.toml; the rest stays as written", () => {
  writeFileSync(
    paths.config(),
    '[caps]\nmonth_usd = 5 # mine\nrun_provider_usd = 0.15\n\n[runner]\nmode = "x"\n',
  );
  setLimit("caps", "month_usd", "12.5");
  setLimit("discovery", "exa_month_usd", 3);
  expect(readFileSync(paths.config(), "utf8")).toBe(
    '[caps]\nmonth_usd = 12.5\nrun_provider_usd = 0.15\n\n[runner]\nmode = "x"\n\n[discovery]\nexa_month_usd = 3\n',
  );
  expect(() => setLimit("caps", "month_usd", "-1")).toThrow("0 or more");
  expect(() => setLimit("robots", "exceptions", 1)).toThrow("Unknown limit");
});

test("board search's monthly count is a limit too: a whole number in its dotted section, shown back", async () => {
  writeFileSync(
    paths.config(),
    '[caps]\nmonth_usd = 5\n\n[source.board-search]\non = true\nmonth_credits = 1000 # spare\n\n[source.funds]\npicks = ["a"]\n',
  );
  setLimit("source.board-search", "month_credits", "499.6");
  expect(readFileSync(paths.config(), "utf8")).toBe(
    '[caps]\nmonth_usd = 5\n\n[source.board-search]\non = true\nmonth_credits = 500\n\n[source.funds]\npicks = ["a"]\n',
  );
  const shown = (await status()).limits.find((l) => l.key === "month_credits");
  expect(shown).toMatchObject({ section: "source.board-search", count: true, usd: 500 });
});

test("a picked metro brings its towns and reads as American without taking its whole state", () => {
  const bay = METROS.find((m) => m.name === "San Francisco Bay Area")!;
  const f = { ...placesOf([{ name: bay.name, words: wordsOf(bay) }]), remote_ok: false };
  expect(profileStates(f.locations)).toEqual(["CA"]);
  expect(passes({ title: "Engineer", location: "Palo Alto, CA" }, f)).toBe(true);
  expect(passes({ title: "Engineer", location: "Los Angeles, CA" }, f)).toBe(false);
  // Places kept by hand (a city's own words, a place no city holds) come back as they were.
  const kept = { locations: ["Denver", "CO", "London"], metros: { Colorado: ["Denver", "CO"] } };
  expect(placesOf(placesFrom(kept)).metros).toEqual({ Colorado: ["Denver", "CO"], London: ["London"] });
});

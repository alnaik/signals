// The Source contract (section 6): fetch(since) → leads. Every source is optional.
import type { DomainFrom } from "./companies.ts";

export type Lead = {
  url: string;
  ref?: string; // the signal's identity when not its url: one post naming several companies
  text?: string;
  author?: string;
  company_hint?: string; // a name or a domain
  domain?: string; // set when the source knows the company's domain
  domain_from?: DomainFrom; // its proof, when not the signal's own statement ("stated")
  seen_at?: string;
  posted_at?: string; // for job postings: when it was posted
  max_age_days?: number | null; // stale past this (default: config postings.max_age_days); null: never
  source: string; // source key
  source_tag: string; // what the board shows: "X bookmark", "ATS change", ...
  kind?: "post" | "posting" | "person" | "company";
  title?: string;
  location?: string;
  note?: string; // a hint from the producer, never a fact
  funding?: { form: "D"; date: string; url: string; cik: string }; // a Form D filing: kept on the company
};

export type Schedule = "every_tick" | "every_6h" | "daily" | "nightly" | "manual";

export type Source = {
  key: string;
  name: string;
  schedule: Schedule;
  connected: () => boolean | Promise<boolean>;
  fetch: (since: Date | null, now?: Date) => Promise<Lead[]>;
  read?: number; // set by fetch when it examined more than it returned: the rail shows "kept / read"
  note?: string; // set by fetch: what else the rail's line says ("3 named by nothing")
  off?: boolean; // off until switched on in Settings
  status?: () => string | undefined; // a line for Settings: why it does nothing, what it may spend
  paused?: () => string | undefined; // set while it waits on a limit: why, and until when
  // A source that filters what it takes in: does a signal it took still pass the person's filters?
  // Saving filters drops those that don't (intake/prune.ts), and forget lets it take them again.
  stillPasses?: (s: { text: string | null; title: string | null; location: string | null }) => boolean;
  keys?: string[]; // the signals' source keys stillPasses checks, when not just `key`
  forget?: (refs: string[]) => void;
};

export type Job = {
  name: string;
  schedule: Schedule;
  run: () => Promise<string | undefined> | string | undefined;
};

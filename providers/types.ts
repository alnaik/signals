// The provider contract (section 6): one file per tool, declaring its capabilities,
// whether it needs a key, and its cost per call.
// map: a site's own URLs, optionally narrowed to a topic ("careers"); run by name, not in a waterfall.
export type Capability = "search" | "read" | "people" | "contact" | "map";

export type SearchOpts = {
  n?: number;
  category?: "company" | "people" | "news";
  includeDomains?: string[];
  since?: string;
};
export type SearchResult = { url: string; title: string; snippet: string; publishedDate?: string };
export type ReadOpts = { site?: boolean; max_pages?: number };
export type ReadResult = {
  url: string;
  text: string;
  fetched_at: string;
  title?: string;
  pages?: { url: string; text: string }[];
};
export type Person = { name: string; role: string; profile_urls: string[]; source: string };
export type Confidence = "verified" | "pattern" | "guessed";
export type ContactHit = {
  channel: string;
  value: string;
  confidence: Confidence;
  source: string;
  url?: string;
};
export type PersonRef = Person & { domain: string; github?: string };

export type Provider = {
  name: string; // the key used in config and in the log ("exa")
  label: string; // shown on the board ("Exa")
  price?: string; // one plain line for Settings and first run: free each month, one use's cost, the date checked
  key?: string; // Keychain secret it needs, if any
  cost: Partial<Record<Capability, number>>; // USD per call (or per page for read)
  available?: () => boolean;
  search?: (query: string, opts: SearchOpts) => Promise<SearchResult[]>;
  read?: (url: string, opts: ReadOpts) => Promise<ReadResult>;
  // company: the name to search by, when it is known (People Search finds nothing by domain).
  people?: (domain: string, roles: string[], company?: string) => Promise<Person[]>;
  contact?: (person: PersonRef) => Promise<ContactHit[]>;
  map?: (domain: string, opts: { search?: string; max?: number }) => Promise<SearchResult[]>;
  /** Actual cost of a call when it differs from the declared cost (e.g. pages crawled). Given
   * the call's result, so two calls running at once each get their own cost. */
  lastCost?: (result?: unknown) => number | undefined;
  /** What a call used in the provider's own units ({credits: 2}), kept in the ledger beside its cost. */
  lastUsage?: (result?: unknown) => Record<string, number> | undefined;
  // A call's price when it depends on its arguments (a crawl's page cap); else cost[cap].
  estimate?: (cap: Capability, args: unknown[]) => number | undefined;
};

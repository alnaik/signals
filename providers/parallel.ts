// Parallel: the Task API for live web research on the hard cases the cheap path leaves empty
// (a source and confidence per field, output.basis), and the Search API. Not in any default
// order: switched on from Settings. [provider.parallel] processor (Task) and search_mode (Search).
// API shapes and prices from docs.parallel.ai and parallel.ai/pricing, checked again 2026-11-12
// (unchanged; not called live: no key here). Free: $5 of credit a month with a card on file.
// Search runs in basic mode by default ($0.005); turbo and fast are $0.001. No Extract call here.
import { loadConfig } from "../core/config.ts";
import { getSecret } from "../core/keychain.ts";
import { api } from "./http.ts";
import type { ContactHit, Person, Provider, SearchResult } from "./types.ts";

const BASE = "https://api.parallel.ai/v1/tasks/runs";
const SEARCH = "https://api.parallel.ai/v1/search";
// USD per Task run, by processor.
const PRICES: Record<string, number> = {
  lite: 0.005,
  base: 0.01,
  core: 0.025,
  core2x: 0.05,
  pro: 0.1,
  ultra: 0.3,
};
// USD per Search request with up to 10 results, by mode; each result past 10 is $0.001.
const SEARCH_PRICES: Record<string, number> = { turbo: 0.001, fast: 0.001, basic: 0.005, advanced: 0.005 };
const processor = () => String(loadConfig().provider.parallel?.processor ?? "base");
const searchMode = () => String(loadConfig().provider.parallel?.search_mode ?? "basic");
const searchPrice = (n = 10) => (SEARCH_PRICES[searchMode()] ?? 0.005) + Math.max(0, n - 10) * 0.001;
const headers = () => ({ "x-api-key": getSecret("parallel") ?? "" });

type Basis = { field: string; citations?: { url: string }[]; confidence?: string | null };
type Result = { run: { status: string }; output: { type: string; content: unknown; basis?: Basis[] } };

async function task(input: string, schema: Record<string, unknown>): Promise<Result["output"]> {
  const { run_id } = await api<{ run_id: string }>(BASE, {
    headers: headers(),
    body: {
      processor: processor(),
      input,
      task_spec: { output_schema: { type: "json", json_schema: schema } },
    },
  });
  for (let i = 0; i < 10; i++) {
    try {
      return (
        await api<Result>(`${BASE}/${run_id}/result?timeout=300`, { headers: headers(), timeoutMs: 320_000 })
      ).output;
    } catch (err) {
      if ((err as { status?: number }).status !== 408) throw err;
    }
  }
  throw new Error("parallel: run did not finish");
}

const sourceOf = (basis: Basis[] | undefined, field: string) => basis?.find((b) => b.field === field);

const parallel: Provider = {
  name: "parallel",
  label: "Parallel",
  price:
    "Free each month: $5 with a card on file. A web search is $0.005; a people or email lookup $0.01. Prices checked 12 Nov 2026.",
  key: "parallel",
  // Priced from config's processor and search mode, so the monthly cap sees it before the call.
  get cost() {
    const run = PRICES[processor()] ?? 0.01;
    return { search: searchPrice(), people: run, contact: run };
  },
  estimate: (cap, args) => (cap === "search" ? searchPrice((args[1] as { n?: number })?.n) : undefined),
  search: async (query, opts): Promise<SearchResult[]> => {
    type Search = {
      results: { url: string; title?: string | null; publish_date?: string | null; excerpts?: string[] }[];
    };
    const policy = {
      ...(opts.includeDomains?.length ? { include_domains: opts.includeDomains } : {}),
      ...(opts.since ? { after_date: opts.since.slice(0, 10) } : {}),
    };
    const r = await api<Search>(SEARCH, {
      headers: headers(),
      body: {
        objective: query,
        search_queries: [query],
        mode: searchMode(),
        advanced_settings: {
          max_results: opts.n ?? 10,
          excerpt_settings: { max_chars_per_result: 500 },
          ...(Object.keys(policy).length ? { source_policy: policy } : {}),
        },
      },
    });
    return (r.results ?? []).map((x) => ({
      url: x.url,
      title: x.title ?? "",
      snippet: (x.excerpts ?? []).join(" … ").slice(0, 500),
      ...(x.publish_date ? { publishedDate: x.publish_date } : {}),
    }));
  },
  people: async (domain, roles): Promise<Person[]> => {
    const out = await task(
      `People at the company with website ${domain} in these roles: ${roles.join(", ")}.`,
      {
        type: "object",
        properties: {
          people: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string" },
                profile_url: { type: "string" },
              },
              required: ["name", "role", "profile_url"],
              additionalProperties: false,
            },
          },
        },
        required: ["people"],
        additionalProperties: false,
      },
    );
    const people =
      (out.content as { people?: { name: string; role: string; profile_url: string }[] }).people ?? [];
    return people.map((p) => ({
      name: p.name,
      role: p.role,
      profile_urls: p.profile_url ? [p.profile_url] : [],
      source: "parallel",
    }));
  },
  contact: async (person): Promise<ContactHit[]> => {
    const out = await task(
      `Public work email and X handle of ${person.name}, ${person.role} at ${person.domain}.`,
      {
        type: "object",
        properties: { email: { type: "string" }, x_handle: { type: "string" } },
        required: ["email", "x_handle"],
        additionalProperties: false,
      },
    );
    const c = out.content as { email?: string; x_handle?: string };
    const hits: ContactHit[] = [];
    for (const [field, channel, value] of [
      ["email", "email", c.email],
      ["x_handle", "x", c.x_handle],
    ] as const) {
      if (!value || !/\S/.test(value) || /unknown|not found|n\/a/i.test(value)) continue;
      const b = sourceOf(out.basis, field);
      const confident = (b?.citations?.length ?? 0) > 0 && b?.confidence === "high";
      hits.push({
        channel,
        value,
        confidence: confident ? "verified" : "guessed",
        source: "parallel",
        url: b?.citations?.[0]?.url,
      });
    }
    return hits;
  },
};

export default parallel;

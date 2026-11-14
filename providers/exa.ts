// Exa: search (incl. the "people" and "company" categories), page contents, and email
// enrichment through an Agent run ($0.02 per email found). Exa reports each call's cost. A new
// account gets $10 of credits a month, no card (about 1,400 searches at $0.007). Checked against
// exa.ai/docs and exa.ai/pricing, 2026-11-12; one live search answered, billed $0.007.
import { getSecret } from "../core/keychain.ts";
import { api } from "./http.ts";
import type { ContactHit, Person, Provider } from "./types.ts";

const BASE = "https://api.exa.ai";
// What each call cost, as Exa reported it, kept with the result it belongs to: a module-level
// "last" would give a failed call the one before's cost, and mix up two calls running at once.
const spent = new WeakMap<object, number>();
function priced<T extends object>(result: T, usd: number | undefined): T {
  if (usd !== undefined) spent.set(result, usd);
  return result;
}
const headers = () => ({ "x-api-key": getSecret("exa") ?? "" });

type ExaResult = {
  url: string;
  title?: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
  author?: string | null;
};
type ExaResponse = { results: ExaResult[]; costDollars?: { total?: number } };

async function exaSearch(body: Record<string, unknown>): Promise<{ results: ExaResult[]; usd?: number }> {
  const r = await api<ExaResponse>(`${BASE}/search`, { headers: headers(), body });
  return { results: r.results ?? [], usd: r.costDollars?.total };
}

/** "Maya Chen - Head of Engineering - Tessera | LinkedIn" → name, role. */
export function personFromTitle(title: string): { name: string; role: string } {
  const clean = title.replace(/\s*[|·]\s*LinkedIn.*$/i, "");
  const [name = "", ...rest] = clean.split(/\s+[-–—]\s+/);
  return {
    name: name.trim(),
    role: rest
      .join(" - ")
      .replace(/\s+at\s+.*$/i, "")
      .trim(),
  };
}

const exa: Provider = {
  name: "exa",
  label: "Exa",
  price:
    "Free each month: $10, no card. A web search is about $0.007; a page read $0.001. Prices checked 12 Nov 2026.",
  key: "exa",
  // contact: a low-effort Agent run bills a flat $0.025, plus $0.02 for an email found (Exa's
  // pricing page, 2026-10-27); effort "low" is the ceiling, since the API refuses a budget with it.
  cost: { search: 0.007, read: 0.001, people: 0.007, contact: 0.045 },
  lastCost: (r) => (r && typeof r === "object" ? spent.get(r) : undefined),
  // `estimated`: Exa gave no cost, so the price list's was recorded.
  lastUsage: (r) => (r && typeof r === "object" && spent.has(r) ? undefined : { estimated: 1 }),
  search: async (query, opts) => {
    const { results, usd } = await exaSearch({
      query,
      numResults: opts.n ?? 10,
      ...(opts.category ? { category: opts.category } : {}),
      ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
      ...(opts.since && opts.category !== "people" && opts.category !== "company"
        ? { startPublishedDate: opts.since }
        : {}),
      contents: { highlights: { maxCharacters: 500 } },
    });
    return priced(
      results.map((r) => ({
        url: r.url,
        title: r.title ?? "",
        snippet: (r.highlights ?? []).join(" … ") || (r.text ?? "").slice(0, 500),
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      })),
      usd,
    );
  },
  read: async (url) => {
    const r = await api<ExaResponse>(`${BASE}/contents`, {
      headers: headers(),
      body: { urls: [url], text: true },
    });
    const page = r.results?.[0];
    if (!page?.text) throw new Error("exa: no text for that page");
    return priced(
      { url: page.url, title: page.title, text: page.text, fetched_at: new Date().toISOString() },
      r.costDollars?.total,
    );
  },
  people: async (domain, roles): Promise<Person[]> => {
    const { results, usd } = await exaSearch({
      query: `${roles.join(" or ")} at ${domain}`,
      category: "people",
      numResults: 10,
    });
    return priced(
      results
        .map((r) => ({ ...personFromTitle(r.title ?? ""), profile_urls: [r.url], source: "exa" }))
        .filter((p) => p.name),
      usd,
    );
  },
  contact: async (person): Promise<ContactHit[]> => {
    type Run = {
      id: string;
      status: string;
      output?: { structured?: { email?: string }; grounding?: unknown[] };
      costDollars?: { total?: number };
    };
    let run = await api<Run>(`${BASE}/agent/runs`, {
      headers: headers(),
      body: {
        query: `Work email address of ${person.name}, ${person.role} at the company whose website is ${person.domain}.`,
        // A fixed effort bills a flat price; Exa rejects `budget` with anything but auto/ultra.
        effort: "low",
        outputSchema: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
        },
      },
    });
    for (let i = 0; i < 60 && !["completed", "failed", "cancelled"].includes(run.status); i++) {
      await Bun.sleep(3000);
      run = await api<Run>(`${BASE}/agent/runs/${run.id}`, { headers: headers() });
    }
    // A run that never finished has no cost yet: the price list's estimate is recorded.
    const usd = run.costDollars?.total;
    const email = run.output?.structured?.email;
    if (run.status !== "completed" || !email) return priced([], usd);
    // An email Exa found with a cited source counts as confirmed by that source.
    const cited = (run.output?.grounding ?? []).length > 0;
    return priced(
      [{ channel: "email", value: email, confidence: cited ? "verified" : "pattern", source: "exa" }],
      usd,
    );
  },
};

export default exa;

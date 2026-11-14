// Hunter's Email Finder (free plan: 50 credits a month; a credit is spent only when an email is
// found; the Starter plan is $49 for 2,000 a month, checked on hunter.io/pricing 2026-11-12).
// Hunter's own deliverability check doesn't count as confirmation here: an email is
// `verified` only when Hunter cites a public page that shows it, otherwise `pattern`.
// Out of credits, the call fails and the waterfall moves on.
import { getSecret } from "../core/keychain.ts";
import { api, splitName } from "./http.ts";
import type { ContactHit, Provider } from "./types.ts";

type Found = {
  data?: { email?: string | null; score?: number; sources?: { uri?: string; still_on_page?: boolean }[] };
};

const hunter: Provider = {
  name: "hunter",
  label: "Hunter",
  price:
    "Free each month: 50 credits. One credit per email found, none when it finds nothing (about $0.025 each on the $49 plan of 2,000). Prices checked 12 Nov 2026.",
  key: "hunter",
  cost: { contact: 0 },
  contact: async (person): Promise<ContactHit[]> => {
    const { first, last } = splitName(person.name);
    if (!first || !last) return [];
    const q = new URLSearchParams({ domain: person.domain, first_name: first, last_name: last });
    const r = await api<Found>(`https://api.hunter.io/v2/email-finder?${q}`, {
      headers: { "x-api-key": getSecret("hunter") ?? "" },
      timeoutMs: 20_000,
    });
    const email = r.data?.email;
    if (!email) return [];
    const page = r.data?.sources?.find((s) => s.uri && s.still_on_page !== false)?.uri;
    return [
      {
        channel: "email",
        value: email,
        confidence: page ? "verified" : (r.data?.score ?? 0) >= 70 ? "pattern" : "guessed",
        source: "hunter",
        ...(page ? { url: page } : {}),
      },
    ];
  },
};

export default hunter;

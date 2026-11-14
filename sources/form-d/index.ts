// Funding: SEC EDGAR Form D filings, from the daily form index (robots.txt disallows the
// cgi-bin feeds). Keyless, but SEC requires a User-Agent with a contact email: the one in About you.
// Two reads of the same index. Filings by watched companies (matched by name) are kept on the
// company as `funding` (the company page and Work read it); no Inbox row, no thread.
// And, when the profile's locations name a state: each new D's primary_doc.xml says where the
// issuer's principal office is; issuers in those states that sold at least `min_sold` (and aren't
// funds, real estate, banks or oil and gas) are a dated list of local companies that just raised.
// One that resolves to a domain becomes a signal ("funding") naming the company, which then has
// its board looked for; one that doesn't stays here, in sources/form-d.json. Related persons are never read or stored.

import { readFileSync } from "node:fs";
import { loadFilters, profileStates } from "../../ats/filters.ts";
import { loadConfig } from "../../core/config.ts";
import { politeGet } from "../../core/http.ts";
import { paths } from "../../core/paths.ts";
import { companyByDomain, type Funding, setFunding, watchedCompanies } from "../../intake/companies.ts";
import { resolveCompany } from "../../intake/resolve.ts";
import type { Lead, Source } from "../../intake/types.ts";
import { readSourceState, writeSourceState } from "../../signals/state.ts";

const cfg = () => loadConfig().source["form-d"] ?? {};
// SEC asks for a contact email in the User-Agent: config's, else the email in About you.
const userAgent = () => {
  const set = String(cfg().user_agent ?? "");
  if (set) return set;
  try {
    const email = String(JSON.parse(readFileSync(paths.me("profile.json"), "utf8")).email ?? "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `Job Signal ${email}` : "";
  } catch {
    return "";
  }
};
// Smallest raise that counts: below a million it's often a friends-and-family round or a club deal.
const minSold = () => Number(cfg().min_sold ?? 1_000_000);

// The fetch, swappable in tests.
let get: typeof politeGet = politeGet;
export function setGetter(fn: typeof politeGet | null): void {
  get = fn ?? politeGet;
}

export type { Funding };
export { profileStates };

const LEGAL = /\s+(?:inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|lp|l p)$/;

/** "Tessera Labs, Inc." → "tessera labs": legal suffixes go; "labs" or "technologies" tell companies apart. */
export function normalizeName(name: string): string {
  let n = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  while (LEGAL.test(n)) n = n.replace(LEGAL, "").trim();
  return n;
}

export function parseFormIndex(
  text: string,
): { form: string; company: string; cik: string; date: string; file: string }[] {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(D|D\/A)\s{2,}(.+?)\s{2,}(\d+)\s+(\d{8})\s+(edgar\/\S+)/);
    if (m) out.push({ form: m[1]!, company: m[2]!.trim(), cik: m[3]!, date: m[4]!, file: m[5]! });
  }
  return out;
}

function quarter(d: Date): string {
  return `${d.getUTCFullYear()}/QTR${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

// Names that are funds or property vehicles, skipped before their filing is fetched.
const NOT_A_COMPANY = /\b(fund|l\.\s?p\.?|lp|partners|series|spv|trust|properties)\b/i;
// Industry groups that raise without hiring the way a company does.
const NOT_HIRING =
  /pooled investment fund|^investing$|banking|insurance|real estate|reits|^residential$|^commercial$|^construction$|oil (and|&) gas/i;

export type PrimaryDoc = {
  name: string;
  city: string;
  state: string; // principal office (issuerAddress), not the state of incorporation
  phone: string;
  industry: string;
  sold: number | null;
};

const tag = (xml: string, name: string) =>
  xml
    .match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]
    ?.trim()
    .replace(/&amp;/g, "&") ?? "";

/** The issuer, its principal office, its industry group and how much it sold; nothing about people. */
export function parsePrimaryDoc(xml: string): PrimaryDoc | null {
  const issuer = tag(xml, "primaryIssuer");
  if (!issuer) return null;
  const address = tag(issuer, "issuerAddress");
  const sold = Number(tag(tag(xml, "offeringSalesAmounts"), "totalAmountSold"));
  return {
    name: tag(issuer, "entityName"),
    city: tag(address, "city"),
    state: tag(address, "stateOrCountry").toUpperCase(),
    phone: tag(issuer, "issuerPhoneNumber"),
    industry: tag(tag(xml, "industryGroup"), "industryGroupType"),
    sold: Number.isFinite(sold) ? sold : null,
  };
}

type Issuer = PrimaryDoc & Funding & { domain: string | null; shown?: boolean };
type State = { done: string[]; partial?: Record<string, string[]>; issuers?: Record<string, Issuer> };

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const money = (n: number | null) =>
  n === null ? "" : n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : `$${Math.round(n / 1e3)}K`;

const statesNow = () => profileStates(loadFilters().locations ?? []);

const formD: Source = {
  key: "form-d",
  name: "Funding (Form D)",
  schedule: "nightly",
  connected: () => /@/.test(userAgent()),
  status: () => {
    const states = statesNow();
    return states.length
      ? `new issuers in ${states.join(", ")} that sold ${money(minSold())}+`
      : "discovery by state off: no state in your locations (add “Colorado” or “Denver, CO”)";
  },
  fetch: async (_since, now = new Date()) => {
    const read0 = readSourceState<State>("form-d", { done: [] });
    const state = { ...read0, issuers: read0.issuers ?? {}, partial: read0.partial ?? {} };
    const { issuers, partial } = state;
    const states = statesNow();
    // Two watched companies with the same name: neither is matched.
    const names = new Map<string, number | null>();
    for (const c of watchedCompanies()) {
      const n = normalizeName(c.name);
      if (n.length >= 3) names.set(n, names.has(n) ? null : c.id);
    }
    const keep = (id: number, f: Funding) => setFunding(id, f);
    // The last 5 days, skipping days already read (indexes appear after each business day).
    for (let back = 1; back <= 5; back++) {
      const d = new Date(now.getTime() - back * 86_400_000);
      const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
      if (state.done.includes(ymd) || [0, 6].includes(d.getUTCDay())) continue;
      let text: string;
      try {
        text = (
          await get(`https://www.sec.gov/Archives/edgar/daily-index/${quarter(d)}/form.${ymd}.idx`, {
            accept: "text/plain",
            userAgent: userAgent(),
          })
        ).text;
      } catch (err) {
        if ((err as { status?: number }).status === 404 || (err as { status?: number }).status === 403)
          continue;
        throw err;
      }
      const read = new Set(partial[ymd] ?? []);
      let complete = true;
      for (const f of parseFormIndex(text)) {
        if (f.form !== "D") continue;
        const date = `${f.date.slice(0, 4)}-${f.date.slice(4, 6)}-${f.date.slice(6, 8)}`;
        const filing: Funding = {
          form: "D",
          date,
          url: `https://www.sec.gov/Archives/${f.file}`,
          cik: f.cik,
        };
        const watched = names.get(normalizeName(f.company));
        if (watched) keep(watched, filing);
        if (!states.length || watched) continue;
        // Discovery by state: only new filings (D, not D/A), only companies.
        const acc = f.file.match(/(\d{10}-\d{2}-\d{6})\.txt$/)?.[1];
        if (!acc || read.has(acc)) continue;
        if (NOT_A_COMPANY.test(f.company)) {
          read.add(acc);
          continue;
        }
        let xml: string;
        try {
          xml = (
            await get(
              `https://www.sec.gov/Archives/edgar/data/${f.cik}/${acc.replace(/-/g, "")}/primary_doc.xml`,
              {
                accept: "application/xml",
                userAgent: userAgent(),
              },
            )
          ).text;
        } catch (err) {
          if ((err as { status?: number }).status === 404) read.add(acc);
          else complete = false; // read again tomorrow; the day isn't done
          continue;
        }
        read.add(acc);
        const doc = parsePrimaryDoc(xml);
        if (!doc || !states.includes(doc.state) || NOT_HIRING.test(doc.industry)) continue;
        if ((doc.sold ?? 0) < minSold()) continue;
        const prev = issuers[f.cik];
        if (prev && prev.date >= date) continue;
        issuers[f.cik] = {
          ...doc,
          ...filing,
          domain: prev?.domain ?? null,
          ...(prev?.shown ? { shown: true } : {}),
        };
      }
      // A day is done only after a full pass; a partial one resumes where it stopped.
      if (complete) {
        state.done = [ymd, ...state.done].slice(0, 30);
        delete partial[ymd];
      } else partial[ymd] = [...read];
    }
    // Name → domain: rules only (a name you already know); a miss is asked again the next night.
    const leads: Lead[] = [];
    for (const i of Object.values(issuers)) {
      if (!i.domain) i.domain = await resolveCompany(i.name);
      if (!i.domain) continue;
      const f: Funding = { form: "D", date: i.date, url: i.url, cik: i.cik };
      const known = companyByDomain(i.domain);
      if (known) keep(known.id, f);
      if (i.shown) continue;
      i.shown = true;
      leads.push({
        url: i.url,
        domain: i.domain,
        company_hint: i.name,
        kind: "company",
        funding: f, // kept on the company the signal makes
        source: "form-d",
        source_tag: "funding",
        text: [
          `Raised ${money(i.sold)}`.trim(),
          `Form D filed ${i.date}`,
          [titleCase(i.city), i.state].filter(Boolean).join(", "),
        ].join(" · "),
        seen_at: now.toISOString(),
      });
    }
    // Issuers from more than 90 days ago leave the list, resolved or not.
    const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    for (const [cik, i] of Object.entries(issuers)) if (i.date < cutoff) delete issuers[cik];
    writeSourceState("form-d", state);
    return leads;
  },
};

export default formD;

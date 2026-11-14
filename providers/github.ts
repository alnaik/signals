// GitHub (free; a token in the Keychain as "github" lifts the rate limit from 60 to 5,000/hr):
// people from the company's GitHub org, channels from each person's own profile and commits.
// A channel from the person's own profile or own commit is `verified`. No SMTP probing, ever.
import { getSecret } from "../core/keychain.ts";
import { api } from "./http.ts";
import type { ContactHit, Person, Provider } from "./types.ts";

const API = "https://api.github.com";
const headers = () => {
  const token = getSecret("github");
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "JobSignal",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
};
export const gh = <T>(path: string) => api<T>(`${API}${path}`, { headers: headers(), timeoutMs: 20_000 });

type User = {
  login: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  email: string | null;
  twitter_username: string | null;
  html_url: string;
};

/** The org's website is this domain or a subdomain of it ("notacme.com" isn't "acme.com"). */
export function ownsDomain(blog: string, domain: string): boolean {
  try {
    const host = new URL(/^https?:\/\//i.test(blog) ? blog : `https://${blog}`).hostname.replace(
      /^www\./,
      "",
    );
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

const ROLE_WORDS =
  /\b(founder|co-?founder|ceo|cto|vp|head|director|lead|manager|principal|staff|recruit|talent|engineer)\w*/i;

export function roleFromBio(bio: string | null, company: string | null): string {
  const text = [bio, company].filter(Boolean).join(" · ");
  const m = text.match(new RegExp(`[^.·|\\n]*${ROLE_WORDS.source}[^.·|\\n]*`, "i"));
  return (m?.[0] ?? "").trim().slice(0, 80);
}

export function isNoreply(email: string): boolean {
  return /noreply|no-reply|users\.noreply\.github\.com/i.test(email);
}

// Each domain's org, looked up once: a Work run asks twice (its GitHub step, then people).
const orgs = new Map<string, Promise<string | null>>();

/** The company's GitHub org, by name guesses, then (with a token) GitHub's search for its name. */
export function orgFor(domain: string, name?: string): Promise<string | null> {
  let org = orgs.get(domain);
  if (!org) {
    org = findOrg(domain, name);
    orgs.set(domain, org);
  }
  return org;
}

async function findOrg(domain: string, name?: string): Promise<string | null> {
  const guesses = [domain.split(".")[0]!, domain.replace(/\./g, "-"), domain.replace(/\./g, "")];
  const owns = async (g: string) => {
    try {
      const org = await gh<{ login: string; blog: string | null }>(`/orgs/${g}`);
      // The org must point back at this domain, or it's someone else's org with the same name.
      return org.blog && ownsDomain(org.blog, domain) ? org.login : null;
    } catch {
      return null;
    }
  };
  for (const g of guesses) {
    const org = await owns(g);
    if (org) return org;
  }
  // The guesses miss orgs named otherwise (exa.ai's is exa-labs). Search costs about 6 calls,
  // so only with a token; a result counts only when its website is this domain.
  if (!getSecret("github")) return null;
  const q = `${name ?? domain.split(".")[0]} type:org`;
  const found = await gh<{ items: { login: string }[] }>(
    `/search/users?q=${encodeURIComponent(q)}&per_page=5`,
  ).catch(() => ({ items: [] }));
  for (const { login } of found.items) {
    if (guesses.some((g) => g.toLowerCase() === login.toLowerCase())) continue;
    const org = await owns(login);
    if (org) return org;
  }
  return null;
}

const github: Provider = {
  name: "github",
  label: "GitHub",
  cost: { people: 0, contact: 0 },
  people: async (domain, roles): Promise<Person[]> => {
    const org = await orgFor(domain);
    if (!org) return [];
    const members = await gh<{ login: string }[]>(`/orgs/${org}/public_members?per_page=50`);
    const out: Person[] = [];
    // Unauthenticated GitHub allows 60 requests an hour: look at fewer members without a token.
    for (const m of members.slice(0, getSecret("github") ? 30 : 10)) {
      const u = await gh<User>(`/users/${m.login}`);
      const role = roleFromBio(u.bio, u.company);
      out.push({ name: u.name ?? u.login, role, profile_urls: [u.html_url], source: "github" });
    }
    const wanted = roles.map((r) => r.toLowerCase());
    // People whose stated role matches what was asked for come first.
    return out.sort(
      (a, b) =>
        Number(wanted.some((w) => b.role.toLowerCase().includes(w))) -
        Number(wanted.some((w) => a.role.toLowerCase().includes(w))),
    );
  },
  contact: async (person): Promise<ContactHit[]> => {
    const login =
      person.github ??
      person.profile_urls.map((u) => u.match(/github\.com\/([\w-]+)\/?$/)?.[1]).find(Boolean) ??
      null;
    if (!login) return [];
    const u = await gh<User>(`/users/${login}`);
    const hits: ContactHit[] = [];
    const profile = u.html_url;
    if (u.email && !isNoreply(u.email))
      hits.push({
        channel: "email",
        value: u.email,
        confidence: "verified",
        source: "github profile",
        url: profile,
      });
    if (u.twitter_username)
      hits.push({
        channel: "x",
        value: `@${u.twitter_username}`,
        confidence: "verified",
        source: "github profile",
        url: profile,
      });
    hits.push({ channel: "github", value: login, confidence: "verified", source: "github", url: profile });
    if (!hits.some((h) => h.channel === "email")) {
      // Their own commits: the author email they chose to publish.
      try {
        const found = await gh<{ items: { commit: { author: { email: string } }; html_url: string }[] }>(
          `/search/commits?q=${encodeURIComponent(`author:${login}`)}&sort=author-date&order=desc&per_page=20`,
        );
        const commit = found.items.find((c) => !isNoreply(c.commit.author.email));
        if (commit)
          hits.push({
            channel: "email",
            value: commit.commit.author.email,
            confidence: "verified",
            source: "commit",
            url: commit.html_url,
          });
      } catch {}
    }
    return hits;
  },
};

export default github;

// GitHub issue and PR search, a raw source for proof candidates. Accepts GitHub's own
// qualifiers: `repo:org/x no:assignee reactions:>5 label:"help wanted" is:open`.
import { getSecret } from "../core/keychain.ts";
import { api } from "./http.ts";
import type { Provider } from "./types.ts";

const headers = () => {
  const token = getSecret("github");
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "JobSignal",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
};

type Issue = {
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  comments: number;
  reactions?: { total_count?: number };
  assignees?: { login: string }[];
  pull_request?: unknown;
  created_at: string;
};

const githubIssues: Provider = {
  name: "github-issues",
  label: "GitHub issues",
  cost: { search: 0 },
  search: async (query, opts) => {
    const r = await api<{ items: Issue[] }>(
      `https://api.github.com/search/issues?${new URLSearchParams({ q: query, per_page: String(opts.n ?? 10) })}`,
      { headers: headers(), timeoutMs: 20_000 },
    );
    return r.items.map((i) => ({
      url: i.html_url,
      title: `${i.pull_request ? "PR" : "Issue"}: ${i.title}`,
      snippet: [
        i.state,
        `${i.comments} comments`,
        `${i.reactions?.total_count ?? 0} reactions`,
        i.assignees?.length ? `assigned to ${i.assignees.map((a) => a.login).join(", ")}` : "no assignee",
        (i.body ?? "").replace(/\s+/g, " ").slice(0, 240),
      ].join(" · "),
      publishedDate: i.created_at,
    }));
  },
};

/** Duplicate check for a saved issue: who's assigned, and any open PR that references it. */
export async function duplicateCheck(issueUrl: string): Promise<string[]> {
  const m = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) return [];
  const [, owner, repo, n] = m;
  const flags: string[] = [];
  const issue = await api<Issue>(`https://api.github.com/repos/${owner}/${repo}/issues/${n}`, {
    headers: headers(),
  });
  if (issue.assignees?.length) flags.push(`assigned to ${issue.assignees.map((a) => a.login).join(", ")}`);
  if (issue.state !== "open") flags.push(`issue is ${issue.state}`);
  const events = await api<{ event: string; source?: { issue?: Issue & { pull_request?: unknown } } }[]>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${n}/timeline?per_page=100`,
    { headers: headers() },
  ).catch(() => []);
  for (const e of events) {
    const src = e.source?.issue;
    if (e.event === "cross-referenced" && src?.pull_request && src.state === "open")
      flags.push(`open PR: ${src.html_url}`);
  }
  return flags;
}

export default githubIssues;

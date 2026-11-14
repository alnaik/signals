import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { deleteSecret } from "../core/keychain.ts";
import { setSignedIn } from "../core/model.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import stars from "./github-stars/index.ts";

const { cleanup } = tempData();
afterAll(cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const repo = (full: string, type: string, extra: Record<string, unknown> = {}) => ({
  starred_at: "2026-11-01T00:00:00Z",
  repo: {
    full_name: full,
    html_url: `https://github.com/${full}`,
    name: full.split("/")[1],
    description: null,
    fork: false,
    owner: { login: full.split("/")[0], type },
    ...extra,
  },
});
const ORGS: Record<string, { name: string; blog: string | null; description: string | null }> = {
  acme: { name: "Acme", blog: "https://www.acme.ai", description: "We build rockets" },
  nosite: { name: "No Site", blog: null, description: null },
  pages: { name: "Pages", blog: "https://pages.github.io", description: null },
  pyfound: { name: "The Py Foundation", blog: "https://py.dev", description: null },
  orgproj: { name: "Proj", blog: "https://proj.org", description: null },
  huggingface: { name: "Hugging Face", blog: "https://huggingface.co", description: null },
  hfmirror: { name: "Mirror", blog: "https://huggingface.co/mirror", description: null },
};

test("a star becomes a lead only for an organisation that is plainly a company, once; a person's never", async () => {
  writeFileSync(paths.config(), '[source.github-stars]\nuser = "sam"\n');
  setSignedIn({ in: false, plan: null }); // no model: the plain rules alone
  deleteSecret("anthropic");
  const asked: string[] = [];
  let list = [
    repo("acme/tool", "Organization"),
    repo("acme/other", "Organization"),
    repo("sam/dotfiles", "User"),
    repo("nosite/x", "Organization"),
    repo("pages/x", "Organization"),
    repo("pyfound/x", "Organization"),
    repo("orgproj/x", "Organization"),
    repo("huggingface/transformers", "Organization"),
    repo("hfmirror/x", "Organization"),
  ];
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const headers = { "x-ratelimit-remaining": "50" };
    if (path === "/users/sam/starred") return Response.json(list, { headers });
    const org = ORGS[path.replace("/orgs/", "")];
    return org
      ? Response.json({ login: path.slice(6), ...org }, { headers })
      : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const leads = await stars.fetch(null);
  expect(leads.map((l) => [l.company_hint, l.domain, l.domain_from, l.text, l.url])).toEqual([
    [
      "Acme",
      "acme.ai",
      "looked up",
      "You starred acme/tool · We build rockets",
      "https://github.com/acme/tool",
    ],
    [
      "Hugging Face",
      "huggingface.co",
      "looked up",
      "You starred huggingface/transformers",
      "https://github.com/huggingface/transformers",
    ],
  ]);
  expect(asked.filter((p) => p.startsWith("/orgs/")).length).toBe(7); // each organisation once, no person
  // The next run: only the newest page, and only a new star is looked at.
  asked.length = 0;
  list = [repo("acme/third", "Organization"), ...list];
  expect(await stars.fetch(null)).toEqual([]);
  expect(asked).toEqual(["/users/sam/starred"]);
});

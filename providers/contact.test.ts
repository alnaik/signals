import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { append } from "../core/log.ts";
import { paths } from "../core/paths.ts";
import { tempData } from "../core/testing.ts";
import { findContact, merge } from "./contact.ts";
import github, { isNoreply, roleFromBio } from "./github.ts";
import pattern, { formatOf, render } from "./pattern.ts";
import { setProviders } from "./registry.ts";
import type { ContactHit, Provider } from "./types.ts";

const data = tempData();
afterAll(data.cleanup);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setProviders(null);
});
const person = {
  name: "Maya Chen",
  role: "Head of Engineering",
  profile_urls: [],
  source: "w",
  domain: "tessera.dev",
};

test("email formats are learned from a known verified address at the domain", async () => {
  expect(formatOf("Lena Ortiz", "lena.ortiz@tessera.dev")).toBe("first.last");
  expect(formatOf("Lena Ortiz", "lortiz@tessera.dev")).toBe("flast");
  expect(render("first.last", "José Núñez")).toBe("jose.nunez");
  // No example at the domain: no address, never a guessed first@domain.
  expect(await pattern.contact!(person)).toEqual([]);
  append("tessera.dev", {
    actor: "worker",
    kind: "contact",
    data: {
      name: "Lena Ortiz",
      role: "CTO",
      channels: [{ channel: "email", value: "lortiz@tessera.dev", confidence: "verified" }],
    },
  });
  expect(await pattern.contact!(person)).toEqual([
    { channel: "email", value: "mchen@tessera.dev", confidence: "pattern", source: "company email format" },
  ]);
});

test("merge keeps the strongest confidence and drops weaker emails beside a verified one", () => {
  const hits: ContactHit[] = [
    { channel: "email", value: "maya@tessera.dev", confidence: "guessed", source: "p" },
    { channel: "email", value: "Maya@tessera.dev", confidence: "verified", source: "commit" },
    { channel: "email", value: "mchen@tessera.dev", confidence: "pattern", source: "p" },
    { channel: "x", value: "@mayachen", confidence: "verified", source: "gh" },
  ];
  expect(merge(hits).map((h) => `${h.channel}:${h.value}:${h.confidence}`)).toEqual([
    "email:Maya@tessera.dev:verified",
    "x:@mayachen:verified",
  ]);
});

test("the waterfall stops at the first verified email and never calls later providers", async () => {
  writeFileSync(paths.config(), '[providers]\ncontact = ["a", "b", "c"]\n');
  const called: string[] = [];
  const p = (name: string, hits: ContactHit[]): Provider => ({
    name,
    label: name,
    cost: { contact: 0.01 },
    contact: async () => {
      called.push(name);
      return hits;
    },
  });
  setProviders([
    p("a", [{ channel: "x", value: "@maya", confidence: "verified", source: "a" }]),
    p("b", [{ channel: "email", value: "maya@tessera.dev", confidence: "verified", source: "b" }]),
    p("c", [{ channel: "email", value: "m@tessera.dev", confidence: "pattern", source: "c" }]),
  ]);
  const r = await findContact(person, { station: "test" });
  expect(called).toEqual(["a", "b"]);
  expect(r.hits.map((h) => h.channel)).toEqual(["x", "email"]);
});

test("github: profile and commit emails are verified; noreply addresses are ignored", async () => {
  expect(isNoreply("123+maya@users.noreply.github.com")).toBe(true);
  expect(roleFromBio("CTO at Tessera. Ex-Larkspur Freight.", null)).toBe("CTO at Tessera");
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/users/mayac"))
      return Response.json({
        login: "mayac",
        name: "Maya Chen",
        bio: null,
        company: null,
        blog: null,
        email: null,
        twitter_username: "mayachen",
        html_url: "https://github.com/mayac",
      });
    if (url.includes("/search/commits"))
      return Response.json({
        items: [
          {
            commit: { author: { email: "1+mayac@users.noreply.github.com" } },
            html_url: "https://github.com/c/1",
          },
          { commit: { author: { email: "maya@tessera.dev" } }, html_url: "https://github.com/c/2" },
        ],
      });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const hits = await github.contact!({ ...person, profile_urls: ["https://github.com/mayac"] });
  expect(hits.map((h) => [h.channel, h.value, h.confidence, h.source])).toEqual([
    ["x", "@mayachen", "verified", "github profile"],
    ["github", "mayac", "verified", "github"],
    ["email", "maya@tessera.dev", "verified", "commit"],
  ]);
});

test("there is no SMTP probing anywhere", async () => {
  const { Glob } = await import("bun");
  for (const f of new Glob("**/*.ts").scanSync({ cwd: import.meta.dir })) {
    if (f.endsWith(".test.ts")) continue;
    const src = await Bun.file(`${import.meta.dir}/${f}`).text();
    // No raw sockets and no mail-server dialogue in any provider.
    expect(/RCPT TO|EHLO|HELO |net\.connect|createConnection|:25\b/.test(src)).toBe(false);
  }
});

test("a GitHub org belongs to a company only when its website is that domain", async () => {
  const { ownsDomain } = await import("./github.ts");
  expect(ownsDomain("https://acme.com", "acme.com")).toBe(true);
  expect(ownsDomain("eng.acme.com/blog", "acme.com")).toBe(true);
  expect(ownsDomain("https://notacme.com", "acme.com")).toBe(false);
  expect(ownsDomain("https://example.org/?ref=acme.com", "acme.com")).toBe(false);
});

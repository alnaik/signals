// me/positioning.md: Who I'm for · Problems I solve · Not for · Proofs. Private. You edit
// it by hand; the worker reads it. Items marked public can be exported as a portfolio page.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../core/paths.ts";

export type Item = { id: string; text: string; public: boolean };
export type Section = { title: string; intro: string[]; items: Item[] };

export const itemId = (text: string) => createHash("sha256").update(text.trim()).digest("hex").slice(0, 10);
const file = () => paths.me("positioning.md");
const publicFile = () => paths.me("positioning-public.json");

export function readMarkdown(): string {
  return existsSync(file()) ? readFileSync(file(), "utf8") : "";
}

function publicSet(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(publicFile(), "utf8")));
  } catch {
    return new Set();
  }
}

/** Sections are `## ` headings; items are list lines (`- ` or `* `). */
export function parse(md = readMarkdown()): { title: string; sections: Section[] } {
  const pub = publicSet();
  const lines = md.split("\n");
  const title =
    lines
      .find((l) => l.startsWith("# "))
      ?.slice(2)
      .trim() ?? "Positioning";
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      cur = { title: line.slice(3).trim(), intro: [], items: [] };
      sections.push(cur);
    } else if (cur && /^\s*[-*]\s+/.test(line)) {
      const text = line.replace(/^\s*[-*]\s+/, "").trim();
      cur.items.push({ id: itemId(text), text, public: pub.has(itemId(text)) });
    } else if (cur && line.trim() && !line.startsWith("#")) cur.intro.push(line.trim());
  }
  return { title, sections };
}

export function setPublic(id: string, on: boolean): void {
  const pub = publicSet();
  on ? pub.add(id) : pub.delete(id);
  writeFileSync(publicFile(), JSON.stringify([...pub], null, 1));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown links in an item, made safe for HTML. */
export function inline(text: string): string {
  return esc(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
}

/** The portfolio: public items only, never the private page. */
export function portfolioHtml(name: string): string {
  const { sections } = parse();
  const body = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => i.public) }))
    .filter((s) => s.items.length)
    .map(
      (s) =>
        `<section><h2>${esc(s.title)}</h2><ul>${s.items.map((i) => `<li>${inline(i.text)}</li>`).join("")}</ul></section>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)}</title><style>
:root{--ink:#111;--muted:#5f5f5f;--line:#e5e5e5}
body{margin:0;background:#fff;color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:48px 16px}
h1{font-size:28px;font-weight:600;letter-spacing:-0.01em;margin:0 0 32px;border-top:2px solid var(--ink);padding-top:16px}
h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;border-bottom:1px solid var(--ink);padding-bottom:8px;margin:32px 0 8px}
ul{list-style:none;padding:0;margin:0}li{padding:10px 0;border-bottom:1px solid var(--line)}
a{color:var(--ink)}
</style></head><body><main><h1>${esc(name)}</h1>
${body}
</main></body></html>`;
}

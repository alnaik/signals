// `jobsignal repair boards` and `repair name`: put right what the boards table refuses to ship
// (ats/table.ts tableRow), in an install's own data. Each change is a line; --dry only says them.
//  - A name with a link written into it ("Baserow ( https://baserow.io )"): the link goes.
//  - A link to one posting held as a board: the company's own board or careers page moves to the
//    listing above it (its roles are kept, so what you set aside stays set aside); another
//    company's (Joby Aviation's iCIMS board, on Eniac Ventures) goes, and the company is looked
//    for again.
//  - A board that states another website (Amdocs held Eightfold's board for volkscience.com):
//    it goes, and the company is looked for again.
import { boardKey, boardUrl } from "../ats/reader.ts";
import { type BoardRow, listingOf, tableRow } from "../ats/table.ts";
import { markChanged, open, tx } from "../core/db.ts";
import { politeGet } from "../core/http.ts";
import { type Company, companyByName, getCompany, nameKey } from "./companies.ts";

// A link written into a name in brackets after it ("Baserow ( https://baserow.io )"). A name that is
// a whole line of a post ("Apply here: https://…") names no company: the Signals screen folds it.
const LINK_IN_NAME = /\s*\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi;

type Row = BoardRow & { id: number; company_id: number };

/** The name without the link written into it, or null when it has none. */
export function nameWithoutLink(name: string): string | null {
  const clean = name.replace(LINK_IN_NAME, "").replace(/\s+/g, " ").trim();
  return clean && clean !== name ? clean : null;
}

/** Rename a company; it is found by its old name and its new one. */
function rename(c: Company, name: string): void {
  const d = open();
  d.query("UPDATE companies SET name = ? WHERE id = ?").run(name, c.id);
  const known = d.query("INSERT OR IGNORE INTO company_names (name_key, company_id) VALUES (?, ?)");
  known.run(nameKey(c.name), c.id);
  known.run(nameKey(name), c.id);
}

/**
 * Is a job board's account this company's? Its key (slug or host) names the company's site or
 * name. Null when the company has no word long enough to tell (HP, 3M, ro.co): it is left as is.
 */
function theirs(b: Row, c: Company): boolean | null {
  const slug = b.key.slice(b.key.indexOf(":") + 1).replace(/[^a-z0-9]/g, "");
  const words = [c.domain?.split(".")[0], ...c.name.toLowerCase().split(/[^a-z0-9]+/)].filter(
    (w): w is string => !!w && w.length >= 3,
  );
  if (!words.length) return null;
  return words.some((w) => slug.includes(w.replace(/[^a-z0-9]/g, "")));
}

function dropBoard(b: Row, now: Date, why: string): void {
  const d = open();
  d.query("DELETE FROM role_text WHERE role_id IN (SELECT id FROM roles WHERE board_id = ?)").run(b.id);
  d.query("DELETE FROM roles WHERE board_id = ?").run(b.id);
  d.query("DELETE FROM boards WHERE id = ?").run(b.id);
  // Looked for again, unless it has another board that reads.
  d.query(
    `UPDATE companies SET discovery = 'queued', discovery_at = ?, discovery_note = ?, search_at = NULL
     WHERE id = ? AND NOT EXISTS (SELECT 1 FROM boards WHERE company_id = ? AND status = 'ok')`,
  ).run(now.toISOString(), why, b.company_id, b.company_id);
}

export function repairName(id: number, name: string, o: { dry?: boolean } = {}): string {
  const c = getCompany(id);
  if (!c) throw new Error(`No company ${id}`);
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("A name is needed");
  const other = companyByName(clean);
  if (other && other.id !== id) throw new Error(`${other.name} (${other.id}) has that name already`);
  if (!o.dry) rename(c, clean);
  return `${c.name} (${id}) → ${clean}`;
}

/**
 * Does the listing page answer? Read politely, as discovery reads a careers page. False only when
 * the site says it isn't there (404, 410); null when it couldn't tell (a timeout, robots.txt, a
 * refusal), and the board is left as it is.
 */
async function answers(url: string): Promise<boolean | null> {
  try {
    await politeGet(url, { accept: "text/html", maxBytes: 300_000 });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 404 || status === 410 ? false : null;
  }
}

export async function repairBoards(
  o: { dry?: boolean; answers?: (url: string) => Promise<boolean | null> } = {},
  now = new Date(),
): Promise<string[]> {
  const d = open();
  const check = o.answers ?? answers;
  const plan: { line: string; fn: () => void }[] = [];
  for (const c of d
    .query("SELECT * FROM companies WHERE name LIKE '%://%' OR name LIKE '%www.%'")
    .all() as Company[]) {
    const clean = nameWithoutLink(c.name);
    if (!clean) continue;
    const other = companyByName(clean);
    if (other && other.id !== c.id) {
      plan.push({
        line: `left: "${c.name}" (${c.id}); ${other.name} (${other.id}) has that name`,
        fn: () => {},
      });
      continue;
    }
    plan.push({ line: `name: "${c.name}" (${c.id}) → "${clean}"`, fn: () => rename(c, clean) });
  }
  const boards = d
    .query(
      `SELECT b.id, b.company_id, c.name, c.domain, c.domain_from, b.provider, b.url, b.key FROM boards b
       JOIN companies c ON c.id = b.company_id WHERE b.status = 'ok' ORDER BY c.name`,
    )
    .all() as Row[];
  for (const b of boards) {
    const r = tableRow(b);
    if (!("why" in r)) continue;
    const c = getCompany(b.company_id)!;
    const at = `${c.name} (${c.id}), ${b.url}`;
    const drop = (line: string, why: string) => plan.push({ line, fn: () => dropBoard(b, now, why) });
    const left = (line: string) => plan.push({ line, fn: () => {} });
    if (r.why === "a link to one posting, not a board") {
      const page = b.provider === "careers-page";
      const own = page || theirs(b, c);
      if (own === null) {
        left(`left: ${at}; its name is too short to tell whether the board is its own`);
        continue;
      }
      if (!own) {
        drop(
          `another company's posting, removed and looked for again: ${at}`,
          "its board was another company's posting",
        );
        continue;
      }
      // A job board's listing is the board itself, the same board by its key: jobs.lever.co/acme,
      // or the site's home where the account is its own host (acme.jobs.personio.de/).
      const to = page
        ? listingOf(b.url)
        : [boardUrl(b.provider, b.url), `${new URL(b.url).origin}/`].find(
            (u) => u !== b.url && boardKey(b.provider, u) === b.key,
          );
      if (!to || to === b.url) {
        left(`left: ${at}; no listing above it to move to`);
        continue;
      }
      const there = await check(to);
      if (there)
        plan.push({
          line: `one posting → its listing: ${at} → ${to}`,
          fn: () => {
            d.query("UPDATE boards SET url = ? WHERE id = ?").run(to, b.id);
            // The careers page it is known by moves with it.
            d.query("UPDATE companies SET careers_url = ? WHERE id = ? AND careers_url = ?").run(
              to,
              b.company_id,
              b.url,
            );
          },
        });
      else if (there === null) left(`left: ${at}; its listing at ${to} didn't answer, try again later`);
      else
        drop(
          `one posting, no listing at ${to}: removed and looked for again: ${at}`,
          "its careers page was one posting",
        );
    } else if (r.why === "its board states another website")
      drop(`another website's board, removed and looked for again: ${at}`, "its board was another website's");
  }
  if (!o.dry && plan.length)
    tx(() => {
      for (const p of plan) p.fn();
      markChanged(now);
    });
  return plan.map((p) => p.line);
}

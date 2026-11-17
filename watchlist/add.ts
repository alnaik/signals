// Add: paste a website, a careers page, a board URL, a posting or a company name. The company is
// watched, its board looked for (from what was pasted, when it names one) and read now, with
// progress on screen. Its roles that fit are on its Watchlist page; the new ones counted on its row
// and shown in the Inbox.
import { ATS_URL, boardSlug, label, nameWords, sharesWord } from "../ats/reader.ts";
import { open } from "../core/db.ts";
import { threadId } from "../core/log.ts";
import { failure } from "../core/trace.ts";
import {
  applyEmailOf,
  type Company,
  getCompany,
  unwatchCompany,
  upsertCompany,
  watchCompany,
} from "../intake/companies.ts";
import { discover } from "../intake/discover.ts";
import { isJobBoard, namesNoCompany, siteDomain } from "../intake/leads.ts";
import { refreshCompany, summary } from "../intake/refresh.ts";
import { resolveCompany } from "../intake/resolve.ts";
import { plainNote } from "../sources/pipeline.ts";

type Progress = (line: string) => void;

export { nameWords, sharesWord };

const titled = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "https://careers.zayo.com/jobs" → "zayo.com". A job board's address isn't a company, nor a page
 * on a host where people post (x.com/acme, acme.substack.com); the host itself is its own company's.
 */
export function companyFrom(input: string): string {
  const host = threadId(input);
  const d = host.replace(/^(?:careers|jobs|join|work)\./, "");
  if (isJobBoard(host) || isJobBoard(d) || (namesNoCompany(input) && !siteDomain(input)))
    throw new Error(
      `${d.includes(".") ? d : host} is a job board or someone's page, not a company: give the company's own website`,
    );
  return d;
}

export type Resolved = { domain: string | null; name: string; hint?: string; ask?: string };

/** What was pasted, as a company: its domain (when one is known), its name, a board or posting to start from. */
export async function resolve(input: string, name?: string): Promise<Resolved> {
  const s = input.trim();
  if (!s) throw new Error("Paste a website, a careers page, a board URL or a posting");
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const looksLikeUrl = /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s);
  if (looksLikeUrl && ATS_URL.test(url)) {
    // A board or a posting on a job board's host: the company comes from the slug. The board
    // itself is the company's board, so its website isn't needed to read it.
    const slug = boardSlug(url);
    if (!slug) throw new Error("That board URL has no company in it: paste the company's website");
    const who = name?.trim() || titled(slug);
    const domain = await resolveCompany(who).catch(() => null);
    return { domain, name: who, hint: url };
  }
  if (looksLikeUrl) {
    const domain = companyFrom(s);
    const path = new URL(url).pathname;
    const who = name?.trim() || titled(label(domain).split(".").at(-1)!);
    return {
      domain,
      name: who,
      ...(path.length > 1 ? { hint: url } : {}),
      ...(name && !sharesWord(name, label(domain)) ? { ask: `Add ${name} as ${domain}?` } : {}),
    };
  }
  const domain = await resolveCompany(s);
  if (!domain) throw new Error(`Couldn't find ${s}'s website: paste it instead`);
  return { domain, name: s, ...(sharesWord(s, label(domain)) ? {} : { ask: `Add ${s} as ${domain}?` }) };
}

export type BoardState = {
  provider: string | null; // "ashby", "careers-page", or null when none was found
  url: string | null;
  partial?: boolean; // read through its own search
  problem?: string;
  email?: string; // no board: it takes applications at this address
  careers?: string; // no board: a careers page seen
};

// Why a company has no board, in plain words: the look's notes are written for the bug report
// ("detection failed: timed out after 20s"). The first rule that fits says it; the rest of a note
// is kept, made plainer, when none does.
const PROBLEMS: [RegExp, string][] = [
  [/^looking for its board$/, "still looking for its job board"],
  [/^the board failed:/, "its job board stopped answering; it's being looked for again"],
  [/robots/i, "its website asks automated readers to stay out"],
  [/timed out/i, "its website took too long to answer"],
  [/domain doesn't resolve|ENOTFOUND/i, "its website's address doesn't work"],
  [/^certificate/, "its website's security certificate is broken"],
  [/\(removed \d{4}-\d\d-\d\d\)/, "the board found before was someone else's; no other found yet"],
  [
    /didn't load|ECONN|TLS|SSL|PROTOCOL_ERROR|HTTP [45]\d\d|Call log|net::|navigating to/i,
    "its careers page wouldn't load",
  ],
  [/^its careers page, checked:/, "its careers page says there are no openings right now"],
  [/is another site's|, which is .+'s board/, "the careers page it links to belongs to another site"],
  [/listed a LinkedIn URL/, "its listed website is a LinkedIn page"],
  [/careers page is read next/, "no job board found yet; its careers page is read next"],
  [/^no site known/, "its website wasn't found"],
  [/which no reader here reads|board can't be read/, "its roles are on a job site Job Signal can't read yet"],
  [/^(web search|sweep):/, "no job board of its own turned up in a web search"],
  [/no board found|pages fetched|no careers page/i, "no job board or careers page found on its website"],
];
export function plainProblem(note: string): string {
  const hit = PROBLEMS.find(([re]) => re.test(note));
  if (hit) return hit[1];
  return (plainNote(note.split(" · ")[0]!) ?? note).slice(0, 160);
}

export function boardOf(c: Company): BoardState {
  const b = open()
    .query(
      "SELECT provider, url, status, partial, last_error FROM boards WHERE company_id = ? AND status <> 'retired' ORDER BY status = 'ok' DESC, id LIMIT 1",
    )
    .get(c.id) as {
    provider: string;
    url: string;
    status: string;
    partial: number;
    last_error: string | null;
  } | null;
  if (b?.status === "ok")
    return { provider: b.provider, url: b.url, ...(b.partial ? { partial: true } : {}) };
  const email = applyEmailOf(c);
  return {
    provider: null,
    url: null,
    ...(b ? { problem: plainProblem("the board failed:") } : {}),
    ...(!b && c.discovery === "none" ? { problem: plainProblem(c.discovery_note ?? "no board found") } : {}),
    ...(!b && c.discovery === "blocked" ? { problem: plainProblem("robots") } : {}),
    ...(!b && c.discovery === "unreadable"
      ? { problem: plainProblem(c.discovery_note ?? "its careers page didn't load") }
      : {}),
    ...(!b && c.discovery === "queued" ? { problem: plainProblem("looking for its board") } : {}),
    ...(email ? { email: email.address } : {}),
    ...(c.careers_url ? { careers: c.careers_url } : {}),
  };
}

// One Add at a time: two Adds of one company would race to make it.
let chain: Promise<unknown> = Promise.resolve();

/** Watch the company, look for its board (from the hint, when there is one) and read it now. */
export function addNow(
  r: Resolved,
  progress: Progress = () => {},
  now = new Date(),
): Promise<{ companyId: number; board: BoardState }> {
  const run = async () => {
    let id = upsertCompany({ name: r.name, domain: r.domain }, now);
    watchCompany(id, "manual", now);
    try {
      const hasBoard = !!open().query("SELECT 1 FROM boards WHERE company_id = ? AND status = 'ok'").get(id);
      if (r.hint || !hasBoard) {
        progress(`looking for ${r.name}'s board`);
        const found = await discover([getCompany(id)!], now, r.hint);
        id = found[0]?.companyId ?? id;
      }
      const b = boardOf(getCompany(id)!);
      if (!b.provider) return { companyId: id, board: b };
      progress(`reading ${b.provider === "careers-page" ? "the careers page" : b.provider}`);
      const outs = await refreshCompany(id, now);
      const fit = (
        open()
          .query("SELECT count(*) AS n FROM roles WHERE company_id = ? AND fits = 1 AND closed_at IS NULL")
          .get(id) as { n: number }
      ).n;
      progress(`${fit} roles fit · ${summary(outs)}`);
      return { companyId: id, board: boardOf(getCompany(id)!) };
    } catch (err) {
      failure("add", r.name, err);
      return {
        companyId: id,
        board: { ...boardOf(getCompany(id)!), problem: plainProblem((err as Error).message) },
      };
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** The company's roles that fit, open now: what the CLI prints after an Add. */
export function fitting(companyId: number): { title: string; location: string; url: string }[] {
  return open()
    .query(
      "SELECT title, location, url FROM roles WHERE company_id = ? AND fits = 1 AND closed_at IS NULL ORDER BY first_seen DESC",
    )
    .all(companyId) as { title: string; location: string; url: string }[];
}

export const remove = (companyId: number) => unwatchCompany(companyId);

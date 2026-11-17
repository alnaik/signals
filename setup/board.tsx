import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ForApplying } from "../apply/applying.tsx";
import type { BoardFeature, Ctx, Store } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import { describeRow, type SpendRow } from "../report/spend-text.ts";
import { type Actions, JobMailForm } from "../sources/board.tsx";
import { type Place, Places, placesFrom, placesOf } from "./places.tsx";

type Status = {
  done: boolean;
  dataDir: string;
  cloudSynced: boolean;
  runner: string;
  model: {
    on: "subscription" | "api-key" | null;
    signedIn: boolean;
    plan: string | null;
    installed: boolean;
    key: boolean;
  };
  keys: { name: string; label: string; set: boolean; price: string | null }[];
  prices: string;
  connected: { x: boolean; gmail: boolean };
  profile: Record<string, unknown> & {
    filters?: {
      locations?: string[];
      metros?: Record<string, string[]>;
      remote_ok?: boolean;
      title_include?: string[];
      title_exclude?: string[];
    };
  };
  positioning: boolean;
  evidence: boolean;
  usage: SpendRow[];
  spend: {
    month: number;
    cap: number;
    history: {
      total: number;
      since: string | null;
      months: { month: string; total: number; by: Record<string, number> }[];
    };
  };
  providers: Record<string, ProviderRow[]>;
  limits: { section: string; key: string; label: string; count?: boolean; usd: number }[];
  prompt: string;
};
type ProviderRow = {
  name: string;
  label: string;
  available: boolean;
  missing: string | null;
  enabled: boolean;
  price: number | null;
  priceSource: "config" | "provider" | "reported";
  monthUsd: number;
};

const CAP_LABELS: [string, string][] = [
  ["search", "Search"],
  ["read", "Read pages"],
  ["people", "People"],
  ["contact", "Contact"],
];
const price = (p: number | null) => (p === null ? "—" : p === 0 ? "free" : `$${Number(p.toFixed(4))}`);

/** One chip per provider of a capability: the waterfall order, switched and priced here. */
function ProviderChips({
  cap,
  rows,
  send,
}: {
  cap: string;
  rows: ProviderRow[];
  send: (url: string, body: unknown) => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<{ name: string; usd: string } | null>(null);
  const on = rows.filter((r) => r.enabled).map((r) => r.name);
  const order = (next: string[]) => send("/api/setup/providers", { cap, order: next });
  const move = (name: string, by: -1 | 1) => {
    const i = on.indexOf(name);
    const next = [...on];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    return order(next);
  };
  const editing = rows.find((r) => r.name === edit?.name);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="chips">
        {[...rows.filter((r) => r.enabled), ...rows.filter((r) => !r.enabled)].map((r) => {
          const i = on.indexOf(r.name);
          return (
            <span key={r.name} className={`chip${r.enabled ? "" : " off"}`}>
              <input
                type="checkbox"
                aria-label={`Use ${r.label} for ${cap}`}
                checked={r.enabled}
                onChange={(e) => order(e.target.checked ? [...on, r.name] : on.filter((n) => n !== r.name))}
              />
              <span>{r.label}</span>
              <button
                type="button"
                className="link faint"
                title="Change the price"
                onClick={() => setEdit({ name: r.name, usd: r.price === null ? "" : String(r.price) })}
              >
                {price(r.price)}
              </button>
              {r.monthUsd > 0 && <span className="faint">· ${r.monthUsd.toFixed(2)} this month</span>}
              {!r.available && <span className="faint held-text">{r.missing}</span>}
              {r.enabled && (
                <>
                  <button
                    type="button"
                    className="link"
                    aria-label={`Move ${r.label} up`}
                    disabled={i === 0}
                    onClick={() => move(r.name, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="link"
                    aria-label={`Move ${r.label} down`}
                    disabled={i === on.length - 1}
                    onClick={() => move(r.name, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
            </span>
          );
        })}
      </div>
      {edit && editing && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="faint" style={{ whiteSpace: "nowrap" }}>
            {editing.label} · USD per call
          </span>
          <input
            aria-label={`${editing.label} price for ${cap}`}
            // biome-ignore lint/a11y/noAutofocus: opened by a click on the price
            autoFocus
            style={{ width: 90 }}
            placeholder="provider's"
            value={edit.usd}
            onChange={(e) => setEdit({ ...edit, usd: e.target.value })}
            onKeyDown={async (e) => {
              if (e.key === "Escape") setEdit(null);
              if (
                e.key === "Enter" &&
                (await send("/api/setup/provider-price", { name: edit.name, cap, usd: edit.usd }))
              )
                setEdit(null);
            }}
          />
          <span className="faint">
            {editing.priceSource === "reported"
              ? "pre-check only: Exa and Context.dev report their real cost"
              : "Enter saves · blank uses the provider's price"}
          </span>
        </div>
      )}
    </div>
  );
}

// Known after the board's first load; the gate shows setup only before the queue exists.
let needsSetup: boolean | null = null;

const PROFILE: [string, string][] = [
  ["full_name", "Full name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["location", "Where you live (as you'd write it on a form)"],
  ["country", "Country"],
  ["linkedin", "LinkedIn URL"],
  ["github", "GitHub URL"],
  ["website", "Website"],
  ["work_authorization", "Work authorisation (as you'd answer a form)"],
];

/** The spend limits, each saved on its own. Past one, those paid steps are skipped. */
function Limits({
  limits,
  send,
}: {
  limits: Status["limits"];
  send: (url: string, body: unknown) => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="muted" style={{ fontSize: 13 }}>
        Limits, in US dollars except the last two, counts. Past one, those steps wait and the rest still run;
        Work you start yourself is never held by the background count.
      </span>
      {limits.map((l) => {
        const id = `${l.section}.${l.key}`;
        const v = edit[id] ?? String(l.usd);
        return (
          <div
            key={id}
            style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 100px auto", gap: 8, fontSize: 13 }}
          >
            <span>{l.label}</span>
            <input
              aria-label={l.label}
              inputMode={l.count ? "numeric" : "decimal"}
              value={v}
              onChange={(e) => setEdit({ ...edit, [id]: e.target.value })}
            />
            <button
              type="button"
              className="small"
              disabled={v === String(l.usd)}
              onClick={async () => {
                if (await send("/api/setup/limit", { section: l.section, key: l.key, usd: v }))
                  setEdit(Object.fromEntries(Object.entries(edit).filter(([k]) => k !== id)));
              }}
            >
              Save
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A labelled field: the label stays above the box while you type; a hint, when given, below it. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

const TITLES_HINT = "A role fits when its title has one of these words. Separate them with commas.";

function Step({ n, title, id, children }: { n: number; title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id}>
      <div className="sec-head">
        <span className="sec-count">{String(n).padStart(2, "0")}</span>
        <span className="label">{title}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 12 }}>{children}</div>
    </section>
  );
}

type Send = (url: string, body: unknown) => Promise<boolean>;

/** What runs the model: Claude Code signed in, the API key saved, and which is used (Settings, first run). */
function ModelState({ s, send }: { s: Status; send: Send }) {
  return (
    <>
      <span style={{ fontSize: 13 }}>
        <span className={`sq ${s.model.signedIn ? "ink" : "off"}`} style={{ marginRight: 8 }} />
        Claude Code:{" "}
        {s.model.signedIn
          ? `signed in${s.model.plan ? ` (${s.model.plan} plan)` : ""}, no charge per call`
          : s.model.installed
            ? "not signed in. Run claude in Terminal and sign in to use your subscription"
            : "not installed"}
      </span>
      <span style={{ fontSize: 13 }}>
        <span className={`sq ${s.model.key ? "ink" : "off"}`} style={{ marginRight: 8 }} />
        Anthropic API key: {s.model.key ? "saved, billed per token" : "not saved"}
      </span>
      <span className="muted">
        {s.model.on === "subscription"
          ? "Every model step runs on your Claude Code subscription."
          : s.model.on === "api-key"
            ? "Every model step runs on the API key, within the spend limits."
            : "No model connected: model steps (sorting posts, reading careers pages, picking boards, Work) are skipped until one is."}
      </span>
      {s.model.signedIn && s.model.key && (
        <>
          <span className="faint">Both are there. Use first:</span>
          {[
            ["claude-code-subscription", "My Claude Code subscription (uses my plan's limits)"],
            ["claude-code-api-key", "The API key (billed per token; set a spend limit in the Console too)"],
          ].map(([mode, label]) => (
            <label key={mode} style={{ display: "flex", gap: 8, fontSize: 13 }}>
              <input
                type="radio"
                name="runner"
                checked={s.runner === mode}
                onChange={() => send("/api/setup/runner", { mode })}
              />
              {label}
            </label>
          ))}
        </>
      )}
    </>
  );
}

/** One key: what it is for, its price line, a box that never shows what is saved, and Save. */
function KeyRow({ k, send }: { k: Status["keys"][number]; send: Send }) {
  const [v, setV] = useState("");
  return (
    <div
      id={`key-${k.name}`}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 220px auto",
        gap: 8,
        alignItems: "center",
        fontSize: 13,
      }}
    >
      <span>
        <span className={`sq ${k.set ? "ink" : "off"}`} style={{ marginRight: 8 }} />
        {k.label}
        {k.price && (
          <span className="muted" style={{ display: "block", marginLeft: 18 }}>
            {k.price}
          </span>
        )}
      </span>
      <input
        type="password"
        aria-label={k.label}
        placeholder={k.set ? "saved · replace" : "paste"}
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <button
        type="button"
        className="small"
        disabled={!v}
        onClick={async () => {
          if (await send("/api/setup/key", { name: k.name, value: v })) setV("");
        }}
      >
        Save
      </button>
    </div>
  );
}

/** Connect X or Gmail: the browser opens once to sign in, once its app's keys are saved. */
function ConnectRow({ s, service, send }: { s: Status; service: "x" | "gmail"; send: Send }) {
  const set = (n: string) => !!s.keys.find((k) => k.name === n)?.set;
  const name = service === "x" ? "X" : "Gmail";
  const on = s.connected[service];
  const ready = service === "x" ? set("x_client_id") : set("gmail_client_id") && set("gmail_client_secret");
  return (
    <div id={`connect-${service}`} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
      <span className={`sq ${on ? "ink" : "off"}`} />
      <span>
        {name}: {on ? "connected" : ready ? "not connected yet" : `save the ${name} app's key above first`}
      </span>
      <button
        type="button"
        className="small"
        disabled={!ready}
        onClick={() => send("/api/setup/connect", { service })}
      >
        {on ? `Connect ${name} again` : `Connect ${name}`}
      </button>
      <span className="faint">opens your browser once to sign in</span>
    </div>
  );
}

/** The positioning page: copy the prompt to a Claude chat, paste its two results back. */
function PositioningForm({ s, ctx, send }: { s: Status; ctx: Ctx; send: Send }) {
  const [md, setMd] = useState("");
  const [ev, setEv] = useState("");
  if (s.positioning)
    return (
      <span className="muted">Your positioning page is saved{s.evidence ? ", with its evidence" : ""}.</span>
    );
  return (
    <>
      <span className="muted">
        Start it in a new Claude chat: paste this prompt there with your CV, links and write-ups attached,
        then paste the two results back here.
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Copy text={s.prompt} label="Copy the prompt" onCopied={() => ctx.toast("Copied")} />
      </div>
      <textarea
        aria-label="The first result: your positioning page"
        rows={8}
        placeholder="Paste the first result here: your positioning page"
        value={md}
        onChange={(e) => setMd(e.target.value)}
      />
      <textarea
        aria-label="The second result: the evidence"
        rows={5}
        placeholder="Paste the second result here: the evidence, one line each (optional)"
        value={ev}
        onChange={(e) => setEv(e.target.value)}
      />
      <div>
        <button
          type="button"
          disabled={!md.trim()}
          onClick={() => send("/api/setup/positioning", { md, evidence: ev })}
        >
          Save positioning
        </button>
      </div>
    </>
  );
}

/** Settings: every section, each saved on its own, reopened any time. */
function Setup({ ctx, at }: { ctx: Ctx; at?: string }) {
  const [s, setS] = useState<Status | null>(null);
  const [dir, setDir] = useState("");
  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [filters, setFilters] = useState({
    remote_ok: true,
    title_include: "",
    title_exclude: "",
  });
  const [places, setPlaces] = useState<Place[]>([]);
  const load = useCallback(async () => {
    const r = await fetch("/api/setup");
    const st: Status = await r.json();
    setS(st);
    setDir(st.dataDir);
    setProfile(st.profile);
    const f = st.profile.filters ?? {};
    setPlaces(placesFrom(f));
    setFilters({
      remote_ok: f.remote_ok !== false, // always sent: missing means yes (ats/filters.ts remoteOk)
      title_include: (f.title_include ?? []).join(", "),
      title_exclude: (f.title_exclude ?? []).join(", "),
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // Opened from a link to one section or key (Sources' guides): it is brought into view, once.
  const shown = useRef(false);
  useEffect(() => {
    if (!s || !at || shown.current) return;
    shown.current = true;
    const el = document.getElementById(at);
    el?.scrollIntoView({ block: "center" });
    el?.querySelector("input")?.focus({ preventScroll: true });
  }, [s, at]);
  if (!s) return null;
  const send = async (url: string, body: unknown) => {
    const r = await ctx.post(url, body);
    const out = await r.json().catch(() => ({}));
    if (out.toast) ctx.toast(out.toast);
    await load();
    return r.ok;
  };
  const list = (v: string) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const body = (
    <div className="subpage" style={{ maxWidth: 760 }}>
      <p className="muted" style={{ margin: 0 }}>
        Each section saves on its own. Keys stay in the macOS Keychain; a key left blank keeps the one stored.
      </p>
      <Step n={1} title="About you" id="set-about">
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}
        >
          {PROFILE.map(([k, label]) => (
            <Field key={k} label={label}>
              <input
                value={String(profile[k] ?? "")}
                onChange={(e) => setProfile({ ...profile, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <label style={{ display: "flex", gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={!!profile.needs_sponsorship}
            onChange={(e) => setProfile({ ...profile, needs_sponsorship: e.target.checked })}
          />
          I need visa sponsorship
        </label>
        <Places
          places={places}
          setPlaces={setPlaces}
          remote={filters.remote_ok}
          setRemote={(on) => setFilters({ ...filters, remote_ok: on })}
        />
        <Field label="Title words to keep" hint={TITLES_HINT}>
          <input
            placeholder="e.g. engineer, product manager"
            value={filters.title_include}
            onChange={(e) => setFilters({ ...filters, title_include: e.target.value })}
          />
        </Field>
        <Field
          label="Title words to skip"
          hint="A role whose title has one of these is left out, e.g. sales, intern."
        >
          <input
            value={filters.title_exclude}
            onChange={(e) => setFilters({ ...filters, title_exclude: e.target.value })}
          />
        </Field>
        <div>
          <button
            type="button"
            onClick={() =>
              send("/api/setup/profile", {
                ...profile,
                filters: {
                  ...placesOf(places),
                  remote_ok: filters.remote_ok,
                  title_include: list(filters.title_include),
                  title_exclude: list(filters.title_exclude),
                },
              })
            }
          >
            Save
          </button>
        </div>
      </Step>

      <Step n={2} title="The model" id="set-model">
        <ModelState s={s} send={send} />
        <span className="muted">
          This month: ${s.spend.month.toFixed(2)} of your ${s.spend.cap.toFixed(2)} monthly limit, real money
          only (change it under Spend). Past it, paid lookups are skipped and the rest goes on with what's
          free.
        </span>
      </Step>

      <Step n={3} title="Keys" id="set-keys">
        <span className="muted" style={{ fontSize: 13 }}>
          {s.prices}
        </span>
        {s.keys.map((k) => (
          <KeyRow key={k.name} k={k} send={send} />
        ))}
        <ConnectRow s={s} service="x" send={send} />
        <ConnectRow s={s} service="gmail" send={send} />
      </Step>

      <Step n={4} title="Spend" id="set-spend">
        <Limits limits={s.limits} send={send} />
        {(s.usage ?? []).map((r) => {
          const [head, ...rest] = describeRow(r);
          return (
            <div key={r.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13 }}>
                <span style={{ fontWeight: 600 }}>{r.label}</span> · {head}
              </span>
              {rest.length > 0 && (
                <details>
                  <summary className="faint" style={{ cursor: "pointer" }}>
                    Details
                  </summary>
                  {rest.map((l) => (
                    <div key={l} className="mono faint" style={{ fontSize: 12 }}>
                      {l}
                    </div>
                  ))}
                </details>
              )}
            </div>
          );
        })}
        {s.spend.history.since ? (
          <>
            <span className="muted">
              All time ${s.spend.history.total.toFixed(2)} since {s.spend.history.since}, real money only.
            </span>
            {s.spend.history.months.map((m) => (
              <span key={m.month} className="mono" style={{ fontSize: 12.5 }}>
                {m.month} ${m.total.toFixed(2)}
                {Object.entries(m.by).map(([k, v]) => ` · ${k} $${v.toFixed(2)}`)}
              </span>
            ))}
          </>
        ) : (
          <span className="muted">Nothing spent yet.</span>
        )}
      </Step>

      <Step n={5} title="Positioning page" id="set-positioning">
        <PositioningForm s={s} ctx={ctx} send={send} />
      </Step>

      <Step n={6} title="For applying" id="set-applying">
        <ForApplying ctx={ctx} />
      </Step>

      <Step n={7} title="Advanced: order of lookup providers">
        <span className="muted">
          Most people only need the Search and page reading tile on Sources: pick one there and it is used for
          everything.
        </span>
        <details>
          <summary style={{ cursor: "pointer", fontSize: 13 }}>Show the order</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}>
            <span className="muted">
              Each kind of lookup tries the ticked providers in this order and stops at the first good answer.
              Prices are per lookup, checked against your monthly limit before it runs.
            </span>
            {CAP_LABELS.filter(([cap]) => s.providers[cap]?.length).map(([cap, label]) => (
              <div
                key={cap}
                className="source"
                style={{ gridTemplateColumns: "150px minmax(0,1fr)", alignItems: "start" }}
              >
                <span>{label}</span>
                <ProviderChips cap={cap} rows={s.providers[cap]!} send={send} />
              </div>
            ))}
          </div>
        </details>
      </Step>

      <Step n={8} title="Where your data is kept" id="set-data">
        <span className="muted">
          Everything Job Signal knows (companies, roles, your threads, your CVs) is kept in this folder on
          your Mac. Most people never change it. Changing it moves nothing: Job Signal works from the folder
          you pick from then on, which starts empty unless you moved the files there first.
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            aria-label="Data folder"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            disabled={dir === s.dataDir}
            onClick={() => send("/api/setup/data-dir", { dir })}
          >
            Use this folder
          </button>
        </div>
        <span className={s.cloudSynced ? "held-text" : "faint"}>
          {s.cloudSynced
            ? "This folder is cloud-synced (iCloud Drive, Dropbox…), which can damage its files: pick a plain folder."
            : "A plain folder in your home folder, not iCloud Drive or Dropbox."}
        </span>
      </Step>

      <div style={{ display: "flex", justifyContent: "flex-end", paddingBottom: 40 }}>
        <button type="button" className="primary" onClick={() => ctx.page(null)}>
          Done
        </button>
      </div>
    </div>
  );
  return body;
}

// What became of one website pasted in Start with: its line, and whether its Add is still going.
type Added = { site: string; id?: number; line: string; going: boolean };

/** One company's Add, as a line: "board found, 33 open roles" or "still looking". */
function addedLine(c: {
  adding: string | null;
  open: number;
  fit: number;
  board: { provider: string | null; problem?: string };
}): { line: string; going: boolean } {
  if (c.adding) return { line: c.adding.replace(/^adding · /, ""), going: true };
  if (!c.board.provider)
    return {
      line: `no job board yet: ${c.board.problem ?? "still looking"} (it keeps looking by itself)`,
      going: false,
    };
  return {
    line: `board found, ${c.open} open role${c.open === 1 ? "" : "s"}${c.open ? `, ${c.fit} fit you` : ""}`,
    going: false,
  };
}

const STEPS = [
  "About you",
  "Connect the model",
  "A search provider",
  "Your signals",
  "For applying",
  "Positioning",
];

/**
 * First run, the whole onboarding, before anything is on the board: About you (name, places,
 * title words), then the model, a search provider, your signals (Hacker News is on; companies you
 * like, GitHub, job mail, X bookmarks), your CV and the form filler, and the positioning page, each
 * skippable and saved where Settings saves it, with Settings' own parts. Finishing lands on Sources,
 * whose Start here then lists only what was skipped. No fund is offered here: funds stay off until
 * you tick one on Sources.
 */
function FirstRun({ ctx }: { ctx: Ctx }) {
  const [step, setStep] = useState(1);
  const [s, setS] = useState<Status | null>(null);
  const [name, setName] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [remote, setRemote] = useState(true);
  const [titles, setTitles] = useState("");
  const [sites, setSites] = useState("");
  const [gh, setGh] = useState("");
  const [added, setAdded] = useState<Added[]>([]);
  const [findNow, setFindNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/setup").catch(() => null);
    if (r?.ok) setS((await r.json()) as Status);
  }, []);
  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((st: Status) => {
        setS(st);
        setName(String(st.profile.full_name ?? ""));
        setPlaces(placesFrom(st.profile.filters ?? {}));
        setTitles((st.profile.filters?.title_include ?? []).join(", "));
        setRemote(st.profile.filters?.remote_ok !== false);
      });
  }, []);
  // A sign-in finished in the browser (X): the server says so, and the step shows it.
  useEffect(() => {
    const on = () => void load();
    window.addEventListener("inbox.changed", on);
    return () => window.removeEventListener("inbox.changed", on);
  }, [load]);
  // Each website being added: its line follows its Add until the board is read or it's left looking.
  const going = added.filter((a) => a.going && a.id).length;
  useEffect(() => {
    if (!going) return;
    const t = setInterval(async () => {
      const next = await Promise.all(
        added.map(async (a) => {
          if (!a.going || !a.id) return a;
          const r = await fetch(`/api/watchlist/${a.id}`).catch(() => null);
          if (!r?.ok) return a;
          return { ...a, ...addedLine(await r.json()) };
        }),
      );
      setAdded(next);
    }, 1500);
    return () => clearInterval(t);
  }, [going, added]);
  // Settings' parts save here as they do there: a toast, then the status read again.
  const send: Send = async (url, body) => {
    const r = await ctx.post(url, body);
    const out = (await r.json().catch(() => ({}))) as { toast?: string };
    if (out.toast) ctx.toast(out.toast);
    await load();
    return r.ok;
  };
  // Sources' job mail form, here: its answer as a toast, then the status read again.
  const act: Actions = {
    post: async (url, body, quiet) => {
      const r = await ctx.post(url, body);
      const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (out.toast && !quiet) ctx.toast(String(out.toast));
      return r.ok ? out : { ...out, error: true };
    },
    reload: () => void load(),
    show: () => {},
  };
  const lines = sites
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const saveYou = async () => {
    const r = await ctx.post("/api/setup/profile", {
      full_name: name.trim(),
      filters: {
        ...placesOf(places),
        remote_ok: remote,
        title_include: titles
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      },
    });
    if (r.ok) setStep(2);
    else ctx.toast(((await r.json().catch(() => ({}))) as { toast?: string }).toast ?? "Couldn't save");
  };
  const add = async () => {
    setBusy(true);
    const left: string[] = [];
    const out: Added[] = [];
    for (const site of lines) {
      // Websites only: a LinkedIn page, a post or a job board's page isn't one.
      if (!/^(https?:\/\/)?[\w-]+(\.[\w-]+)+\/?$/i.test(site) || /linkedin\.com/i.test(site)) {
        out.push({ site, line: "not a website: write it like cursor.com", going: false });
        left.push(site);
        continue;
      }
      const r = await ctx.post("/api/watchlist/add", { input: site });
      const got = (await r.json().catch(() => ({}))) as { ask?: string; toast?: string; company?: number };
      if (got.company) out.push({ site, id: got.company, line: "starting", going: true });
      else {
        out.push({ site, line: got.ask ?? got.toast ?? "not added", going: false });
        left.push(site);
      }
    }
    setAdded([...added.filter((a) => !lines.includes(a.site)), ...out]);
    setSites(left.join("\n"));
    setBusy(false);
  };
  const signalsNext = async () => {
    setBusy(true);
    await ctx.post("/api/sources/batch/after-next-read", { on: findNow });
    if (gh.trim()) {
      const r = await ctx.post("/api/sources/github-stars", { user: gh.trim() });
      if (!r.ok) {
        setBusy(false);
        ctx.toast(
          `GitHub: ${((await r.json().catch(() => ({}))) as { toast?: string }).toast ?? "not saved"}`,
        );
        return;
      }
    }
    setBusy(false);
    setStep(5);
  };
  const finishRun = async () => {
    await ctx.post("/api/setup/finish", {});
    needsSetup = false;
    await ctx.refetch();
    ctx.page("sources");
  };
  if (!s) return null;
  const keyOf = (n: string) => s.keys.find((k) => k.name === n);
  const searches = ["contextdev", "parallel", "exa", "firecrawl"].map(keyOf).filter((k) => !!k);
  const searchOn = searches.some((k) => k.set);
  const failed = added.filter((a) => !a.id);
  const addLabel = `Add ${lines.length} website${lines.length === 1 ? "" : "s"}`;
  // Back on every step but the first; Next once its part is done, else Skip with what skipping means.
  const nav = (o: { done: boolean; skip?: string; next?: () => void; last?: boolean }) => (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => setStep(step - 1)}>
          Back
        </button>
        <button
          type="button"
          className={o.done ? "primary" : ""}
          disabled={busy}
          onClick={o.next ?? (o.last ? finishRun : () => setStep(step + 1))}
        >
          {o.last ? (o.done ? "Done" : "Skip and finish") : o.done ? "Next" : "Skip for now"}
        </button>
      </div>
      {!o.done && o.skip && <span className="faint">{o.skip}</span>}
      {o.last && <span className="faint">Next: the Sources screen, where your signals come in.</span>}
    </>
  );
  return (
    <div className="frame">
      <div className="topbar-rule" />
      <header className="topbar">
        <span className="title">Signal Board</span>
        <span className="date">
          first run · {step} of {STEPS.length}
        </span>
      </header>
      <div className="subpage" style={{ maxWidth: 760 }}>
        {step === 1 ? (
          <Step n={1} title="About you">
            <Field label="Your name">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Places places={places} setPlaces={setPlaces} remote={remote} setRemote={setRemote} />
            <Field label="Title words" hint={TITLES_HINT}>
              <input
                placeholder="e.g. engineer, product manager"
                value={titles}
                onChange={(e) => setTitles(e.target.value)}
              />
            </Field>
            <span className="faint">Email, links and work authorisation come later, in Settings.</span>
            <div>
              <button
                type="button"
                className="primary"
                disabled={!name.trim() || !titles.trim()}
                onClick={saveYou}
              >
                Next
              </button>
            </div>
          </Step>
        ) : step === 2 ? (
          <Step n={2} title="Connect the model">
            <span className="muted" style={{ fontSize: 13 }}>
              The model sorts posts, reads careers pages, picks boards and does Work. Either one runs
              everything: your Claude Code subscription, or an Anthropic API key.
            </span>
            <ModelState s={s} send={send} />
            {!s.model.signedIn && (
              <span style={{ fontSize: 13 }}>
                {s.model.installed
                  ? "To use your subscription: open Terminal, type claude, sign in, then press Check again."
                  : "To use your subscription: install Claude Code (claude.com/claude-code), open Terminal, type claude and sign in, then press Check again."}{" "}
                <button
                  type="button"
                  className="small"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true);
                    await ctx.post("/api/setup/check-model", {});
                    await load();
                    setChecking(false);
                  }}
                >
                  {checking ? "Checking…" : "Check again"}
                </button>
              </span>
            )}
            {!s.model.signedIn && keyOf("anthropic") && (
              <>
                <span className="muted" style={{ fontSize: 13 }}>
                  Or paste an Anthropic API key (billed per token, within your spend limits):
                </span>
                <KeyRow k={keyOf("anthropic")!} send={send} />
              </>
            )}
            {s.model.signedIn && !s.model.key && (
              <span className="faint" style={{ fontSize: 13 }}>
                To use an Anthropic API key instead, save it later in Settings under Keys, then choose it
                under The model.
              </span>
            )}
            {nav({
              done: !!s.model.on,
              skip: "Without a model, posts aren't sorted, careers pages aren't read, boards found by web search aren't picked and Work doesn't run.",
            })}
          </Step>
        ) : step === 3 ? (
          <Step n={3} title="A search provider">
            <span className="muted" style={{ fontSize: 13 }}>
              One is enough: it looks up each company's website and job board. Each has a free allowance.{" "}
              {s.prices}
            </span>
            {searches.map((k) => (
              <KeyRow key={k.name} k={k} send={send} />
            ))}
            {nav({
              done: searchOn,
              skip: "Without one, companies named in posts can't have their website or job board looked up.",
            })}
          </Step>
        ) : step === 4 ? (
          <Step n={4} title="Your signals">
            <span style={{ fontSize: 13 }}>
              <span className="sq ink" style={{ marginRight: 8 }} />
              Hacker News is on: its monthly “Who is hiring” thread is read every 6 hours.
            </span>
            <Field
              label="Companies you already like (optional)"
              hint="Their websites, one per line, like cursor.com: not job posts or LinkedIn pages. Each one's job board is found and read now."
            >
              <textarea
                rows={4}
                placeholder={"cursor.com\nlinear.app"}
                value={sites}
                onChange={(e) => setSites(e.target.value)}
              />
            </Field>
            {lines.length > 0 && (
              <div>
                <button type="button" className="small" disabled={busy} onClick={add}>
                  {busy ? "Adding…" : addLabel}
                </button>
              </div>
            )}
            {added.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13 }}>
                {added.map((a) => (
                  <div key={a.site} className={a.id ? "" : "held-text"}>
                    <span style={{ fontWeight: 600 }}>{a.site}</span> · {a.line}
                    {a.going && <span className="faint"> …</span>}
                  </div>
                ))}
                {failed.length > 0 && lines.length > 0 && (
                  <span className="muted">
                    The {failed.length === 1 ? "line" : "lines"} left in the box weren't added: fix{" "}
                    {failed.length === 1 ? "it" : "them"} and press {addLabel}, or go on without{" "}
                    {failed.length === 1 ? "it" : "them"}.
                  </span>
                )}
                {added.some((a) => a.id) && (
                  <span className="faint">
                    You can go on while they're read: they'll be on your Watchlist.
                  </span>
                )}
              </div>
            )}
            <Field
              label="Your GitHub username (optional)"
              hint="The companies behind the projects you star come in: organisations with their own website only."
            >
              <input placeholder="octocat" value={gh} onChange={(e) => setGh(e.target.value)} />
            </Field>
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                Job mail (optional): job alert emails from a spare mailbox
              </summary>
              <div
                className="srcs"
                style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}
              >
                <span className="muted" style={{ fontSize: 13 }}>
                  A spare mailbox that only gets job mail (alerts sent or forwarded there), with an app
                  password made for Job Signal: never your main mailbox's password. Read-only: mail is never
                  sent, moved or deleted. More steps, and the Gmail way, are on Sources &gt; Job mail.
                </span>
                <JobMailForm act={act} />
              </div>
            </details>
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                X bookmarks (optional): the posts you bookmark on X
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8 }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  In the X developer console, make an app (Native App, OAuth 2.0) and set a spend limit: X
                  charges per post read. Paste its Client ID here, then Connect X.
                </span>
                {keyOf("x_client_id") && <KeyRow k={keyOf("x_client_id")!} send={send} />}
                <ConnectRow s={s} service="x" send={send} />
              </div>
            </details>
            <label style={{ display: "flex", gap: 8, fontSize: 13, maxWidth: 620 }}>
              <input type="checkbox" checked={findNow} onChange={(e) => setFindNow(e.target.checked)} />
              <span>
                Find the job boards of the companies your sources bring in all at once, after the first read
                (within 15 minutes), instead of a few every 15 minutes. You can stop it on the Sources screen.
              </span>
            </label>
            {nav({ done: true, next: signalsNext })}
          </Step>
        ) : step === 5 ? (
          <Step n={5} title="For applying (optional)">
            <span className="muted" style={{ fontSize: 13 }}>
              Your CV and the form filler, for when you apply.
            </span>
            <ForApplying ctx={ctx} />
            {nav({ done: true })}
          </Step>
        ) : (
          <Step n={6} title="Positioning (optional)">
            <span className="muted" style={{ fontSize: 13 }}>
              A private page of who you're for and what you've shown, which Work reads when it looks into a
              company for you. It takes a chat with Claude, with your CV attached.
            </span>
            <PositioningForm s={s} ctx={ctx} send={send} />
            {nav({ done: s.positioning, last: true })}
          </Step>
        )}
      </div>
    </div>
  );
}

const setup: BoardFeature = {
  name: "setup",
  order: 0,
  connect: (store: Store) => {
    fetch("/api/setup/needed")
      .then((r) => r.json())
      .then((b: { needsSetup: boolean }) => {
        needsSetup = b.needsSetup;
        if (needsSetup) store.refetchAll(true);
      })
      .catch(() => {});
    return () => {};
  },
  gate: (ctx) => (needsSetup ? <FirstRun ctx={ctx} /> : null),
  topBar: (ctx) => (
    <button type="button" className="top-link" onClick={() => ctx.page("settings")}>
      Settings
    </button>
  ),
  pages: { settings: (ctx, p) => <Setup ctx={ctx} at={p.at} /> },
};

export default setup;

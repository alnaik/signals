// "Where do you want to work?": the places a role may be in, for first run and Settings > About you.
// A place picked from the built-in metros brings its towns (setup/metros.ts), shown as chips to
// remove; one typed that isn't listed is matched as typed. Kept as the profile always kept them:
// each place one of `metros` (a switch in the Inbox), every word in `locations` (the filter).
import { useState } from "react";
import { type Metro, stateMark, suggest, wordsOf } from "./metros.ts";

export type Place = { name: string; words: string[] };

/** The profile's places: each city (`metros`), then each place no city holds, as its own. */
export function placesFrom(f: { locations?: string[]; metros?: Record<string, string[]> }): Place[] {
  const metros = Object.entries(f.metros ?? {}).map(([name, words]) => ({ name, words: [...words] }));
  const held = new Set(metros.flatMap((m) => m.words.map((w) => w.toLowerCase())));
  const rest = (f.locations ?? []).filter((l) => !held.has(l.toLowerCase()));
  return [...metros, ...rest.map((l) => ({ name: l, words: [l] }))];
}

/** The places as the profile keeps them: every word in `locations`, each place's in `metros`. */
export function placesOf(places: Place[]) {
  const metros: Record<string, string[]> = {};
  for (const p of places) {
    const name = p.name.trim();
    const words = p.words.map((w) => w.trim()).filter(Boolean);
    if (name && words.length) metros[name] = [...new Set([...(metros[name] ?? []), ...words])];
  }
  return { locations: [...new Set(Object.values(metros).flat())], metros };
}

const state = (p: Place) => p.words.map((w) => stateMark(w, p.words)).find(Boolean);

export function Places({
  places,
  setPlaces,
  remote,
  setRemote,
}: {
  places: Place[];
  setPlaces: (p: Place[]) => void;
  remote: boolean;
  setRemote: (on: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const found = suggest(text).filter((m) => !places.some((p) => p.name === m.name));
  const add = (p: Place) => {
    if (!places.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) setPlaces([...places, p]);
    setText("");
    setAt(0);
  };
  const pick = (m: Metro) => add({ name: m.name, words: wordsOf(m) });
  const typed = () => text.trim() && add({ name: text.trim(), words: [text.trim()] });
  const edit = (i: number, words: string[]) =>
    setPlaces(
      words.length ? places.map((p, j) => (j === i ? { ...p, words } : p)) : places.filter((_, j) => j !== i),
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor="places-box" className="field-label">
        Where do you want to work?
      </label>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            id="places-box"
            style={{ width: "100%" }}
            role="combobox"
            aria-expanded={found.length > 0}
            aria-controls="places-list"
            aria-autocomplete="list"
            placeholder="Type a city, e.g. Denver"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setAt(Math.min(at + 1, found.length - 1));
              else if (e.key === "ArrowUp") setAt(Math.max(at - 1, 0));
              else if (e.key === "Escape") setText("");
              else if (e.key === "Enter") {
                e.preventDefault();
                if (found[at]) pick(found[at]);
                else typed();
              } else return;
              e.preventDefault();
            }}
          />
          {text.trim() && (
            <div id="places-list" role="listbox" className="suggest">
              {found.map((m, i) => (
                <div
                  key={m.name}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === at}
                  className={i === at ? "on" : ""}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(m);
                  }}
                >
                  <span>
                    {m.name}, {m.state}
                  </span>
                  <span className="faint"> · {m.towns.slice(0, 5).join(", ")}…</span>
                </div>
              ))}
              <div
                role="option"
                tabIndex={-1}
                aria-selected={!found.length}
                className={found.length ? "" : "on"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  typed();
                }}
              >
                Add “{text.trim()}” as typed
              </div>
            </div>
          )}
        </div>
        <label style={{ display: "flex", gap: 8, fontSize: 13, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
          Remote is fine
        </label>
      </div>
      <span className="faint">
        A city brings its nearby towns: remove any you don't want. Each place is a switch in the Inbox.
      </span>
      {places.map((p, i) => (
        <div key={p.name} className="place">
          <span style={{ fontWeight: 600 }}>
            {p.name}
            {state(p) && <span className="faint"> · {state(p)}</span>}
          </span>
          <span className="chips">
            {p.words
              .filter((w) => !stateMark(w, p.words))
              .map((w) => (
                <span key={w} className="chip">
                  {w}
                  <button
                    type="button"
                    className="link faint"
                    aria-label={`Remove ${w} from ${p.name}`}
                    onClick={() =>
                      edit(
                        i,
                        p.words.filter((x) => x !== w),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
          </span>
          <button type="button" className="small" onClick={() => edit(i, [])}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

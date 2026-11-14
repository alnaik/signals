// Your north star, in the board's margin. On a wide window: a star in the left margin, one ink line
// from it to the foot of the page, and your sentence beside it, large and pale until you point at
// it. On a narrower one: a small tab under the top bar that opens a band pushing the page down.
// The sentence is the field: click it and type; Return keeps it, Escape puts it back.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BoardFeature } from "../board/slots.ts";

const MAX = 90;
const ASK = "What are you working toward?";
const WHY =
  "This is your north star, your goal for the moment or the long term. Write it down, look at it every day, and let it guide you.";
const OPEN_KEY = "northstar.open";

/** A random sequence from the sentence: the same words always draw the same line. */
function seeded(text: string): () => number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The line: it leaves the star straight beside the words, then, once below them (`free`, in
 * pixels from the top), sways wider and at a few places doubles back into a loop, down to `height`.
 * With no words it runs straight. `x0` is the star's middle; `scale` narrows the sway for a slimmer
 * column (1 for the full 250 px one).
 */
export function linePath(words: string, height: number, free: number, x0 = 31.5, scale = 1): string {
  const y0 = 46;
  const run = Math.max(1, height - y0 + 4);
  const rnd = seeded(words);
  const cycles = Math.max(6, Math.round(run / (90 + 40 * rnd())));
  const phase = rnd() * Math.PI * 2;
  const swing = words ? (24 + 18 * rnd()) * scale : 0;
  const reach = (60 + 36 * rnd()) * scale;
  const f0 = Math.min(0.8, Math.max(0, (free - y0) / run));
  const f1 = Math.min(0.9, f0 + 160 / run);
  const loops: { at: number; w: number; turn: number }[] = [];
  const count = words ? 2 + Math.floor(rnd() * 3) : 0;
  for (let k = 0; k < count; k++)
    loops.push({
      at: f1 + ((k + 0.25 + 0.5 * rnd()) / count) * (0.96 - f1),
      w: 0.036 + 0.014 * rnd(),
      turn: rnd() < 0.5 ? 1 : -1,
    });
  const bump = (s: number, at: number, w: number) => Math.exp(-(((s - at) / w) ** 2));
  const ease = (a: number, b: number, s: number) => {
    const t = Math.min(1, Math.max(0, (s - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const need = run / (2 * Math.PI * cycles); // the least pull that turns a sway into a loop
  const N = Math.min(2400, Math.max(400, Math.round(run / 3)));
  let d = "";
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const out = ease(f0, f1, s);
    const a = 2 * Math.PI * cycles * s;
    let lx = 0;
    let ly = 0;
    for (const l of loops) {
      const pull = need * 2.3 * bump(s, l.at, l.w);
      lx += l.turn * pull * scale * Math.cos(a);
      ly += pull * Math.sin(a);
    }
    const x = x0 + reach * out + swing * out * Math.sin(a * 0.5 + phase) + lx;
    const y = y0 + s * run + ly;
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

const STAR = "M12 0l2.5 9.5L24 12l-9.5 2.5L12 24l-2.5-9.5L0 12l9.5-2.5z";
const Star = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path d={STAR} />
  </svg>
);

const written = (at: string | null) =>
  at ? `written ${new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "";
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function NorthStar() {
  const [saved, setSaved] = useState<{ text: string; at: string | null } | null>(null);
  const [meta, setMeta] = useState("");
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const fields = useRef<(HTMLDivElement | null)[]>([]);
  const margin = useRef<HTMLDivElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const path = useRef<SVGPathElement>(null);
  const undo = useRef(false);

  useEffect(() => {
    fetch("/api/northstar")
      .then((r) => r.json())
      .then((s: { text: string; at: string | null }) => setSaved(s))
      .catch(() => setSaved({ text: "", at: null }));
  }, []);

  // Both fields (margin and band) show the kept sentence, unless one is being written in.
  const show = useCallback((text: string, except?: Element | null) => {
    for (const f of fields.current) if (f && f !== except) f.textContent = text;
  }, []);
  useLayoutEffect(() => {
    if (!saved) return;
    show(saved.text);
    setMeta(saved.text ? written(saved.at) : "");
  }, [saved, show]);

  // The line, drawn again when the sentence is kept and when the column's size changes; never
  // while you type.
  const draw = useCallback(() => {
    const m = margin.current;
    if (!m || !path.current || !saved || m.offsetParent === null) return;
    const free = (words.current?.offsetTop ?? 0) + (words.current?.offsetHeight ?? 0) + 18;
    // From the star's middle, wherever the column puts it, and only as wide as the column allows.
    const star = m.querySelector(".ns-star")?.getBoundingClientRect();
    const x0 = star ? star.left + star.width / 2 - m.getBoundingClientRect().left : 31.5;
    path.current.setAttribute("d", linePath(saved.text, m.clientHeight, free, x0, m.clientWidth / 250));
  }, [saved]);
  useEffect(() => {
    draw();
    const m = margin.current;
    if (!m) return;
    let last = "";
    const ro = new ResizeObserver(() => {
      const size = `${m.clientWidth}x${m.clientHeight}`;
      if (size === last) return;
      last = size;
      draw();
    });
    ro.observe(m);
    document.fonts?.ready.then(draw);
    return () => ro.disconnect();
  }, [draw]);

  const keep = async (f: HTMLDivElement) => {
    if (undo.current) {
      undo.current = false;
      show(saved?.text ?? "");
      setMeta(saved?.text ? written(saved.at) : "");
      return;
    }
    const text = Array.from(oneLine(f.textContent ?? ""))
      .slice(0, MAX)
      .join("");
    show(text);
    if (text === (saved?.text ?? "")) {
      setMeta(text ? written(saved?.at ?? null) : "");
      return;
    }
    const r = await fetch("/api/northstar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    if (!r?.ok) {
      show(saved?.text ?? "");
      setMeta("couldn't keep it: try again");
      return;
    }
    const s = (await r.json()) as { text: string; at: string | null };
    setSaved(s);
    show(s.text);
    // After the effect that sets the date: "just now" says it was kept.
    requestAnimationFrame(() => setMeta(s.text ? "written just now" : ""));
  };

  const field = (i: number) => (
    <div
      ref={(el) => {
        fields.current[i] = el;
      }}
      className="ns-text"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label="Your north star"
      aria-multiline="false"
      tabIndex={0}
      data-ask={ASK}
      onFocus={() => setMeta("Return to keep")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          undo.current = true;
          e.currentTarget.blur();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const t = oneLine(e.clipboardData.getData("text/plain"));
        document.execCommand("insertText", false, t);
      }}
      onInput={(e) => {
        const f = e.currentTarget;
        const text = f.textContent ?? "";
        // One line, 90 characters at most, as you type.
        if (/\n/.test(text) || Array.from(text).length > MAX) {
          f.textContent = Array.from(text.replace(/\n/g, " ")).slice(0, MAX).join("");
          const sel = getSelection();
          sel?.selectAllChildren(f);
          sel?.collapseToEnd();
        }
        show(f.textContent ?? "", f);
      }}
      onBlur={(e) => void keep(e.currentTarget)}
    />
  );

  return (
    <>
      <div className="ns-margin" ref={margin}>
        <svg className="ns-line" aria-hidden="true">
          <path ref={path} d="" />
        </svg>
        <Star className="ns-star" />
        <div className="ns-words" ref={words}>
          {field(0)}
          <p className="ns-why">{WHY}</p>
          <span className="ns-meta">{meta}</span>
        </div>
      </div>
      <div className={`ns-tuck${open ? " open" : ""}`}>
        <button
          type="button"
          className="ns-tab"
          aria-expanded={open}
          aria-controls="ns-band"
          onClick={() => {
            setOpen(!open);
            try {
              localStorage.setItem(OPEN_KEY, open ? "0" : "1");
            } catch {}
          }}
        >
          <Star className="ns-tab-star" />
          North star
        </button>
        <div className="ns-band" id="ns-band" inert={!open}>
          <div>
            <div className="ns-band-inner">
              {field(1)}
              <p className="ns-why">{WHY}</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default {
  name: "northstar",
  margin: () => <NorthStar />,
} satisfies BoardFeature;

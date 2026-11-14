// "For applying", in first run (optional) and in Settings: the CVs Apply attaches and their text
// files, dropped here into me/, and the Chrome extension that fills forms, with its steps and
// whether it is connected.
import { type DragEvent, useCallback, useEffect, useState } from "react";
import type { Ctx } from "../board/slots.ts";
import { Copy } from "../board/ui.tsx";
import { Ill } from "../sources/board.tsx";
import { toExtension } from "./board.tsx";

type Applying = {
  cvs: { name: string; bytes: number; text: { jobs: number; schools: number } | "unreadable" | null }[];
  extensionDir: string;
};

// The shape a CV's text file is read in, offered to copy. An invented person.
export const CV_TEXT_EXAMPLE = `## EXPERIENCE

**Larkspur Freight Co.** | Seattle, WA
**Platform Engineer** | Jul 2025 - Present
- Built the route search used by every driver.
- Cut late deliveries by a third.

**Quillmark Labs** | Portland, OR
**Firmware Engineer** | Oct 2022 - Jun 2025
- Wrote the sensor software.

## EDUCATION

**Cascade State University** | B.S. Computer Science | 2018 - 2022
`;

const isText = (f: File) => /\.(md|txt)$/i.test(f.name);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const size = (b: number) =>
  b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;

/** Whether the extension answers this page now, asked every few seconds while the block shows. */
function useExtension(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const ask = async () => {
      const r = await toExtension({ type: "hello" });
      if (live) setOn(!!r);
    };
    ask();
    const t = setInterval(ask, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return on;
}

export function ForApplying({ ctx }: { ctx: Ctx }) {
  const [d, setD] = useState<Applying | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const ext = useExtension();
  const load = useCallback(async () => {
    const r = await fetch("/api/setup/applying");
    if (r.ok) setD(await r.json());
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    // PDFs first, so a text file dropped with its PDF finds it there.
    for (const f of Array.from(files).sort((a, b) => Number(isText(a)) - Number(isText(b)))) {
      if (!isText(f) && !/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
        ctx.toast(`${f.name}: only a PDF or its text file (.md or .txt)`);
        continue;
      }
      const r = await fetch("/api/setup/cv", {
        method: "POST",
        headers: {
          "content-type": isText(f) ? "text/plain" : "application/pdf",
          "x-name": encodeURIComponent(f.name),
        },
        body: f,
      });
      ctx.toast(((await r.json().catch(() => ({}))) as { toast?: string }).toast ?? "Couldn't save it");
    }
    setBusy(false);
    await load();
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  };
  const steps = [
    {
      i: "browser",
      t: "Open chrome://extensions",
      p: "Paste it in Chrome's address bar (a page can't open it for you).",
      c: <Copy text="chrome://extensions" label="Copy the address" onCopied={() => ctx.toast("Copied")} />,
    },
    {
      i: "check",
      t: "Switch on Developer mode",
      p: "The switch is at the top right of that page.",
    },
    {
      i: "drop",
      t: "Load unpacked, pick this folder",
      p: "Press Load unpacked and pick the folder below. Its path has a folder starting with a dot, which Mac hides: press Cmd+Shift+. in the picker to show hidden folders, or Cmd+Shift+G to paste the path.",
      c: d && (
        <>
          <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
            {d.extensionDir}
          </span>
          <Copy text={d.extensionDir} label="Copy the folder path" onCopied={() => ctx.toast("Copied")} />
        </>
      ),
    },
    {
      i: "connect",
      t: "It connects by itself",
      p: "Come back here: the mark above turns on once Chrome has it.",
    },
  ];
  return (
    <div className="srcs applying">
      <h4>CVs</h4>
      <p className="muted">
        The PDF is what Apply attaches. With more than one, Apply asks which for each role. Up to 10 MB each.
      </p>
      <p className="muted">
        Its text file is what gets typed into a form's work history and education, so it should say what the
        PDF says. Make it a plain text file with the PDF's name, ending .md or .txt (in TextEdit: Format &gt;
        Make Plain Text), shaped like the example.
      </p>
      <details className="cv-example">
        <summary>See the example</summary>
        <pre>{CV_TEXT_EXAMPLE}</pre>
        <Copy text={CV_TEXT_EXAMPLE} label="Copy the example" onCopied={() => ctx.toast("Copied")} />
      </details>
      <label
        className={`dropbox${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        {busy ? "Saving…" : "Drop your CV here (PDFs, and their text files), or click to pick"}
        <input
          type="file"
          accept="application/pdf,.pdf,.md,.txt"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) upload(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {d?.cvs.length ? (
        <ul className="cvs">
          {d.cvs.map((c) => (
            <li key={c.name}>
              <span>{c.name}</span>
              <span className="faint">{size(c.bytes)}</span>
              {c.text === null ? (
                <span className="faint">
                  No text file: work history and education are left for you to type
                </span>
              ) : c.text === "unreadable" ? (
                <span className="unread">
                  Its text file couldn't be read: it needs the shape of the example
                </span>
              ) : (
                <span className="faint">
                  Text file: {plural(c.text.jobs, "job")}, {plural(c.text.schools, "school")}
                </span>
              )}
              <button
                type="button"
                className="small"
                onClick={async () => {
                  const r = await ctx.post("/api/setup/cv-remove", { name: c.name });
                  ctx.toast(((await r.json().catch(() => ({}))) as { toast?: string }).toast ?? "");
                  await load();
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint">No CV yet.</p>
      )}
      <h4>Fill forms for me</h4>
      <p className="muted">
        A Chrome extension fills application forms from your profile, your saved answers and your CV. You
        always press Submit yourself. Without it, Apply still opens the form, just unfilled.
      </p>
      <p className="ok">
        <i className={`mark ${ext ? "on" : "off"}`} aria-hidden="true" />
        {ext === null ? "Checking…" : ext ? "Connected to the board" : "Not connected yet"}
      </p>
      {!ext && (
        <ol className="gsteps" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          {steps.map((s, i) => (
            <li key={s.t} className="gstep">
              <span className="gn">Step {i + 1}</span>
              <Ill k={s.i} />
              <h4>{s.t}</h4>
              <p>{s.p}</p>
              {s.c && <div className="ctl">{s.c}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

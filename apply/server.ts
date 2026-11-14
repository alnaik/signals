import { derive } from "../core/derive.ts";
import { read } from "../core/log.ts";
import { changed } from "../server/hub.ts";
import type { ServerFeature } from "../server/types.ts";
import { saveAnswer } from "./answers.ts";
import { isLinkedIn } from "./linkedin.ts";
import { pdfs } from "./me.ts";
import { applyFiles, chosenPdf, companyName, fieldsFor, ownBoard, pickPdf, prepare } from "./prepare.ts";

// Without the extension (it isn't in Chrome, or it didn't answer), Apply opens the form in this
// Mac's default browser, unfilled. Swappable in tests (like setRunner in ats/reader.ts).
const openInBrowser = (url: string): void => {
  // `open` launches whatever a link names, a file or any app's scheme, and a role's link comes
  // from scraped pages: only a web page or a mail link is ever handed to it.
  if (!["http:", "https:", "mailto:"].includes(scheme(url))) return;
  Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
};
let openUrl = openInBrowser;

/** A link's scheme ("https:", "mailto:"), or "" when it doesn't parse. */
function scheme(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}
export function setUrlOpener(fn: typeof openUrl | null): void {
  openUrl = fn ?? openInBrowser;
}

export const feature: ServerFeature = {
  name: "apply",
  routes: {
    "/api/apply/:id": {
      GET: (req) => {
        const id: string = req.params.id;
        const files = applyFiles(id).map((a) => ({ ...a, fields: fieldsFor(id, a) }));
        return Response.json({
          files,
          pdfs: pdfs(),
          board: ownBoard(id),
        });
      },
      // Apply on a role: pick the role's PDF if there's a choice, and open the form. With
      // the extension (`ext`, the board checked), the board has it open the form in a tab it fills,
      // linked to the role, so the tab gets the role's CV.
      POST: async (req) => {
        const id: string = req.params.id;
        const b = (await req.json().catch(() => ({}))) as { url?: string; pdf?: string; ext?: boolean };
        const role = derive(read(id)).roles.find((r) => r.key === b.url);
        if (!role) return Response.json({ toast: "No such role on this thread" }, { status: 400 });
        if (role.url && isLinkedIn(role.url))
          return Response.json(
            { toast: "Never on LinkedIn: apply on the company's own board" },
            { status: 400 },
          );
        if (b.pdf && !pickPdf(id, role.key, b.pdf))
          return Response.json({ toast: "No such PDF in me/" }, { status: 400 });
        if (!chosenPdf(id, role.key) && pdfs().length > 1)
          return Response.json({ ask: pdfs(), toast: "Which CV?" });
        // The form's questions (the panel's list) are read while the tab opens.
        const a = await prepare(id, role, () => changed(id));
        changed(id);
        if (!a.apply_url)
          return Response.json({ toast: "This role has no link to apply on" }, { status: 400 });
        // The link came from a scraped page. A web page opens as before; a mail link (a careers
        // page may give one as a role's link) opens in the mail app, which the extension can't do;
        // anything else (a file, another app's scheme) is never opened.
        const kind = scheme(a.apply_url);
        if (kind === "mailto:") {
          openUrl(a.apply_url);
          return Response.json({ toast: "This role is applied for by email: opened your mail app" });
        }
        if (kind !== "http:" && kind !== "https:")
          return Response.json({ toast: "This role's link isn't a web page" }, { status: 400 });
        if (b.ext === true)
          return Response.json({
            open: { url: a.apply_url, thread: id, role: role.key, company: companyName(id) },
            toast: "Opening the form in Chrome · it fills as you go, you submit",
          });
        openUrl(a.apply_url);
        return Response.json({
          toast:
            "Opened the form in your browser, unfilled. To have forms filled for you, add the form filler: Settings > For applying",
        });
      },
    },
    "/api/apply/:id/answer": {
      POST: async (req) => {
        const id: string = req.params.id;
        const b = await req.json();
        if (!b.question || !String(b.answer ?? "").trim())
          return Response.json({ toast: "Write the answer first" }, { status: 400 });
        saveAnswer(String(b.question), companyName(id), String(b.answer).trim());
        changed(id);
        return Response.json({ toast: "Saved to the answer bank" });
      },
    },
  },
};

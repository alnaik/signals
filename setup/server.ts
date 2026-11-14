import { CV_MAX_BYTES, CV_TEXT_MAX_BYTES, cvList, removeCv, saveCv, saveCvText } from "../apply/me.ts";
import * as index from "../core/index-db.ts";
import { getSecret } from "../core/keychain.ts";
import { checkSignedIn } from "../core/model.ts";
import { DIST } from "../extension/build.ts";
import { connect as gmailConnect } from "../gmail/client.ts";
import { emit, toast } from "../server/hub.ts";
import type { Handler, ServerFeature } from "../server/types.ts";
import { connect as xConnect } from "../xapi/client.ts";
import {
  finish,
  isDone,
  savePositioning,
  saveProfile,
  setDataDir,
  setKey,
  setLimit,
  setProviderOrder,
  setProviderPrice,
  setRunnerMode,
  status,
} from "./state.ts";

const post =
  (fn: (b: Record<string, unknown>) => unknown): Handler =>
  async (req) => {
    try {
      const out = await fn(await req.json());
      return Response.json(out ?? { ok: true });
    } catch (err) {
      return Response.json({ toast: (err as Error).message }, { status: 400 });
    }
  };

// Connect X or Gmail from the board, as `jobsignal x connect` / `gmail connect` do: the browser
// opens once for the sign-in, and the answer comes back as a toast when it's given.
const CONNECTS = {
  x: { run: xConnect, done: "Connected to X: your new bookmarks are read each night" },
  gmail: {
    run: gmailConnect,
    done: "Gmail connected, read-only: replies and your job label are read every 6 hours",
  },
};
const connecting = new Set<string>();
function startConnect(service: string): { toast: string } {
  const c = CONNECTS[service as keyof typeof CONNECTS];
  if (!c) throw new Error("Unknown service");
  const name = service === "x" ? "X" : "Gmail";
  const keys = service === "x" ? ["x_client_id"] : ["gmail_client_id", "gmail_client_secret"];
  if (keys.some((k) => !getSecret(k)))
    throw new Error(
      `Save the ${name} app's ${service === "x" ? "client ID" : "client ID and secret"} in Settings > Keys first`,
    );
  if (connecting.has(service)) return { toast: `Waiting for you to sign in to ${name} in the browser` };
  connecting.add(service);
  const started = c.run();
  void started
    .then(() => toast(c.done))
    .catch((err) => toast((err as Error).message))
    .finally(() => {
      connecting.delete(service);
      emit("inbox.changed", {}); // Sources and Settings show the new state
    });
  return { toast: `Sign in to ${name} in the browser tab that opened` };
}

export const feature: ServerFeature = {
  name: "setup",
  routes: {
    "/api/setup": { GET: async () => Response.json(await status()) },
    // All the page load needs: whether to show first-run setup. Settings asks for the rest.
    "/api/setup/needed": { GET: () => Response.json({ needsSetup: !isDone() && index.all().length === 0 }) },
    "/api/setup/runner": {
      POST: post((b) => {
        setRunnerMode(String(b.mode));
        return { ok: true, toast: "Saved" };
      }),
    },
    "/api/setup/data-dir": { POST: post((b) => ({ toast: `Data folder: ${setDataDir(String(b.dir))}` })) },
    "/api/setup/key": {
      POST: post(async (b) => {
        await setKey(String(b.name), String(b.value ?? ""));
        return { toast: "Saved in the Keychain" };
      }),
    },
    "/api/setup/providers": { POST: post((b) => setProviderOrder(String(b.cap), b.order)) },
    "/api/setup/provider-price": {
      POST: post((b) => setProviderPrice(String(b.name), String(b.cap), b.usd)),
    },
    "/api/setup/limit": {
      POST: post((b) => {
        setLimit(String(b.section), String(b.key), b.usd);
        return { ok: true, toast: "Saved" };
      }),
    },
    "/api/setup/profile": {
      POST: post(async (b) => ({ ok: true, toast: await saveProfile(b) })),
    },
    "/api/setup/positioning": {
      POST: post((b) => savePositioning(String(b.md ?? ""), String(b.evidence ?? ""))),
    },
    "/api/setup/finish": { POST: post(() => finish()) },
    // First run's Check again: whether Claude Code is signed in, looked at now (10 seconds at most).
    "/api/setup/check-model": {
      POST: post(async () => {
        await checkSignedIn();
        return { ok: true };
      }),
    },
    "/api/setup/connect": { POST: post((b) => startConnect(String(b.service))) },
    // For applying: the CVs in me/ and the folder Chrome loads the extension from.
    "/api/setup/applying": { GET: () => Response.json({ cvs: cvList(), extensionDir: DIST }) },
    // A CV dropped on the board: the file's bytes as the body, its name in x-name. A PDF, or the
    // text file (.md or .txt) of a PDF already there.
    "/api/setup/cv": {
      POST: async (req) => {
        try {
          const dropped = decodeURIComponent(req.headers.get("x-name") ?? "");
          const text = /\.(md|txt)$/i.test(dropped);
          if (Number(req.headers.get("content-length") ?? 0) > (text ? CV_TEXT_MAX_BYTES : CV_MAX_BYTES))
            throw new Error(
              text ? "That text file is over 100 KB, too big for a CV" : "That PDF is over 10 MB",
            );
          const bytes = new Uint8Array(await req.arrayBuffer());
          const name = text ? saveCvText(dropped, bytes) : saveCv(dropped, bytes);
          return Response.json({ ok: true, toast: `Saved ${name}` });
        } catch (err) {
          return Response.json({ toast: (err as Error).message }, { status: 400 });
        }
      },
    },
    "/api/setup/cv-remove": {
      POST: post((b) => {
        removeCv(String(b.name ?? ""));
        return { ok: true, toast: "Removed" };
      }),
    },
  },
};

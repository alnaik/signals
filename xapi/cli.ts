import type { Command } from "../core/features.ts";
import { connect, REDIRECT_URI } from "./client.ts";

export const commands: Record<string, Command> = {
  x: {
    summary: "Connect the official X API for bookmarks (x connect)",
    run: async ([sub]) => {
      if (sub !== "connect") {
        console.log(`Usage: jobsignal x connect

One-time setup, in the X developer console:
  1. Create a Project and an App; set the app type to "Native App" (public client).
  2. Turn on OAuth 2.0 and add the callback URL ${REDIRECT_URI}
  3. Set a spending limit on the account (the handoff suggests $5).
  4. pbpaste | jobsignal key set x_client_id      (the OAuth 2.0 Client ID)
  5. jobsignal x connect                          (approve in the browser; or Connect X in Settings > Keys)`);
        return;
      }
      await connect();
      console.log("Connected to X. New bookmarks are read each night.");
    },
  },
};

import type { Command } from "../core/features.ts";
import { connect } from "./client.ts";

export const commands: Record<string, Command> = {
  gmail: {
    summary: "Connect Gmail read-only (gmail connect); see docs/gmail-setup.md",
    run: async ([sub]) => {
      if (sub !== "connect") {
        console.log("Usage: jobsignal gmail connect   (setup steps: docs/gmail-setup.md)");
        return;
      }
      await connect();
      console.log("Gmail connected, read-only. Replies and the job label are read every 6 hours.");
    },
  },
};

import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { isElectronRuntime } from "@/desktop/host";

export interface AppSandboxStatus {
  sandboxed: boolean;
  containerHome: string | null;
  realHome: string | null;
}

const NOT_SANDBOXED: AppSandboxStatus = {
  sandboxed: false,
  containerHome: null,
  realHome: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Whether this copy of Paseo is confined by the macOS App Sandbox, which every Mac App Store and
 * TestFlight build is. See `packages/desktop/src/system/app-sandbox.ts` for why that stops the
 * bundled daemon from reaching the coding agents installed on the machine.
 *
 * An older desktop build has no handler for this command; treat that as unsandboxed, which is what
 * every non-App-Store build is.
 */
export async function getAppSandboxStatus(): Promise<AppSandboxStatus> {
  if (!isElectronRuntime()) return NOT_SANDBOXED;
  let raw: unknown;
  try {
    raw = await invokeDesktopCommand("desktop_app_sandbox_status");
  } catch {
    return NOT_SANDBOXED;
  }
  if (!isRecord(raw) || typeof raw.sandboxed !== "boolean") return NOT_SANDBOXED;
  return {
    sandboxed: raw.sandboxed,
    containerHome: toStringOrNull(raw.containerHome),
    realHome: toStringOrNull(raw.realHome),
  };
}

export const EXTERNAL_DAEMON_INSTALL_COMMAND = "npm install -g @getpaseo/cli";
export const EXTERNAL_DAEMON_START_COMMAND = "paseo daemon start";
export const EXTERNAL_DAEMON_STATUS_COMMAND = "paseo daemon status";
export const EXTERNAL_DAEMON_ADDRESS = "127.0.0.1:6767";

export const EXTERNAL_DAEMON_SETUP_COMMANDS = [
  EXTERNAL_DAEMON_INSTALL_COMMAND,
  EXTERNAL_DAEMON_START_COMMAND,
].join("\n");

/**
 * A prompt for the coding agent the user already has in a terminal.
 *
 * Deliberately not localized: it is addressed to an agent, not read by the user, and the agent's
 * own instructions and the commands it runs are in English. It states the constraint first so the
 * agent does not try to fix the sandbox, and it refuses to guess about sudo, because a global npm
 * prefix that needs root is a decision for the person whose machine it is.
 */
export const EXTERNAL_DAEMON_AGENT_PROMPT = [
  "Paseo on this Mac was installed from the App Store or TestFlight, so it runs inside the macOS",
  "App Sandbox and its bundled daemon cannot see any coding agent installed on the machine. No",
  "entitlement fixes that. Set up a Paseo daemon outside the sandbox for me:",
  "",
  "1. Check Node.js is 22 or newer (`node --version`) and install it first if it is not.",
  `2. Install the CLI globally: \`${EXTERNAL_DAEMON_INSTALL_COMMAND}\``,
  `3. Start the daemon: \`${EXTERNAL_DAEMON_START_COMMAND}\``,
  `4. Confirm it is listening: \`${EXTERNAL_DAEMON_STATUS_COMMAND}\``,
  "5. Report the address it listens on and which of Claude Code, Codex, GitHub Copilot, OpenCode",
  "   and Pi it detected.",
  "",
  "Run these in a normal terminal as the logged-in user, not in a container or another sandbox.",
  "Do not use sudo unless npm's global prefix requires it; if it does, tell me before you run it.",
].join("\n");

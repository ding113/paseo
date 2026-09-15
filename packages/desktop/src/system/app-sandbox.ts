import { userInfo as defaultUserInfo } from "node:os";

/**
 * macOS App Sandbox detection.
 *
 * A Mac App Store build is sandboxed and cannot be shipped any other way, so a TestFlight or App
 * Store copy of Paseo runs with a redirected `$HOME`, no read access to the real home directory,
 * and no way to execute a binary outside its container. Every child process inherits that sandbox,
 * so the bundled daemon sees none of the coding agents the user installed: not `claude` or `codex`
 * on PATH, not `~/.claude`, not a Homebrew prefix. No entitlement lifts this — the temporary
 * exception keys cover file reads, are reviewed case by case, and still leave the inherited child
 * sandbox in place. The daemon has to run outside the sandbox and be reached over the loopback.
 *
 * This is not `diagnostics/sandbox.ts`, which reports Chromium's own process sandbox.
 */
export interface AppSandboxStatus {
  /** The app is confined by the macOS App Sandbox. */
  sandboxed: boolean;
  /** Where the sandbox redirected `$HOME`, when it did. */
  containerHome: string | null;
  /** The account's real home directory, which the sandbox hides from `$HOME`. */
  realHome: string | null;
}

const CONTAINER_HOME = /\/Library\/Containers\/[^/]+\/Data\/?$/;

export function describeAppSandbox(input: {
  platform: NodeJS.Platform;
  mas?: boolean;
  env: NodeJS.ProcessEnv;
  userInfo?: typeof defaultUserInfo;
}): AppSandboxStatus {
  if (input.platform !== "darwin") {
    return { sandboxed: false, containerHome: null, realHome: null };
  }

  const home = input.env.HOME ?? null;
  const containerHome = home && CONTAINER_HOME.test(home) ? home : null;
  // `process.mas` marks the Mac App Store build. The container path and the sandbox's own
  // environment variable catch a sandboxed run that Electron did not label, including a locally
  // signed `mas-dev` build.
  const sandboxed = Boolean(
    input.mas || containerHome !== null || input.env.APP_SANDBOX_CONTAINER_ID,
  );

  return { sandboxed, containerHome, realHome: resolveRealHome(input.userInfo) };
}

/**
 * `os.homedir()` reads `$HOME`, which the sandbox has already rewritten. `os.userInfo()` goes to
 * the password database instead and still reports the account's real home.
 */
function resolveRealHome(userInfo: typeof defaultUserInfo = defaultUserInfo): string | null {
  try {
    const home = userInfo().homedir?.trim();
    return home ? home : null;
  } catch {
    return null;
  }
}

let cached: AppSandboxStatus | null = null;

export function getAppSandboxStatus(): AppSandboxStatus {
  cached ??= describeAppSandbox({
    platform: process.platform,
    mas: process.mas,
    env: process.env,
  });
  return cached;
}

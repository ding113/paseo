# macOS App Sandbox

The Mac App Store and TestFlight build of the desktop app is sandboxed, and cannot be shipped any
other way. Everything below follows from that.

## What the sandbox takes away

Inside the sandbox `$HOME` is rewritten to `~/Library/Containers/<bundle id>/Data`. The app cannot
read the real home directory, cannot execute a binary outside its container, and every child
process it spawns inherits the same sandbox.

So the bundled daemon starts, reports itself healthy, and finds nothing:

- `claude`, `codex`, `opencode` and friends are not on the PATH it sees, because
  `inheritLoginShellEnv` runs the login shell inside the sandbox and the shell reads the
  container's home, not yours.
- `~/.claude`, `~/.codex` and every other agent config directory resolve into the container.
- Even given the path, it may not execute them.

## No entitlement fixes it

This is the question everyone asks first, so: no.

- Sandboxing is mandatory for Mac App Store distribution. There is no opt-out.
- `com.apple.security.temporary-exception.files.home-relative-path.read-write` grants file reads,
  not execution, and Apple reviews each one against whether it is "tantamount to shipping a
  non-sandboxed app". A grant broad enough to cover an arbitrary developer's toolchain is that.
- Full Disk Access is a TCC grant the user makes in System Settings. It does not lift the sandbox
  and is not reachable through an entitlement.
- A child process cannot escape. It inherits the parent's sandbox whatever its own entitlements
  say, and declaring App Sandbox keys other than `app-sandbox` and `inherit` aborts it at launch.

## What Paseo does instead

The daemon runs outside the sandbox and the app connects to it over the loopback, which
`com.apple.security.network.client` already allows.

`packages/desktop/src/system/app-sandbox.ts` detects the sandbox from `process.mas`, the container
path in `$HOME`, and `APP_SANDBOX_CONTAINER_ID`; any one of them is enough, so a locally signed
`mas-dev` build behaves like a store build. `os.userInfo()` still reports the real home, because it
reads the password database rather than `$HOME`.

Two things follow from that flag:

- `startDaemon()` in `daemon/daemon-manager.ts` refuses. A daemon that starts and sees no agents
  looks like a Paseo bug, and it would hold port 6767 against the daemon the user is about to
  install to fix the problem.
- Onboarding shows `SandboxDaemonSetup` instead of the usual "the daemon starts automatically"
  path: `npm install -g @getpaseo/cli`, `paseo daemon start`, then connect to `127.0.0.1:6767`.

The card also offers the same instructions as a prompt to paste into a coding agent the user
already has open. It stays in English in
`packages/app/src/desktop/daemon/app-sandbox.ts` — it is addressed to an agent, not read by the
user — and it leads with the constraint so the agent does not go looking for an entitlement.

## Not the Chromium sandbox

`diagnostics/sandbox.ts` and **Settings → Diagnostics** report Chromium's process sandbox, which is
a different mechanism with a different failure mode. See [the Linux notes](../public-docs/index.md).

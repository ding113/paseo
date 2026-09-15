import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { createDaemonCommandHandlers } from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  sandbox: {
    sandboxed: true,
    containerHome: "/Users/dana/Library/Containers/sh.paseo.desktop/Data",
    realHome: "/Users/dana",
  },
  runExternalCliJsonCommand: vi.fn(async () => ({ localDaemon: "stopped" })),
  startDaemonInstance: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/paseo"), getVersion: vi.fn(() => "1.2.3"), isPackaged: true },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    transports: { file: { getFile: vi.fn(() => ({ path: "/tmp/paseo/main.log" })) } },
  },
}));

vi.mock("@getpaseo/server", () => ({
  resolvePaseoHome: vi.fn(() => "/tmp/paseo/home"),
  startDaemonInstance: mocks.startDaemonInstance,
  spawnProcess: vi.fn(),
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => DEFAULT_DESKTOP_SETTINGS,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: vi.fn(() => ({ command: "node", args: [], env: {} })),
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join("/tmp/paseo", "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", () => ({
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: vi.fn(),
}));

vi.mock("../system/app-sandbox.js", () => ({
  getAppSandboxStatus: () => mocks.sandbox,
}));

describe("the built-in daemon inside the macOS App Sandbox", () => {
  // A daemon that starts here would look healthy, see none of the machine's coding agents, and
  // hold port 6767 against the one the user is about to install outside the sandbox.
  it("refuses to start and says where the daemon belongs", async () => {
    const handlers = createDaemonCommandHandlers();
    await expect(handlers.start_desktop_daemon()).rejects.toThrow(
      /App Sandbox.*npm install -g @getpaseo\/cli.*127\.0\.0\.1:6767/s,
    );
    expect(mocks.startDaemonInstance).not.toHaveBeenCalled();
  });

  it("reports the sandbox to the renderer", () => {
    expect(createDaemonCommandHandlers().desktop_app_sandbox_status()).toEqual(mocks.sandbox);
  });
});

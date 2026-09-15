import { describe, expect, it } from "vitest";
import { describeAppSandbox } from "./app-sandbox";

const userInfo = (() => ({
  homedir: "/Users/dana",
})) as unknown as typeof import("node:os").userInfo;

describe("describeAppSandbox", () => {
  it("reports a Mac App Store build as sandboxed", () => {
    expect(describeAppSandbox({ platform: "darwin", mas: true, env: {}, userInfo })).toMatchObject({
      sandboxed: true,
      realHome: "/Users/dana",
    });
  });

  it("recognises a redirected home even when Electron did not label the build", () => {
    const status = describeAppSandbox({
      platform: "darwin",
      env: { HOME: "/Users/dana/Library/Containers/sh.paseo.desktop/Data" },
      userInfo,
    });
    expect(status).toEqual({
      sandboxed: true,
      containerHome: "/Users/dana/Library/Containers/sh.paseo.desktop/Data",
      realHome: "/Users/dana",
    });
  });

  it("recognises the sandbox's own environment variable", () => {
    expect(
      describeAppSandbox({
        platform: "darwin",
        env: { APP_SANDBOX_CONTAINER_ID: "sh.paseo.desktop" },
        userInfo,
      }).sandboxed,
    ).toBe(true);
  });

  it("leaves an ordinary macOS install alone", () => {
    expect(
      describeAppSandbox({ platform: "darwin", env: { HOME: "/Users/dana" }, userInfo }),
    ).toEqual({ sandboxed: false, containerHome: null, realHome: "/Users/dana" });
  });

  it("never reports a sandbox off macOS", () => {
    for (const platform of ["linux", "win32"] as NodeJS.Platform[]) {
      expect(describeAppSandbox({ platform, mas: true, env: {}, userInfo }).sandboxed).toBe(false);
    }
  });
});

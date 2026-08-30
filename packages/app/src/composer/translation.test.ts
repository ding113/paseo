import { describe, expect, it, vi } from "vitest";
import { prepareComposerSubmission } from "./translation";

describe("prepareComposerSubmission", () => {
  it("translates chat input before invoking a parent-managed submit", async () => {
    const translate = vi.fn(async (text: string) => `translated:${text}`);

    await expect(
      prepareComposerSubmission({
        text: "你好",
        attachments: [],
        cwd: "/repo",
        inputMode: "chat",
        translate,
      }),
    ).resolves.toEqual({
      text: "translated:你好",
      attachments: [],
      cwd: "/repo",
      clientMessageId: expect.stringMatching(/^msg_/),
    });
    expect(translate).toHaveBeenCalledWith("你好", expect.stringMatching(/^msg_/));
  });

  it("does not translate terminal commands", async () => {
    const translate = vi.fn(async () => "translated");

    await expect(
      prepareComposerSubmission({
        text: "git status",
        attachments: [],
        cwd: "/repo",
        inputMode: "terminal",
        translate,
      }),
    ).resolves.toEqual({ text: "git status", attachments: [], cwd: "/repo" });
    expect(translate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { hasTranslatedOriginal, resolveUserMessageText } from "./user-message-translation";

describe("user message translation display", () => {
  it("shows the translated wire text by default and reveals the original on request", () => {
    const input = { message: "Hello", originalMessage: "你好" };

    expect(hasTranslatedOriginal(input.message, input.originalMessage)).toBe(true);
    expect(resolveUserMessageText({ ...input, showOriginal: false })).toBe("Hello");
    expect(resolveUserMessageText({ ...input, showOriginal: true })).toBe("你好");
  });

  it("does not expose a toggle when the wire text is unchanged", () => {
    expect(hasTranslatedOriginal("Hello", undefined)).toBe(false);
    expect(hasTranslatedOriginal("Hello", "Hello")).toBe(false);
    expect(
      resolveUserMessageText({ message: "Hello", originalMessage: "Hello", showOriginal: true }),
    ).toBe("Hello");
  });

  it("shows the recorded wire translation for an optimistic mid-session row", () => {
    expect(
      resolveUserMessageText({
        message: "你好",
        wireMessage: "Hello",
        originalMessage: "你好",
        showOriginal: false,
      }),
    ).toBe("Hello");
  });
});

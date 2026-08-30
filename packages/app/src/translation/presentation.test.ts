import { describe, expect, it } from "vitest";
import { resolveRequestedTranslation } from "./presentation";

describe("requested translation presentation", () => {
  it("hides structured agent text until its translation starts", () => {
    expect(
      resolveRequestedTranslation("Original plan", {
        enabled: true,
        text: undefined,
        status: "pending",
      }),
    ).toBe("");
  });

  it("streams translated text and falls back to the source on failure", () => {
    expect(
      resolveRequestedTranslation("Original plan", {
        enabled: true,
        text: "译文",
        status: "streaming",
      }),
    ).toBe("译文");
    expect(
      resolveRequestedTranslation("Original plan", {
        enabled: true,
        text: undefined,
        status: "failed",
      }),
    ).toBe("Original plan");
  });
});

import { describe, expect, it } from "vitest";
import { isCodeBlock, splitTranslatableParts } from "./segments";

describe("isCodeBlock", () => {
  it("detects a top-level fence", () => {
    expect(isCodeBlock("```ts\nconst a = 1;\n```")).toBe(true);
    expect(isCodeBlock("~~~\nplain\n~~~")).toBe(true);
  });

  it("detects an indented code block", () => {
    expect(isCodeBlock("    const a = 1;")).toBe(true);
  });

  // Regression: a prefix check saw `-` or `>` and handed the nested code to the model.
  it("detects a fence nested in a list item", () => {
    expect(isCodeBlock("- Run this:\n\n  ```sh\n  npm test\n  ```")).toBe(true);
  });

  it("detects a fence nested in a blockquote", () => {
    expect(isCodeBlock("> Example:\n>\n> ```sh\n> npm test\n> ```")).toBe(true);
  });

  it("leaves ordinary prose translatable", () => {
    expect(isCodeBlock("Run the tests before pushing.")).toBe(false);
    expect(isCodeBlock("- first item\n- second item")).toBe(false);
  });

  it("does not treat an inline code span as a code block", () => {
    expect(isCodeBlock("Call `npm test` before pushing.")).toBe(false);
  });
});

describe("splitTranslatableParts", () => {
  it("marks prose translatable and code not", () => {
    const parts = splitTranslatableParts(
      "Here is the fix:\n\n```ts\nconst a = 1;\n```\n\nShip it.",
    );
    expect(parts.map((part) => part.translate)).toEqual([true, false, true]);
  });

  it("keeps a list containing a fence out of the request", () => {
    const parts = splitTranslatableParts("- Run this:\n\n  ```sh\n  npm test\n  ```");
    expect(parts.every((part) => !part.translate)).toBe(true);
  });
});

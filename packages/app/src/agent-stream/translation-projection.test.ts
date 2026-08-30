import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { TranslationStatus } from "@/translation/store";
import { projectTranslationTimeline } from "./translation-projection";

const at = (second: number) => new Date(2026, 0, 1, 0, 0, second);
const user = (id: string): StreamItem => ({ kind: "user_message", id, text: id, timestamp: at(1) });
const assistant = (id: string): StreamItem => ({
  kind: "assistant_message",
  id,
  text: id,
  timestamp: at(2),
});
const activity = (id: string): StreamItem => ({
  kind: "activity_log",
  id,
  activityType: "info",
  message: id,
  timestamp: at(3),
});

function project(items: StreamItem[], statuses: Record<string, TranslationStatus>, active = false) {
  return projectTranslationTimeline({
    enabled: true,
    isTurnActive: active,
    tail: items,
    head: [],
    statusFor: (text) => statuses[text],
  }).tail.map((item) => item.id);
}

describe("translation timeline projection", () => {
  it("hides agent rows until translated assistant text starts", () => {
    const items = [user("user"), activity("tool-before"), assistant("answer")];
    expect(project(items, { answer: "pending" })).toEqual(["user"]);
    expect(project(items, { answer: "streaming" })).toEqual(["user", "tool-before", "answer"]);
  });

  it("never lets a later assistant overtake an earlier translation barrier", () => {
    const items = [
      user("user"),
      activity("thought"),
      assistant("first"),
      activity("tool"),
      assistant("second"),
    ];
    expect(project(items, { first: "pending", second: "complete" })).toEqual(["user"]);
    expect(project(items, { first: "streaming", second: "complete" })).toEqual([
      "user",
      "thought",
      "first",
    ]);
  });

  it("preserves order across the tail/head boundary", () => {
    const tail = [user("user"), activity("thought"), assistant("first")];
    const head = [activity("tool"), assistant("second")];
    const output = projectTranslationTimeline({
      enabled: true,
      isTurnActive: false,
      tail,
      head,
      statusFor: (text) =>
        ({ first: "complete", second: "streaming" })[text] as TranslationStatus | undefined,
    });
    expect([...output.tail, ...output.head].map((item) => item.id)).toEqual([
      "user",
      "thought",
      "first",
      "tool",
      "second",
    ]);
  });

  it("releases later rows only after the preceding translation completes", () => {
    const items = [user("user"), assistant("first"), activity("tool"), assistant("second")];
    expect(project(items, { first: "streaming", second: "pending" })).toEqual(["user", "first"]);
    expect(project(items, { first: "complete", second: "pending" })).toEqual([
      "user",
      "first",
      "tool",
    ]);
    expect(project(items, { first: "complete", second: "failed" })).toEqual([
      "user",
      "first",
      "tool",
      "second",
    ]);
  });

  it("does not permanently hide a completed tool-only turn", () => {
    expect(project([user("user"), activity("tool")], {})).toEqual(["user", "tool"]);
    expect(project([user("user"), activity("tool")], {}, true)).toEqual(["user"]);
  });

  it("is identity when translation is disabled", () => {
    const items = [assistant("answer"), activity("tool")];
    const output = projectTranslationTimeline({
      enabled: false,
      isTurnActive: true,
      tail: items,
      head: [],
      statusFor: () => undefined,
    });
    expect(output.tail).toBe(items);
  });
});

import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { TranslationStatus } from "@/translation/store";
import { projectTranslationTimeline } from "./translation-projection";

const at = (second: number) => new Date(2026, 0, 1, 0, 0, second);
const user = (id: string): StreamItem => ({ kind: "user_message", id, text: id, timestamp: at(1) });
const assistant = (id: string, text = id): StreamItem => ({
  kind: "assistant_message",
  id,
  text,
  timestamp: at(2),
});
const activity = (id: string): StreamItem => ({
  kind: "notification",
  sourceType: "notification",
  id,
  level: "info",
  message: id,
  timestamp: at(3),
});

function project(items: StreamItem[], statuses: Record<string, TranslationStatus>) {
  return projectTranslationTimeline({
    enabled: true,
    tail: items,
    head: [],
    statusFor: (text) => statuses[text],
  }).tail.map((item) => item.id);
}

describe("translation timeline projection", () => {
  // A turn that works through tools without narrating used to render nothing until it ended,
  // because every row waited for an assistant translation that did not exist yet.
  it("renders a turn without assistant text as it arrives", () => {
    expect(project([user("user"), activity("thought"), activity("tool")], {})).toEqual([
      "user",
      "thought",
      "tool",
    ]);
  });

  it("hides assistant text until its translation starts", () => {
    const items = [user("user"), activity("tool-before"), assistant("answer")];
    expect(project(items, {})).toEqual(["user", "tool-before"]);
    expect(project(items, { answer: "pending" })).toEqual(["user", "tool-before"]);
    expect(project(items, { answer: "streaming" })).toEqual(["user", "tool-before", "answer"]);
    expect(project(items, { answer: "failed" })).toEqual(["user", "tool-before", "answer"]);
  });

  it("keeps rows after an untranslated assistant block live", () => {
    const items = [user("user"), assistant("first"), activity("tool"), activity("thought")];
    expect(project(items, { first: "pending" })).toEqual(["user", "tool", "thought"]);
  });

  it("never lets a later assistant block overtake an earlier untranslated one", () => {
    const items = [user("user"), assistant("first"), activity("tool"), assistant("second")];
    expect(project(items, { first: "pending", second: "complete" })).toEqual(["user", "tool"]);
    expect(project(items, { first: "streaming", second: "complete" })).toEqual([
      "user",
      "first",
      "tool",
      "second",
    ]);
  });

  it("preserves order across the tail/head boundary", () => {
    const output = projectTranslationTimeline({
      enabled: true,
      tail: [user("user"), activity("thought"), assistant("first")],
      head: [activity("tool"), assistant("second")],
      statusFor: (text) =>
        ({ first: "pending", second: "complete" })[text] as TranslationStatus | undefined,
    });
    expect(output.tail.map((item) => item.id)).toEqual(["user", "thought"]);
    expect(output.head.map((item) => item.id)).toEqual(["tool"]);
  });

  it("does not wait on whitespace, which is never sent for translation", () => {
    expect(project([assistant("blank", "\n\n"), assistant("next")], { next: "complete" })).toEqual([
      "blank",
      "next",
    ]);
  });

  it("returns the input lanes when nothing is hidden", () => {
    const tail = [user("user"), activity("tool")];
    const head = [assistant("answer")];
    const output = projectTranslationTimeline({
      enabled: true,
      tail,
      head,
      statusFor: () => "complete",
    });
    expect(output.tail).toBe(tail);
    expect(output.head).toBe(head);
  });

  it("is identity when translation is disabled", () => {
    const items = [assistant("answer"), activity("tool")];
    const output = projectTranslationTimeline({
      enabled: false,
      tail: items,
      head: [],
      statusFor: () => undefined,
    });
    expect(output.tail).toBe(items);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRANSLATION_CONFIG } from "./client";
import {
  resetTranslationStoreForTest,
  selectPromptOriginal,
  selectPromptWireText,
  setTranslationConfig,
  splitLeadingSlashCommand,
  translateComposerInput,
  useTranslationStore,
} from "./store";

const config = {
  ...DEFAULT_TRANSLATION_CONFIG,
  enabled: true,
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  model: "tencent/hy-mt2-30b-a3b",
  myLanguage: "zh",
  agentLanguage: "en",
};

function stubFetch(...contents: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({
            id: "translation",
            object: "chat.completion.chunk",
            created: 1,
            model: config.model,
            choices: [
              { index: 0, delta: { content: contents.shift() ?? "out" }, finish_reason: null },
            ],
          })}\n\ndata: ${JSON.stringify({
            id: "translation",
            object: "chat.completion.chunk",
            created: 1,
            model: config.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetTranslationStoreForTest();
});

describe("prompt originals", () => {
  it("records the original against the prompt's identity", async () => {
    setTranslationConfig(config);
    stubFetch("Hello");
    const wire = await translateComposerInput("你好", "msg-1");
    expect(wire).toBe("Hello");
    expect(selectPromptOriginal(useTranslationStore.getState(), "msg-1")).toBe("你好");
    expect(selectPromptWireText(useTranslationStore.getState(), "msg-1")).toBe("Hello");
  });

  // Regression: keyed by wire text, two prompts translating to the same string overwrote
  // each other, so one bubble rendered the other's words.
  it("keeps two prompts that translate alike distinct", async () => {
    setTranslationConfig(config);
    stubFetch("Hello", "Hello");
    await translateComposerInput("你好", "msg-1");
    await translateComposerInput("您好", "msg-2");
    const state = useTranslationStore.getState();
    expect(selectPromptOriginal(state, "msg-1")).toBe("你好");
    expect(selectPromptOriginal(state, "msg-2")).toBe("您好");
  });

  it("records nothing when the text was not translated", async () => {
    setTranslationConfig(DEFAULT_TRANSLATION_CONFIG);
    const wire = await translateComposerInput("你好", "msg-1");
    expect(wire).toBe("你好");
    expect(selectPromptOriginal(useTranslationStore.getState(), "msg-1")).toBeUndefined();
  });
});

describe("failure retirement", () => {
  it("drops partial entries but keeps completed translations when configuration changes", () => {
    setTranslationConfig(config);
    useTranslationStore.setState({
      entries: { partial: "半截", complete: "完成" },
      status: { partial: "streaming", complete: "complete" },
    });
    setTranslationConfig({ ...config, model: "replacement-model" });
    expect(useTranslationStore.getState()).toMatchObject({
      entries: { complete: "完成" },
      status: { complete: "complete" },
    });
  });

  it("clears failed entries when the configuration changes", () => {
    setTranslationConfig(config);
    useTranslationStore.setState({ status: { "zh\nHello": "failed" } });
    setTranslationConfig({ ...config, apiKey: "sk-corrected" });
    expect(useTranslationStore.getState().status).toEqual({});
  });

  it("keeps failures when the configuration is unchanged", () => {
    setTranslationConfig(config);
    useTranslationStore.setState({ status: { "zh\nHello": "failed" } });
    setTranslationConfig({ ...config });
    expect(useTranslationStore.getState().status).toEqual({ "zh\nHello": "failed" });
  });
});

describe("leading slash commands", () => {
  it("splits the command token and its original whitespace from the translatable body", () => {
    expect(splitLeadingSlashCommand("/goal  写一个测试")).toEqual({
      prefix: "/goal  ",
      body: "写一个测试",
    });
    expect(splitLeadingSlashCommand("/goal\n写一个测试")).toEqual({
      prefix: "/goal\n",
      body: "写一个测试",
    });
    expect(splitLeadingSlashCommand("  /goal\t写一个测试")).toEqual({
      prefix: "  /goal\t",
      body: "写一个测试",
    });
  });

  it("keeps a bare slash command unchanged", async () => {
    setTranslationConfig(config);
    expect(await translateComposerInput("/goal", "msg-command")).toBe("/goal");
  });

  it("translates only the text after the command", async () => {
    setTranslationConfig(config);
    stubFetch("Write a test");
    expect(await translateComposerInput("/goal  写一个测试", "msg-command-body")).toBe(
      "/goal  Write a test",
    );
  });
});

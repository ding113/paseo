import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRANSLATION_CONFIG } from "./client";
import {
  resetTranslationStoreForTest,
  selectPromptOriginal,
  setTranslationConfig,
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
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ choices: [{ message: { content: contents.shift() ?? "out" } }] }),
        }) as Response,
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

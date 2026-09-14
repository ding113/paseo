import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRANSLATION_CONFIG } from "./client";
import {
  requestTranslation,
  resetTranslationStoreForTest,
  selectPromptOriginal,
  selectPromptWireText,
  selectTranslation,
  selectTranslationStatus,
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

function sseResponse(content: string): Response {
  const chunk = (delta: object, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "translation",
      object: "chat.completion.chunk",
      created: 1,
      model: config.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return new Response(`${chunk({ content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

const BATCH_WINDOW_MS = 300;
/** Longer than every retry backoff combined. */
const RETRY_WINDOW_MS = 10_000;
const statusOf = (text: string) =>
  selectTranslationStatus(useTranslationStore.getState(), text, "zh", "agent-output");
const translationOf = (text: string) =>
  selectTranslation(useTranslationStore.getState(), text, "zh", "agent-output");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetTranslationStoreForTest();
});

describe("agent output queue", () => {
  // Regression: every stream flush re-requested text still waiting for its first token, so
  // one block went out several times and a late copy flipped a finished translation back to
  // streaming.
  it("sends text that is re-requested while in flight only once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTranslationConfig(config);
    let respond!: () => void;
    const answered = new Promise<void>((resolve) => {
      respond = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await answered;
      return sseResponse("你好");
    });
    vi.stubGlobal("fetch", fetchMock);

    requestTranslation("Hello", "zh", "agent-output");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    requestTranslation("Hello", "zh", "agent-output");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    respond();

    await vi.waitFor(() => expect(statusOf("Hello")).toBe("complete"));
    expect(translationOf("Hello")).toBe("你好");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("translates a paragraph shared by two messages once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTranslationConfig(config);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      sseResponse(String(init?.body).includes("Shared paragraph") ? "共享" : "其余"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const merged = "Shared paragraph\n\nAnother paragraph";

    requestTranslation("Shared paragraph", "zh", "agent-output");
    requestTranslation(merged, "zh", "agent-output");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);

    await vi.waitFor(() => {
      expect(statusOf("Shared paragraph")).toBe("complete");
      expect(statusOf(merged)).toBe("complete");
    });
    expect(translationOf(merged)).toBe("共享\n\n其余");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Regression: one failed segment marked every message in its batch failed and erased them.
  it("fails only the message whose request failed, without retrying a rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTranslationConfig(config);
    let brokenRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (!String(init?.body).includes("Broken")) return sseResponse("你好");
        brokenRequests += 1;
        return new Response("denied", { status: 401 });
      }),
    );

    requestTranslation("Kept", "zh", "agent-output");
    requestTranslation("Broken", "zh", "agent-output");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);

    await vi.waitFor(() => {
      expect(statusOf("Broken")).toBe("failed");
      expect(statusOf("Kept")).toBe("complete");
    });
    expect(translationOf("Kept")).toBe("你好");
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
    expect(brokenRequests).toBe(1);
  });

  it("retries a request that dropped on the network", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTranslationConfig(config);
    const fetchMock = vi
      .fn(async (_url: string, _init?: RequestInit) => sseResponse("重试成功"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    requestTranslation("Flaky network", "zh", "agent-output");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(statusOf("Flaky network")).toBe("pending");
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_MS);

    await vi.waitFor(() => expect(statusOf("Flaky network")).toBe("complete"));
    expect(translationOf("Flaky network")).toBe("重试成功");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated network failures", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setTranslationConfig(config);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    requestTranslation("Offline", "zh", "agent-output");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + RETRY_WINDOW_MS);

    await vi.waitFor(() => expect(statusOf("Offline")).toBe("failed"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTranslationProvider,
  buildTranslationPrompt,
  DEFAULT_TRANSLATION_CONFIG,
  isTranslationConfigured,
  streamTranslation,
  stripReasoningTags,
  testTranslationConnection,
  type TranslationProvider,
} from "./client";

const config = { ...DEFAULT_TRANSLATION_CONFIG, enabled: true, apiKey: "sk-test" };

function streamingReply(chunks: string[], finishReason = "stop"): Response {
  const lines = chunks.map(
    (content) =>
      `data: ${JSON.stringify({
        id: "translation-1",
        object: "chat.completion.chunk",
        created: 1,
        model: config.model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
  );
  lines.push(
    `data: ${JSON.stringify({
      id: "translation-1",
      object: "chat.completion.chunk",
      created: 1,
      model: config.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`,
    "data: [DONE]\n\n",
  );
  return new Response(lines.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function stubFetch(...contents: string[]) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    streamingReply([contents.shift() ?? "translated"]),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(call: unknown[] | undefined): Record<string, unknown> {
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? "{}"));
}

afterEach(() => vi.unstubAllGlobals());

describe("translation prompt", () => {
  it("keeps product and git terms untranslated with original casing", () => {
    const prompt = buildTranslationPrompt("zh", "Agent Prompt Config Skills worktree workspace");
    for (const term of [
      "Agent",
      "Prompt",
      "Config",
      "Skills",
      "worktree",
      "workspace",
      "repository",
      "repo",
      "commit",
      "branch",
      "remote",
      "upstream",
      "fork",
      "rebase",
      "pull request",
      "PR",
      "HEAD",
    ]) {
      expect(prompt).toContain(`\`${term}\``);
    }
  });

  it("retains the Hy-MT2 translation and agent-output scaffolds", () => {
    expect(buildTranslationPrompt("zh", "Hello")).toContain("将以下文本翻译为 中文");
    const agentPrompt = buildTranslationPrompt(
      "en",
      "The boundary is load-bearing.",
      "agent-output",
    );
    expect(agentPrompt).toContain("*[Source Text]*");
    expect(agentPrompt).toContain("*[Translation Tasks]*");
    expect(agentPrompt).toContain("Translate the [Source Text] into English.");
  });

  it("maps supported locale aliases and rejects unknown languages", () => {
    expect(buildTranslationPrompt("zh-TW", "x")).toContain("繁体中文");
    expect(buildTranslationPrompt("zh-CN", "x")).toContain("中文");
    expect(buildTranslationPrompt("pt-BR", "x")).toContain("Portuguese");
    expect(buildTranslationPrompt("klingon", "x")).toBeNull();
    expect(isTranslationConfigured({ ...config, myLanguage: "klingon" })).toBe(false);
  });
});

describe("AI SDK streaming translation", () => {
  it("streams the translation and returns the final text", async () => {
    const fetchMock = stubFetch("你好");
    const partials: string[] = [];
    const result = await streamTranslation({
      text: "Hello",
      targetLanguage: "zh",
      config,
      onText: (text) => partials.push(text),
    });
    expect(result).toBe("你好");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(partials).toContain("你好");
  });

  it("retries a rate-limited request", async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init?: RequestInit) => streamingReply(["你好"]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "retry-after-ms": "0" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(streamTranslation({ text: "Hello", targetLanguage: "zh", config })).resolves.toBe(
      "你好",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("enables streaming and keeps the recommended sampling parameters", async () => {
    const fetchMock = stubFetch("你好");
    await streamTranslation({ text: "Hello", targetLanguage: "zh", config });
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(1);
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user", content: expect.stringContaining("Hello") }),
    ]);
  });

  it("accepts either an API root or a full completions URL", async () => {
    const fetchMock = stubFetch("a", "b");
    await streamTranslation({ text: "A", targetLanguage: "zh", config });
    await streamTranslation({
      text: "B",
      targetLanguage: "zh",
      config: { ...config, baseUrl: `${config.baseUrl}/chat/completions` },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${config.baseUrl}/chat/completions`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${config.baseUrl}/chat/completions`);
  });

  it("strips tagged reasoning from streamed output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingReply(["<think>draft", "ing</think>最终"])),
    );
    await expect(streamTranslation({ text: "Hello", targetLanguage: "zh", config })).resolves.toBe(
      "最终",
    );
  });

  it("rejects failed, truncated, and empty responses as final", async () => {
    const denied = vi.fn(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", denied);
    await expect(
      streamTranslation({ text: "Hello", targetLanguage: "zh", config }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/401/), retryable: false });
    expect(denied).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingReply(["partial"], "length")),
    );
    await expect(
      streamTranslation({ text: "Hello", targetLanguage: "zh", config }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/truncated/), retryable: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingReply(["   "])),
    );
    await expect(
      streamTranslation({ text: "Hello", targetLanguage: "zh", config }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/empty/), retryable: false });
  });

  // Browsers report a dropped connection as a bare "Failed to fetch", which the AI SDK does not
  // retry; the caller has to.
  it("marks a network failure retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      streamTranslation({ text: "Hello", targetLanguage: "zh", config }),
    ).rejects.toMatchObject({ name: "TranslationError", retryable: true });
  });

  it("tests a connection even while translation is disabled", async () => {
    stubFetch("你好");
    await expect(testTranslationConnection({ ...config, enabled: false })).resolves.toBeUndefined();
  });
});

function captureRequests(reply: () => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({ url: String(url), headers });
    return reply();
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function errorReply(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reasoningReply(reasoning: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "translation-1",
      object: "chat.completion.chunk",
      created: 1,
      model: config.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    `${chunk({ reasoning_content: reasoning }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

// The endpoint field is the one users get wrong and the one a self-hosted gateway depends on, so
// every provider is pinned to the URL its base URL produces rather than to its vendor default.
describe("the configured base URL reaches the wire", () => {
  const cases: [TranslationProvider, string][] = [
    ["openai-compatible", "https://gw.example.com/v1/chat/completions"],
    ["openai", "https://gw.example.com/v1/chat/completions"],
    ["anthropic", "https://gw.example.com/v1/messages"],
    ["google", "https://gw.example.com/v1/models/my-model:streamGenerateContent?alt=sse"],
  ];

  for (const [provider, expectedUrl] of cases) {
    it(`${provider} requests the user's endpoint`, async () => {
      const calls = captureRequests(() => streamingReply(["你好"]));
      await streamTranslation({
        text: "Hello",
        targetLanguage: "zh",
        config: {
          ...config,
          provider,
          baseUrl: "https://gw.example.com/v1",
          model: "my-model",
          // Anthropic and Google do not stream OpenAI chunks; only the request is under test.
        },
      }).catch(() => undefined);
      expect(calls[0]?.url).toBe(expectedUrl);
    });
  }

  // Anthropic's Messages API rejects a browser-origin request at the CORS preflight unless the
  // caller opts in by name, and every Paseo surface that translates is a browser context.
  it("opts in to Anthropic's direct browser access", async () => {
    const calls = captureRequests(() => errorReply(400, { error: { message: "stop" } }));
    await streamTranslation({
      text: "Hello",
      targetLanguage: "zh",
      config: { ...config, provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
    }).catch(() => undefined);
    expect(calls[0]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });
});

describe("a failed request names what the provider said", () => {
  // Only the OpenAI-shaped error schema lands in the SDK's own message. Anthropic, Google, and any
  // gateway with its own error shape leave it generic and put the reason in the raw body.
  const bodies: [string, unknown, RegExp][] = [
    [
      "anthropic",
      { type: "error", error: { type: "not_found_error", message: "model: bogus" } },
      /model: bogus/,
    ],
    [
      "google",
      { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } },
      /API key not valid/,
    ],
    ["openai", { error: { message: "insufficient_quota" } }, /insufficient_quota/],
    ["plain text", "upstream connect error", /upstream connect error/],
  ];

  for (const [label, body, expected] of bodies) {
    it(`surfaces a ${label} error body`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => errorReply(400, body)),
      );
      await expect(
        streamTranslation({ text: "Hello", targetLanguage: "zh", config }),
      ).rejects.toMatchObject({ message: expect.stringMatching(expected) });
    });
  }

  it("names the URL it actually called", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorReply(401, { error: { message: "no" } })),
    );
    await expect(
      streamTranslation({
        text: "Hello",
        targetLanguage: "zh",
        config: { ...config, baseUrl: "https://gw.example.com/v1" },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("https://gw.example.com/v1/chat/completions"),
    });
  });
});

describe("a reply whose content arrived as reasoning", () => {
  it("uses it when Paseo did not ask for reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reasoningReply("你好")),
    );
    await expect(streamTranslation({ text: "Hello", targetLanguage: "zh", config })).resolves.toBe(
      "你好",
    );
  });

  // With an effort set, reasoning is a genuine thought trace and rendering it as the translation
  // would be worse than failing.
  it("fails with the count when reasoning was requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reasoningReply("weighing the options")),
    );
    await expect(
      streamTranslation({
        text: "Hello",
        targetLanguage: "zh",
        config: { ...config, reasoningEffort: "high" },
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/20 characters of reasoning/) });
  });
});

// The SDK's extractReasoningMiddleware buffers a trailing fragment that could still become an
// opening tag and never flushes it, so a reply ending in `<` used to lose its tail.
describe("reasoning tags", () => {
  it("keeps a trailing fragment that never became a tag", async () => {
    for (const tail of ["a <", "a <th", "a <thin", "x < y"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => streamingReply([tail])),
      );
      await expect(
        streamTranslation({ text: "Hello", targetLanguage: "zh", config }),
      ).resolves.toBe(tail);
      vi.unstubAllGlobals();
    }
  });

  it("strips both tag spellings and an unclosed block", () => {
    expect(stripReasoningTags("<think>a</think>b")).toBe("b");
    expect(stripReasoningTags("<thinking>a</thinking>b")).toBe("b");
    expect(stripReasoningTags("b<think>trailing")).toBe("b");
    expect(stripReasoningTags("b <thin", { partial: true })).toBe("b ");
    expect(stripReasoningTags("b <thin")).toBe("b <thin");
  });
});

describe("switching provider", () => {
  it("moves untouched endpoint and model to the new provider's defaults", () => {
    const next = applyTranslationProvider(config, "anthropic");
    expect(next).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
    });
  });

  it("keeps an endpoint and model the user typed", () => {
    const custom = { ...config, baseUrl: "https://gw.internal/v1", model: "qwen-mt-plus" };
    const next = applyTranslationProvider(custom, "openai");
    expect(next).toMatchObject({
      provider: "openai",
      baseUrl: "https://gw.internal/v1",
      model: "qwen-mt-plus",
    });
  });

  it("carries the key and languages through either way", () => {
    const custom = { ...config, apiKey: "sk-mine", myLanguage: "ja", agentLanguage: "en" };
    expect(applyTranslationProvider(custom, "google")).toMatchObject({
      apiKey: "sk-mine",
      myLanguage: "ja",
      agentLanguage: "en",
    });
  });

  it("switches back without stranding the previous provider's defaults", () => {
    const toOpenAi = applyTranslationProvider(config, "openai");
    const back = applyTranslationProvider(toOpenAi, "openai-compatible");
    expect(back).toMatchObject({
      baseUrl: DEFAULT_TRANSLATION_CONFIG.baseUrl,
      model: DEFAULT_TRANSLATION_CONFIG.model,
    });
  });
});

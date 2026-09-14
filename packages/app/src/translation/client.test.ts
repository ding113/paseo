import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTranslationPrompt,
  DEFAULT_TRANSLATION_CONFIG,
  isTranslationConfigured,
  streamTranslation,
  testTranslationConnection,
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

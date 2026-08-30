import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTranslationPrompt,
  DEFAULT_TRANSLATION_CONFIG,
  isTranslationConfigured,
  testTranslationConnection,
  translateSegments,
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
  it("streams one request per segment and returns results in order", async () => {
    const fetchMock = stubFetch("你好", "世界");
    const partials: string[] = [];
    const result = await translateSegments({
      segments: ["Hello", "World"],
      targetLanguage: "zh",
      config,
      onText: (index, text) => partials.push(`${index}:${text}`),
    });
    expect(result).toEqual(["你好", "世界"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(partials).toEqual(expect.arrayContaining(["0:你好", "1:世界"]));
  });

  it("enables streaming and keeps the recommended sampling parameters", async () => {
    const fetchMock = stubFetch("你好");
    await translateSegments({ segments: ["Hello"], targetLanguage: "zh", config });
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
    await translateSegments({ segments: ["A"], targetLanguage: "zh", config });
    await translateSegments({
      segments: ["B"],
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
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).resolves.toEqual(["最终"]);
  });

  it("rejects failed, truncated, and empty responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).rejects.toThrow(/401/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingReply(["partial"], "length")),
    );
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).rejects.toThrow(/truncated/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingReply(["   "])),
    );
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).rejects.toThrow(/empty/);
  });

  it("tests a connection even while translation is disabled", async () => {
    stubFetch("你好");
    await expect(testTranslationConnection({ ...config, enabled: false })).resolves.toBeUndefined();
  });
});

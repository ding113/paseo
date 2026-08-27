import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTranslationPrompt,
  DEFAULT_TRANSLATION_CONFIG,
  isTranslationConfigured,
  translateSegments,
} from "./client";

const config = {
  ...DEFAULT_TRANSLATION_CONFIG,
  enabled: true,
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  model: "tencent/hy-mt2-30b-a3b",
};

function reply(content: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

function stubFetch(...contents: string[]) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    reply(contents.shift() ?? "translated"),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fetch that never resolves, rejecting only when its request is aborted. */
function neverResponds(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const fail = () => reject(init?.signal?.reason ?? new Error("aborted"));
    init?.signal?.addEventListener("abort", fail);
  });
}

function bodyOf(call: [string, RequestInit?] | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.[1]?.body ?? "{}"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Hy-MT2 prompt", () => {
  // These two strings are the model card's "Default Translation" row, reproduced
  // character-for-character. If a test here fails, the prompt drifted from the card —
  // fix the code, not the expectation.
  it("matches the documented Chinese instruction", () => {
    expect(buildTranslationPrompt("zh", "Hello")).toBe(
      "将以下文本翻译为 中文，注意**只需要输出翻译后的结果，不要额外解释**：\n\nHello",
    );
  });

  it("matches the documented English instruction", () => {
    expect(buildTranslationPrompt("en", "你好")).toBe(
      "Translate the following text into English. Note that you should **only output the translated result without any additional explanation**:\n\n你好",
    );
  });

  it("uses the Chinese name in the Chinese prompt and the English name in the English one", () => {
    expect(buildTranslationPrompt("zh-Hant", "x")).toContain("翻译为 繁体中文，");
    expect(buildTranslationPrompt("ja", "x")).toContain("into Japanese.");
  });

  it("maps the app's locale tags onto the model card's abbreviations", () => {
    expect(buildTranslationPrompt("zh-CN", "x")).toBe(buildTranslationPrompt("zh", "x"));
    expect(buildTranslationPrompt("pt-BR", "x")).toBe(buildTranslationPrompt("pt", "x"));
  });

  it("resolves the Traditional Chinese locale aliases", () => {
    // Regression: the alias value is cased like the model card (`zh-Hant`) while the input
    // was lowercased, so these resolved to nothing and silently disabled the whole feature.
    expect(buildTranslationPrompt("zh-TW", "x")).toContain("翻译为 繁体中文，");
    expect(buildTranslationPrompt("zh-HK", "x")).toContain("翻译为 繁体中文，");
    expect(isTranslationConfigured({ ...config, myLanguage: "zh-TW" })).toBe(true);
  });

  it("rejects a language the model card does not list", () => {
    expect(buildTranslationPrompt("klingon", "x")).toBeNull();
    expect(isTranslationConfigured({ ...config, myLanguage: "klingon" })).toBe(false);
  });
});

describe("translateSegments", () => {
  it("returns one translation per segment, in order", async () => {
    stubFetch("你好", "世界");
    const result = await translateSegments({
      segments: ["Hello", "World"],
      targetLanguage: "zh",
      config,
    });
    expect(result).toEqual(["你好", "世界"]);
  });

  it("sends one request per segment", async () => {
    const fetchMock = stubFetch("你好", "世界");
    await translateSegments({ segments: ["Hello", "World"], targetLanguage: "zh", config });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the instruction as a single user turn with no system prompt", async () => {
    const fetchMock = stubFetch("你好");
    await translateSegments({ segments: ["Hello"], targetLanguage: "zh", config });
    const messages = bodyOf(fetchMock.mock.calls[0]).messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("sends the sampling parameters the model card recommends for 30B-A3B", async () => {
    const fetchMock = stubFetch("你好");
    await translateSegments({ segments: ["Hello"], targetLanguage: "zh", config });
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(1.0);
    // Documented as -1 / 1.0, which are no-ops; omitted so gateways cannot reject them.
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("repetition_penalty");
    // Omitted so the server applies the configured model's own maximum.
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("accepts a base URL that already names the completions path", async () => {
    const fetchMock = stubFetch("你好");
    await translateSegments({
      segments: ["Hello"],
      targetLanguage: "zh",
      config: { ...config, baseUrl: "https://openrouter.ai/api/v1/chat/completions" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("appends the completions path to a bare root", async () => {
    const fetchMock = stubFetch("你好");
    await translateSegments({ segments: ["Hello"], targetLanguage: "zh", config });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized" }) as Response),
    );
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).rejects.toThrow(/401/);
  });

  it("rejects a completion truncated at the output limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              choices: [{ message: { content: "这是一段被截断的" }, finish_reason: "length" }],
            }),
          }) as Response,
      ),
    );
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).rejects.toThrow(/truncated/);
  });

  it("gives up on a request that never responds", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(neverResponds));
      const pending = translateSegments({ segments: ["Hello"], targetLanguage: "zh", config });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on an empty completion rather than blanking the message", async () => {
    stubFetch("   ");
    await expect(
      translateSegments({ segments: ["Hello"], targetLanguage: "zh", config }),
    ).rejects.toThrow(/empty/);
  });
});

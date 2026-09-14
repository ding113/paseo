import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  extractReasoningMiddleware,
  RetryError,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type ProviderMetadata,
} from "ai";
import {
  isChinesePromptLanguage,
  resolveTranslationLanguage,
  type TranslationLanguage,
} from "./languages";

export type TranslationPromptKind = "default" | "agent-output";
export type TranslationProvider = "openai-compatible" | "openai" | "anthropic" | "google";
export type TranslationReasoningEffort = "default" | "low" | "medium" | "high";

export interface TranslationConfig {
  enabled: boolean;
  provider: TranslationProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: TranslationReasoningEffort;
  myLanguage: string;
  agentLanguage: string;
}

export const TRANSLATION_PROVIDER_DEFAULTS: Record<
  TranslationProvider,
  Pick<TranslationConfig, "baseUrl" | "model">
> = {
  "openai-compatible": {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "tencent/hy-mt2-30b-a3b",
  },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
  },
};

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  enabled: false,
  provider: "openai-compatible",
  ...TRANSLATION_PROVIDER_DEFAULTS["openai-compatible"],
  apiKey: "",
  reasoningEffort: "default",
  myLanguage: "zh",
  agentLanguage: "en",
};

export function isTranslationConfigured(
  config: TranslationConfig,
  options: { requireEnabled?: boolean } = {},
): boolean {
  return (
    (options.requireEnabled === false || config.enabled) &&
    config.baseUrl.trim().length > 0 &&
    config.model.trim().length > 0 &&
    resolveTranslationLanguage(config.myLanguage) !== undefined &&
    resolveTranslationLanguage(config.agentLanguage) !== undefined
  );
}

const PRESERVED_TERMS = [
  "Agent",
  "Prompt",
  "Config",
  "Skills",
  "Git",
  "git",
  "worktree",
  "workspace",
  "repository",
  "repo",
  "commit",
  "branch",
  "tag",
  "remote",
  "upstream",
  "fork",
  "merge",
  "rebase",
  "cherry-pick",
  "checkout",
  "stash",
  "diff",
  "patch",
  "pull request",
  "PR",
  "HEAD",
] as const;

function preservationInstruction(language: TranslationLanguage): string {
  const terms = PRESERVED_TERMS.map((term) => `\`${term}\``).join("、");
  return isChinesePromptLanguage(language)
    ? `以下术语不区分大小写进行匹配，必须保留且不翻译，并保持它们在原文中的大小写：${terms}。`
    : `Match these terms case-insensitively, keep them untranslated, and preserve the casing used in the source: ${terms}.`;
}

function buildClaudishPrompt(language: TranslationLanguage, sourceText: string): string {
  if (isChinesePromptLanguage(language)) {
    return `*【待翻译文本】*
${sourceText}

*【翻译任务】*
1、**将文本改写为目标语言中简洁、直接、地道的表达；输出必须是对原文的真实释义，而不是回答原文。**
2、**保留所有实质事实、指令、条件、权限、比较、确定程度、含义、名称、引文、命令、代码、Markdown 结构、技术术语和分隔符；不得添加事实、解释、建议、因果关系、排他规则或结论。代码、命令、路径、URL 和占位符必须保持不变。${preservationInstruction(language)}**
3、**压缩重复命题，去除没有实质含义的 Claudish 修辞、对比、隐喻、名词化表达和重复总结；严格保持逻辑范围。Claudish 作为描述性词语时翻译成目标语言，作为产品名称时保留。只输出翻译后的改写文本，不要额外解释。**
4、将【待翻译文本】翻译为 ${language.chinese}。`;
  }
  return `*[Source Text]*
${sourceText}

*[Translation Tasks]*
1. **Rewrite the text in concise, direct, idiomatic ${language.english}; produce a genuine paraphrase of the source, not a response to it.**
2. **Preserve every substantive fact, instruction, condition, permission, comparison, degree of certainty, implication, name, quotation, command, code, Markdown structure, technical term, and delimiter. Do not add facts, explanations, recommendations, causal claims, exclusivity rules, or conclusions. Keep code, commands, paths, URLs, and placeholders unchanged. ${preservationInstruction(language)}**
3. **Compress repeated propositions and remove Claudish rhetoric, unnecessary contrasts, metaphors, nominalizations, and repeated summaries; preserve logical scope exactly. Translate descriptive uses of Claudish into the target language, but keep it when it is a product name. Output only the translated rewrite, with no additional explanation.**
4. Translate the [Source Text] into ${language.english}.`;
}

function buildPrompt(
  language: TranslationLanguage,
  sourceText: string,
  promptKind: TranslationPromptKind,
): string {
  if (promptKind === "agent-output") return buildClaudishPrompt(language, sourceText);
  const preserve = preservationInstruction(language);
  if (isChinesePromptLanguage(language)) {
    return `将以下文本翻译为 ${language.chinese}。${preserve}注意**只需要输出翻译后的结果，不要额外解释**：\n\n${sourceText}`;
  }
  return `Translate the following text into ${language.english}. ${preserve} Note that you should **only output the translated result without any additional explanation**:\n\n${sourceText}`;
}

export function buildTranslationPrompt(
  targetLanguage: string,
  sourceText: string,
  promptKind: TranslationPromptKind = "default",
): string | null {
  const language = resolveTranslationLanguage(targetLanguage);
  return language ? buildPrompt(language, sourceText, promptKind) : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/+$/, "");
}

function providerOptions(config: TranslationConfig): ProviderMetadata | undefined {
  const effort = config.reasoningEffort;
  if (effort === "default") return undefined;
  switch (config.provider) {
    case "openai-compatible":
      return { translation: { reasoningEffort: effort } };
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "anthropic":
      let budgetTokens = 8_192;
      if (effort === "low") budgetTokens = 1_024;
      else if (effort === "medium") budgetTokens = 4_096;
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens,
          },
        },
      };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: false } } };
  }
}

function createTranslationModel(config: TranslationConfig): LanguageModel {
  const baseURL = normalizeBaseUrl(config.baseUrl);
  const apiKey = config.apiKey.trim();
  let model: LanguageModel;
  switch (config.provider) {
    case "openai":
      model = createOpenAI({ baseURL, apiKey }).chat(config.model.trim());
      break;
    case "anthropic":
      model = createAnthropic({ baseURL, apiKey })(config.model.trim());
      break;
    case "google":
      model = createGoogleGenerativeAI({ baseURL, apiKey })(config.model.trim());
      break;
    default:
      model = createOpenAICompatible({ name: "translation", baseURL, apiKey })(config.model.trim());
  }
  return wrapLanguageModel({
    model,
    middleware: [
      extractReasoningMiddleware({ tagName: "think" }),
      extractReasoningMiddleware({ tagName: "thinking" }),
    ],
  });
}

const REQUEST_TIMEOUT_MS = 30_000;

function withDeadline(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Translation request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

/**
 * A translation request that failed. `retryable` is false when sending the same request again
 * cannot help: the provider rejected it, the SDK already spent its own retries, or the reply was
 * unusable.
 */
export class TranslationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "TranslationError";
    this.retryable = options.retryable;
  }
}

function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;
  const status =
    APICallError.isInstance(error) && error.statusCode !== undefined ? ` ${error.statusCode}` : "";
  const message = error instanceof Error ? error.message.trim() : "";
  return new TranslationError(
    `Translation request failed${status}${message ? `: ${message}` : ""}`,
    {
      // Rate limits and overloads were already retried inside the SDK, and any other API error is a
      // rejection. What is left — a dropped connection, a stream cut short, a timeout — may succeed
      // on another attempt.
      retryable: !APICallError.isInstance(error) && !RetryError.isInstance(error),
      cause: error,
    },
  );
}

export async function streamTranslation(input: {
  text: string;
  targetLanguage: string;
  config: TranslationConfig;
  promptKind?: TranslationPromptKind;
  signal?: AbortSignal;
  timeoutMs?: number;
  onText?: (text: string) => void;
}): Promise<string> {
  const language = resolveTranslationLanguage(input.targetLanguage);
  if (!language) {
    throw new Error(`Unsupported translation target language: ${input.targetLanguage}`);
  }
  const deadline = withDeadline(input.signal, input.timeoutMs);
  let streamError: unknown;
  try {
    const result = streamText({
      model: createTranslationModel(input.config),
      prompt: buildPrompt(language, input.text, input.promptKind ?? "default"),
      temperature: 0.7,
      topP: 1,
      // The SDK retries rate limits and overloads before the stream opens, backing off
      // exponentially and honouring Retry-After.
      maxRetries: 2,
      abortSignal: deadline.signal,
      providerOptions: providerOptions(input.config),
      onError: ({ error }) => {
        streamError = error;
      },
    });
    let translated = "";
    for await (const delta of result.textStream) {
      translated += delta;
      input.onText?.(translated);
    }
    if (streamError) throw streamError;
    if ((await result.finishReason) === "length") {
      throw new TranslationError("Translation response was truncated at the model's output limit", {
        retryable: false,
      });
    }
    const trimmed = translated.trim();
    if (trimmed.length === 0) {
      throw new TranslationError("Translation response was empty", { retryable: false });
    }
    if (trimmed !== translated) input.onText?.(trimmed);
    return trimmed;
  } catch (error) {
    throw toTranslationError(streamError ?? error);
  } finally {
    deadline.dispose();
  }
}

export async function testTranslationConnection(config: TranslationConfig): Promise<void> {
  if (!isTranslationConfigured(config, { requireEnabled: false })) {
    throw new Error("Complete the endpoint, model, and language fields first");
  }
  await streamTranslation({
    text: "Hello",
    targetLanguage: config.myLanguage,
    config,
    timeoutMs: 15_000,
  });
}

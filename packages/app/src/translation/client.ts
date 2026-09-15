import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  RetryError,
  streamText,
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

/**
 * Apply a provider change to a config.
 *
 * The endpoint and model follow the new provider only while they still hold the old provider's
 * defaults. Once someone has typed their own gateway URL or model name, switching provider keeps
 * it: the picker is also how you correct a mistaken choice, and overwriting both fields made that
 * round trip cost the endpoint and the model every time.
 */
export function applyTranslationProvider(
  config: TranslationConfig,
  provider: TranslationProvider,
): TranslationConfig {
  const outgoing = TRANSLATION_PROVIDER_DEFAULTS[config.provider];
  const incoming = TRANSLATION_PROVIDER_DEFAULTS[provider];
  return {
    ...config,
    provider,
    baseUrl: config.baseUrl.trim() === outgoing.baseUrl ? incoming.baseUrl : config.baseUrl,
    model: config.model.trim() === outgoing.model ? incoming.model : config.model,
  };
}

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
  const model = config.model.trim();
  switch (config.provider) {
    case "openai":
      return createOpenAI({ baseURL, apiKey }).chat(model);
    case "anthropic":
      // Every Paseo surface that translates is a browser context — Expo web, the Electron
      // renderer, and React Native's fetch all send an Origin. The Messages API rejects those at
      // the CORS preflight with `authentication_error` unless the caller opts in by name, and the
      // provider package does not send the header itself.
      return createAnthropic({
        baseURL,
        apiKey,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      })(model);
    case "google":
      return createGoogleGenerativeAI({ baseURL, apiKey })(model);
    default:
      return createOpenAICompatible({ name: "translation", baseURL, apiKey })(model);
  }
}

const REASONING_TAGS = ["think", "thinking"] as const;

// A suffix that could still grow into one of the opening tags: `<`, `<t`, ... `<thinking`.
const PARTIAL_OPENING_TAG = /<(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/;

/**
 * Strip `<think>` / `<thinking>` spans from model text.
 *
 * This replaces the AI SDK's `extractReasoningMiddleware`, which buffers any trailing text that
 * could still become an opening tag and has no `flush`: a reply ending in `<`, `<th`, or `<thin`
 * loses that tail for good. Translations of technical prose end in `<` often enough to matter.
 * The accumulated text is already in hand here, so strip the tags from that instead.
 *
 * An unclosed opening tag hides everything after it, which is what a reasoning block looks like
 * while it streams. `partial` additionally hides a trailing fragment that has not yet resolved
 * into a tag, so a live block does not flash `<thin` before the rest of the tag arrives; the
 * settled text keeps it, because by then it is ordinary text.
 */
export function stripReasoningTags(text: string, options: { partial?: boolean } = {}): string {
  let stripped = text;
  for (const tag of REASONING_TAGS) {
    stripped = stripped
      .replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "")
      .replace(new RegExp(`<${tag}>[\\s\\S]*$`), "");
  }
  return options.partial ? stripped.replace(PARTIAL_OPENING_TAG, "") : stripped;
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

const UPSTREAM_BODY_LIMIT = 600;

/**
 * Pull the human-readable reason out of an error response body.
 *
 * The SDK only parses a body that matches the provider package's own error schema, and puts that
 * into `APICallError.message`. Anthropic, Google, and every OpenAI-compatible gateway that answers
 * in its own shape leave the message generic and the real reason — a bad model id, a disabled key,
 * a region block — only in the raw body.
 */
function upstreamDetail(responseBody: string | undefined): string | null {
  const body = responseBody?.trim();
  if (!body) return null;
  try {
    const message = findErrorMessage(JSON.parse(body));
    if (message) return message;
  } catch {
    // Not JSON. A gateway's plain-text or HTML error still names the failure.
  }
  return body.length > UPSTREAM_BODY_LIMIT ? `${body.slice(0, UPSTREAM_BODY_LIMIT)}…` : body;
}

function findErrorMessage(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (depth > 4 || typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "error_msg", "detail", "reason", "data"]) {
    if (!(key in record)) continue;
    const found = findErrorMessage(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function describeApiCallError(error: APICallError): string {
  const parts: string[] = [];
  if (error.statusCode !== undefined) parts.push(`HTTP ${error.statusCode}`);
  // The resolved URL answers "did my base URL actually take effect" without a rebuild.
  if (error.url) parts.push(error.url);
  const own = error.message.trim();
  const upstream = upstreamDetail(error.responseBody);
  if (upstream && own.includes(upstream)) parts.push(own);
  else if (upstream && upstream.includes(own)) parts.push(upstream);
  else parts.push(...[own, upstream].filter((part): part is string => Boolean(part)));
  return parts.join(" — ");
}

function describeError(error: unknown): string {
  if (APICallError.isInstance(error)) return describeApiCallError(error);
  if (error instanceof Error) return error.message.trim();
  return "";
}

function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;
  const detail = describeError(error);
  return new TranslationError(`Translation request failed${detail ? `: ${detail}` : ""}`, {
    // Rate limits and overloads were already retried inside the SDK, and any other API error is a
    // rejection. What is left — a dropped connection, a stream cut short, a timeout — may succeed
    // on another attempt.
    retryable: !APICallError.isInstance(error) && !RetryError.isInstance(error),
    cause: error,
  });
}

/**
 * Some gateways answer with the whole completion in `reasoning_content` and `content: null`.
 * OpenRouter's Tencent provider does it for 繁体中文, and DeepSeek-shaped endpoints do it for any
 * reasoning model. The AI SDK routes that to the reasoning stream, so `textStream` runs dry and a
 * finished, usable translation was being thrown away as an empty response.
 *
 * Recover it only when Paseo did not ask for reasoning. Under an explicit effort a reply that is
 * all reasoning and no content is a genuine thought trace, and rendering that as the translation
 * would be worse than failing.
 */
function recoverReasoningOnlyText(
  reasoningText: string | undefined,
  config: TranslationConfig,
): string | null {
  if (config.reasoningEffort !== "default") return null;
  const recovered = stripReasoningTags(reasoningText ?? "").trim();
  return recovered.length > 0 ? recovered : null;
}

function emptyResponseMessage(finishReason: string, reasoningText: string | undefined): string {
  const reasoningLength = reasoningText?.trim().length ?? 0;
  if (reasoningLength > 0) {
    return `Translation response carried no content: the provider sent ${reasoningLength} characters of reasoning and an empty message (finish reason: ${finishReason})`;
  }
  return `Translation response was empty (finish reason: ${finishReason})`;
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
    let raw = "";
    let published = "";
    for await (const delta of result.textStream) {
      raw += delta;
      const next = stripReasoningTags(raw, { partial: true });
      if (next === published) continue;
      published = next;
      input.onText?.(published);
    }
    if (streamError) throw streamError;
    const finishReason = await result.finishReason;
    if (finishReason === "length") {
      throw new TranslationError("Translation response was truncated at the model's output limit", {
        retryable: false,
      });
    }
    const settled = stripReasoningTags(raw).trim();
    if (settled.length > 0) {
      if (settled !== published) input.onText?.(settled);
      return settled;
    }
    const reasoningText = await result.reasoningText;
    const recovered = recoverReasoningOnlyText(reasoningText, input.config);
    if (!recovered) {
      throw new TranslationError(emptyResponseMessage(finishReason, reasoningText), {
        retryable: false,
      });
    }
    input.onText?.(recovered);
    return recovered;
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

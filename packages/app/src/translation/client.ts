import {
  isChinesePromptLanguage,
  resolveTranslationLanguage,
  type TranslationLanguage,
} from "./languages";

export interface TranslationConfig {
  enabled: boolean;
  /** OpenAI-compatible root, e.g. `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** What agent output is translated into — the language you read. */
  myLanguage: string;
  /** What your input is translated into — the language the agent works in. */
  agentLanguage: string;
}

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  enabled: false,
  baseUrl: "",
  apiKey: "",
  model: "",
  myLanguage: "zh",
  agentLanguage: "en",
};

export function isTranslationConfigured(config: TranslationConfig): boolean {
  return (
    config.enabled &&
    config.baseUrl.trim().length > 0 &&
    config.model.trim().length > 0 &&
    resolveTranslationLanguage(config.myLanguage) !== undefined &&
    resolveTranslationLanguage(config.agentLanguage) !== undefined
  );
}

/**
 * The "Default Translation" instruction from the Hy-MT2 model card, verbatim.
 *
 * https://huggingface.co/tencent/Hy-MT2-30B-A3B documents each instruction in a Chinese and
 * an English phrasing. Reproduced character-for-character: the `**` emphasis is part of the
 * documented string, and the backticks in the card's table are its notation for the two
 * placeholders, not literal characters (the Style row's ``【**`{target_style}`**】`` only
 * parses that way).
 *
 * Do not reword these. A translation model is tuned against its documented instruction, and
 * paraphrasing is what makes one underperform.
 */
function buildPrompt(language: TranslationLanguage, sourceText: string): string {
  if (isChinesePromptLanguage(language)) {
    return `将以下文本翻译为 ${language.chinese}，注意**只需要输出翻译后的结果，不要额外解释**：\n\n${sourceText}`;
  }
  return `Translate the following text into ${language.english}. Note that you should **only output the translated result without any additional explanation**:\n\n${sourceText}`;
}

/** Exposed for tests, which assert the prompt matches the model card byte-for-byte. */
export function buildTranslationPrompt(targetLanguage: string, sourceText: string): string | null {
  const language = resolveTranslationLanguage(targetLanguage);
  return language ? buildPrompt(language, sourceText) : null;
}

/**
 * Accepts either the API root or a full completions URL. The model card and most vendor
 * dashboards quote the full endpoint, so pasting that in is the expected mistake, not a
 * misconfiguration worth an error.
 */
function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Sampling parameters the model card recommends for 30B-A3B.
 *
 * `top_k: -1` and `repetition_penalty: 1.0` are the card's "disabled" values and are left
 * off the request: they are no-ops, they are not part of the OpenAI schema, and some
 * gateways reject a negative `top_k` outright.
 *
 * `max_tokens` is omitted so each model gets its own ceiling. The card suggests 4096, which
 * is exactly what OpenRouter caps Hy-MT2 at — but this endpoint is user-supplied, and
 * pinning one model's number would silently truncate a model that can write more.
 */
const SAMPLING = { temperature: 0.7, top_p: 1.0 } as const;

async function translateOne(input: {
  text: string;
  language: TranslationLanguage;
  config: TranslationConfig;
  signal?: AbortSignal;
}): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = input.config.apiKey.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(resolveEndpoint(input.config.baseUrl), {
    method: "POST",
    headers,
    ...(input.signal ? { signal: input.signal } : {}),
    body: JSON.stringify({
      model: input.config.model.trim(),
      ...SAMPLING,
      // The model card states these models have no default system prompt, so the whole
      // instruction is the single user turn.
      messages: [{ role: "user", content: buildPrompt(input.language, input.text) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Translation request failed: ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
    ?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Translation response had no message content");
  }
  const translated = content.trim();
  if (translated.length === 0) {
    throw new Error("Translation response was empty");
  }
  return translated;
}

/**
 * Translate each segment with its own request.
 *
 * One segment per request is forced by the instruction itself: it asks for the translated
 * result and nothing else, so there is no room for a batch envelope the reply could be
 * split back out of. Segments are sent concurrently, so a message costs one round trip of
 * wall-clock rather than one per paragraph. It also removes misalignment as a failure mode
 * — a reply can only ever belong to the segment it was requested for.
 */
export async function translateSegments(input: {
  segments: string[];
  targetLanguage: string;
  config: TranslationConfig;
  signal?: AbortSignal;
}): Promise<string[]> {
  if (input.segments.length === 0) return [];

  const language = resolveTranslationLanguage(input.targetLanguage);
  if (!language) {
    throw new Error(`Unsupported translation target language: ${input.targetLanguage}`);
  }

  return Promise.all(
    input.segments.map((text) =>
      translateOne({
        text,
        language,
        config: input.config,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );
}

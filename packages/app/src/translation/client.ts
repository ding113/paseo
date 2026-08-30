import {
  isChinesePromptLanguage,
  resolveTranslationLanguage,
  type TranslationLanguage,
} from "./languages";

export type TranslationPromptKind = "default" | "agent-output";

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
 * The Hy-MT2 prompt instructions. The default branch is the model card's "Default Translation"
 * row verbatim; agent output uses the model card's "Personalization" layout for the claudish
 * rewrite requirements.
 *
 * https://huggingface.co/tencent/Hy-MT2-30B-A3B documents each instruction in a Chinese and
 * an English phrasing. Reproduced character-for-character: the `**` emphasis is part of the
 * documented string, and the backticks in the card's table are its notation for the two
 * placeholders, not literal characters (the Style row's ``【**`{target_style}`**】`` only
 * parses that way).
 *
 * Do not reword the model-card scaffolding. A translation model is tuned against its documented
 * instruction, and changing the format is what makes one underperform.
 */
function buildClaudishPrompt(language: TranslationLanguage, sourceText: string): string {
  if (isChinesePromptLanguage(language)) {
    return `*【待翻译文本】*
${sourceText}

*【翻译任务】*
1、**将文本改写为目标语言中简洁、直接、地道的表达；输出必须是对原文的真实释义，而不是回答原文。**
2、**保留所有实质事实、指令、条件、权限、比较、确定程度、含义、名称、引文、命令、代码、Markdown 结构、技术术语和分隔符；不得添加事实、解释、建议、因果关系、排他规则或结论。代码、命令、路径、URL、占位符以及表示产品能力的字面标签 \`Skills\` 必须保持不变。**
3、**压缩重复命题，去除没有实质含义的 Claudish 修辞、对比、隐喻、名词化表达和重复总结；严格保持逻辑范围。Claudish 作为描述性词语时翻译成目标语言，作为产品名称时保留。只输出翻译后的改写文本，不要额外解释。**
4、将【待翻译文本】翻译为 ${language.chinese}。`;
  }
  return `*[Source Text]*
${sourceText}

*[Translation Tasks]*
1. **Rewrite the text in concise, direct, idiomatic ${language.english}; produce a genuine paraphrase of the source, not a response to it.**
2. **Preserve every substantive fact, instruction, condition, permission, comparison, degree of certainty, implication, name, quotation, command, code, Markdown structure, technical term, and delimiter. Do not add facts, explanations, recommendations, causal claims, exclusivity rules, or conclusions. Keep code, commands, paths, URLs, placeholders, and the literal label \`Skills\` unchanged when it names a product capability.**
3. **Compress repeated propositions and remove Claudish rhetoric, unnecessary contrasts, metaphors, nominalizations, and repeated summaries; preserve logical scope exactly. Translate descriptive uses of Claudish into the target language, but keep it when it is a product name. Output only the translated rewrite, with no additional explanation.**
4. Translate the [Source Text] into ${language.english}.`;
}

function buildPrompt(
  language: TranslationLanguage,
  sourceText: string,
  promptKind: TranslationPromptKind,
): string {
  if (promptKind === "agent-output") {
    return buildClaudishPrompt(language, sourceText);
  }
  if (isChinesePromptLanguage(language)) {
    return `将以下文本翻译为 ${language.chinese}，注意**只需要输出翻译后的结果，不要额外解释**：\n\n${sourceText}`;
  }
  return `Translate the following text into ${language.english}. Note that you should **only output the translated result without any additional explanation**:\n\n${sourceText}`;
}

/** Exposed for tests, which assert the prompt matches the model card byte-for-byte. */
export function buildTranslationPrompt(
  targetLanguage: string,
  sourceText: string,
  promptKind: TranslationPromptKind = "default",
): string | null {
  const language = resolveTranslationLanguage(targetLanguage);
  return language ? buildPrompt(language, sourceText, promptKind) : null;
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

/**
 * Deadline for one translation request.
 *
 * Composer input is translated on the send path, so a socket that connects and then goes
 * quiet would otherwise hold the prompt forever: the optimistic bubble stays pending and
 * the agent never receives anything, because the send-the-original fallback is downstream
 * of this await. A bounded request turns that hang into the fallback.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Aborts on our deadline or on the caller's signal, whichever comes first. */
function withDeadline(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`Translation request timed out after ${REQUEST_TIMEOUT_MS}ms`)),
    REQUEST_TIMEOUT_MS,
  );
  const forward = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

async function translateOne(input: {
  text: string;
  language: TranslationLanguage;
  config: TranslationConfig;
  promptKind: TranslationPromptKind;
  signal?: AbortSignal;
}): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = input.config.apiKey.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const deadline = withDeadline(input.signal);
  let response: Response;
  try {
    response = await fetch(resolveEndpoint(input.config.baseUrl), {
      method: "POST",
      headers,
      signal: deadline.signal,
      body: JSON.stringify({
        model: input.config.model.trim(),
        ...SAMPLING,
        // The model card states these models have no default system prompt, so the whole
        // instruction is the single user turn.
        messages: [
          {
            role: "user",
            content: buildPrompt(input.language, input.text, input.promptKind),
          },
        ],
      }),
    });
  } finally {
    deadline.dispose();
  }

  if (!response.ok) {
    throw new Error(`Translation request failed: ${response.status} ${response.statusText}`);
  }

  const body: unknown = await response.json();
  const choice = (
    body as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    }
  ).choices?.[0];
  // A provider that stops at its output limit still returns usable-looking prose. Accepting
  // it would cache a fragment as the finished translation and silently drop the rest of the
  // message; failing here leaves the original on screen instead.
  if (choice?.finish_reason === "length") {
    throw new Error("Translation response was truncated at the model's output limit");
  }
  const content = choice?.message?.content;
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
  promptKind?: TranslationPromptKind;
  signal?: AbortSignal;
}): Promise<string[]> {
  if (input.segments.length === 0) return [];

  const language = resolveTranslationLanguage(input.targetLanguage);
  if (!language) {
    throw new Error(`Unsupported translation target language: ${input.targetLanguage}`);
  }
  const promptKind = input.promptKind ?? "default";

  return Promise.all(
    input.segments.map((text) =>
      translateOne({
        text,
        language,
        config: input.config,
        promptKind,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );
}

/**
 * The languages Hy-MT2 documents support, with the names its prompts expect.
 *
 * Source: the "Supported Languages" table of
 * https://huggingface.co/tencent/Hy-MT2-30B-A3B — abbreviation, English name, Chinese name.
 * The model card requires full language names in prompts, not codes: "Chinese names should
 * be used in Chinese prompts, and English names should be used in English prompts."
 */
export interface TranslationLanguage {
  code: string;
  /** The name to interpolate into the English prompt template. */
  english: string;
  /** The name to interpolate into the Chinese prompt template. */
  chinese: string;
}

export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  { code: "zh", english: "Chinese", chinese: "中文" },
  { code: "en", english: "English", chinese: "英语" },
  { code: "fr", english: "French", chinese: "法语" },
  { code: "pt", english: "Portuguese", chinese: "葡萄牙语" },
  { code: "es", english: "Spanish", chinese: "西班牙语" },
  { code: "ja", english: "Japanese", chinese: "日语" },
  { code: "tr", english: "Turkish", chinese: "土耳其语" },
  { code: "ru", english: "Russian", chinese: "俄语" },
  { code: "ar", english: "Arabic", chinese: "阿拉伯语" },
  { code: "ko", english: "Korean", chinese: "韩语" },
  { code: "th", english: "Thai", chinese: "泰语" },
  { code: "it", english: "Italian", chinese: "意大利语" },
  { code: "de", english: "German", chinese: "德语" },
  { code: "vi", english: "Vietnamese", chinese: "越南语" },
  { code: "ms", english: "Malay", chinese: "马来语" },
  { code: "id", english: "Indonesian", chinese: "印尼语" },
  { code: "tl", english: "Filipino", chinese: "菲律宾语" },
  { code: "hi", english: "Hindi", chinese: "印地语" },
  { code: "zh-Hant", english: "Traditional Chinese", chinese: "繁体中文" },
  { code: "pl", english: "Polish", chinese: "波兰语" },
  { code: "cs", english: "Czech", chinese: "捷克语" },
  { code: "nl", english: "Dutch", chinese: "荷兰语" },
  { code: "km", english: "Khmer", chinese: "高棉语" },
  { code: "my", english: "Burmese", chinese: "缅甸语" },
  { code: "fa", english: "Persian", chinese: "波斯语" },
  { code: "gu", english: "Gujarati", chinese: "古吉拉特语" },
  { code: "ur", english: "Urdu", chinese: "乌尔都语" },
  { code: "te", english: "Telugu", chinese: "泰卢固语" },
  { code: "mr", english: "Marathi", chinese: "马拉地语" },
  { code: "he", english: "Hebrew", chinese: "希伯来语" },
  { code: "bn", english: "Bengali", chinese: "孟加拉语" },
  { code: "ta", english: "Tamil", chinese: "泰米尔语" },
];

/**
 * Locale tags the app already uses, mapped onto the model card's abbreviations. Paseo's UI
 * language setting speaks BCP-47 (`zh-CN`, `pt-BR`); the model card speaks `zh`, `pt`.
 */
const ALIASES: Record<string, string> = {
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-sg": "zh",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "pt-br": "pt",
  "pt-pt": "pt",
};

export function resolveTranslationLanguage(value: string): TranslationLanguage | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const code = ALIASES[normalized] ?? normalized;
  return TRANSLATION_LANGUAGES.find((language) => language.code.toLowerCase() === code);
}

/**
 * Which prompt template a target language gets. The model card documents a Chinese and an
 * English phrasing of every instruction; a Chinese target reads the Chinese one.
 */
export function isChinesePromptLanguage(language: TranslationLanguage): boolean {
  return language.code === "zh" || language.code === "zh-Hant";
}

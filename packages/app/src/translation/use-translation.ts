import { useEffect } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import {
  isTranslationConfigured,
  type TranslationConfig,
  type TranslationPromptKind,
} from "./client";
import { translationCache } from "./cache";
import {
  requestTranslation,
  selectPromptOriginal,
  selectTranslation,
  setTranslationConfig,
  useTranslationStore,
} from "./store";

export { isCodeBlock } from "./segments";

export function useTranslationConfig(): TranslationConfig {
  return useAppSettings().settings.translation;
}

export function useIsTranslationEnabled(): boolean {
  return isTranslationConfigured(useTranslationConfig());
}

/**
 * Mirrors the persisted config into the translation queue and hydrates the on-disk cache.
 * Mounted once, high in the tree; the queue runs outside React and reads the config from
 * the module rather than from a hook.
 */
export function useTranslationRuntimeSync(): void {
  const config = useTranslationConfig();

  // Published during render, not in an effect. Consumers call `requestTranslation` while
  // rendering, and this provider renders before them; deferring to an effect would let a
  // whole tree ask under the previous config, and since the queue reads a module variable,
  // updating it afterwards re-renders nothing — those messages would stay untranslated
  // until some unrelated state change. The call is idempotent, so repeating it is free.
  setTranslationConfig(config);

  useEffect(() => {
    void translationCache.hydrate();
  }, []);
}

/**
 * The translation of `text`, or `undefined` while it is unavailable. Callers render the
 * original on `undefined`, so a missing, pending, or failed translation degrades to
 * today's behaviour instead of an empty bubble.
 */
export function useTranslatedText(
  text: string | null | undefined,
  targetLanguage: string,
  promptKind: TranslationPromptKind = "default",
): string | undefined {
  const enabled = useIsTranslationEnabled();
  const stored = useTranslationStore((state) =>
    text ? selectTranslation(state, text, targetLanguage, promptKind) : undefined,
  );

  if (!enabled || !text) return undefined;
  if (stored !== undefined) return stored;
  return requestTranslation(text, targetLanguage, promptKind);
}

/** Text produced elsewhere, rendered in the language you read. */
export function useTranslatedForReader(text: string | null | undefined): string | undefined {
  const config = useTranslationConfig();
  return useTranslatedText(text, config.myLanguage);
}

/** Agent output also receives the claudish-to-plain-language rewrite prompt. */
export function useTranslatedAgentOutputForReader(
  text: string | null | undefined,
): string | undefined {
  const config = useTranslationConfig();
  return useTranslatedText(text, config.myLanguage, "agent-output");
}

/**
 * Like `useTranslatedForReader`, but falls back to the input. Use at call sites where an
 * inline `?? original` would add a branch to an already-branchy component.
 */
export function useReaderText(text: string): string {
  return useTranslatedForReader(text) ?? text;
}

/**
 * What the user typed for a prompt that was translated on the way out.
 *
 * Deliberately not gated on whether translation is enabled: this is a local lookup of an
 * already-recorded original, with no request behind it. Gating it would make turning
 * translation off rewrite existing user bubbles, their copy payload, and their rewind text
 * into the agent-language wire text.
 */
export function useOriginalUserText(clientMessageId: string | undefined): string | undefined {
  return useTranslationStore((state) => selectPromptOriginal(state, clientMessageId));
}

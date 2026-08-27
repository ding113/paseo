import { useEffect } from "react";
import { useSettings } from "@/hooks/use-settings";
import { isTranslationConfigured, type TranslationConfig } from "./client";
import { translationCache } from "./cache";
import {
  lookupTranslation,
  requestTranslation,
  selectTranslation,
  setTranslationConfig,
  useTranslationStore,
} from "./store";

export { isCodeBlock } from "./segments";

export function useTranslationConfig(): TranslationConfig {
  return useSettings((settings) => settings.translation);
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

  useEffect(() => {
    setTranslationConfig(config);
  }, [config]);

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
): string | undefined {
  const enabled = useIsTranslationEnabled();
  const stored = useTranslationStore((state) =>
    text ? selectTranslation(state, text, targetLanguage) : undefined,
  );

  if (!enabled || !text) return undefined;
  if (stored !== undefined) return stored;
  return requestTranslation(text, targetLanguage);
}

/** Text produced elsewhere, rendered in the language you read. */
export function useTranslatedForReader(text: string | null | undefined): string | undefined {
  const config = useTranslationConfig();
  return useTranslatedText(text, config.myLanguage);
}

/**
 * Like `useTranslatedForReader`, but falls back to the input. Use at call sites where an
 * inline `?? original` would add a branch to an already-branchy component.
 */
export function useReaderText(text: string): string {
  return useTranslatedForReader(text) ?? text;
}

/**
 * What the user originally typed for a prompt that was translated on the way out, or
 * `undefined` if this text was never translated here. Never issues a request.
 */
export function useOriginalUserText(text: string | null | undefined): string | undefined {
  const config = useTranslationConfig();
  const enabled = useIsTranslationEnabled();
  const stored = useTranslationStore((state) =>
    text ? selectTranslation(state, text, config.myLanguage) : undefined,
  );

  if (!enabled || !text) return undefined;
  if (stored !== undefined) return stored;
  return lookupTranslation(text, config.myLanguage);
}

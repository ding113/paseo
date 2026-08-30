import type { TranslationRenderState } from "./use-translation";

export function resolveRequestedTranslation(source: string, state: TranslationRenderState): string {
  if (!state.enabled || state.status === "failed") return source;
  return state.text ?? "";
}

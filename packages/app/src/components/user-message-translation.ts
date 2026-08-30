export function hasTranslatedOriginal(
  message: string,
  originalMessage: string | undefined,
): boolean {
  return originalMessage !== undefined && originalMessage !== message;
}

export function resolveUserMessageText(input: {
  message: string;
  originalMessage: string | undefined;
  showOriginal: boolean;
}): string {
  return input.showOriginal && hasTranslatedOriginal(input.message, input.originalMessage)
    ? input.originalMessage!
    : input.message;
}

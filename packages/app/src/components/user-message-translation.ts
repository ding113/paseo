export function hasTranslatedOriginal(
  message: string,
  originalMessage: string | undefined,
): boolean {
  return originalMessage !== undefined && originalMessage !== message;
}

export function resolveUserMessageText(input: {
  message: string;
  wireMessage?: string;
  originalMessage: string | undefined;
  showOriginal: boolean;
}): string {
  const wireMessage = input.wireMessage ?? input.message;
  return input.showOriginal && hasTranslatedOriginal(wireMessage, input.originalMessage)
    ? input.originalMessage!
    : wireMessage;
}

import type { StreamItem } from "@/types/stream";
import type { TranslationStatus } from "@/translation/store";

interface TranslationProjectionInput {
  enabled: boolean;
  tail: StreamItem[];
  head: StreamItem[];
  statusFor: (text: string) => TranslationStatus | undefined;
}

/**
 * Hide assistant text until its translation starts, so the source never flashes before the
 * translation. A later assistant block also waits for earlier ones, keeping the prose in order.
 *
 * Every other row renders as it arrives. Holding tool calls and thoughts behind a pending
 * translation left a turn that worked without narrating blank until it ended, and let a slow or
 * retrying translation stall the whole stream.
 */
export function projectTranslationTimeline(input: TranslationProjectionInput): {
  tail: StreamItem[];
  head: StreamItem[];
} {
  if (!input.enabled) return { tail: input.tail, head: input.head };

  let textBlocked = false;
  const isShown = (item: StreamItem): boolean => {
    if (item.kind !== "assistant_message") return true;
    // Whitespace is never sent for translation, so there is nothing to wait for.
    if (item.text.trim().length === 0) return !textBlocked;
    const status = input.statusFor(item.text);
    if (textBlocked || status === undefined || status === "pending") {
      textBlocked = true;
      return false;
    }
    return true;
  };
  const tail = input.tail.filter(isShown);
  const head = input.head.filter(isShown);
  return {
    tail: tail.length === input.tail.length ? input.tail : tail,
    head: head.length === input.head.length ? input.head : head,
  };
}

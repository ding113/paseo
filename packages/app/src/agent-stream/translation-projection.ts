import type { StreamItem } from "@/types/stream";
import type { TranslationStatus } from "@/translation/store";

interface TranslationProjectionInput {
  enabled: boolean;
  isTurnActive: boolean;
  activeTurnId?: string | null;
  tail: StreamItem[];
  head: StreamItem[];
  statusFor: (text: string) => TranslationStatus | undefined;
}

interface TaggedItem {
  item: StreamItem;
  source: "tail" | "head";
}

/**
 * Hide an agent turn until its translated assistant text becomes visible. Once an assistant
 * translation starts, later tool/thought rows remain behind that assistant until it completes,
 * preserving the original event order instead of letting tools jump ahead of their explanation.
 */
export function projectTranslationTimeline(input: TranslationProjectionInput): {
  tail: StreamItem[];
  head: StreamItem[];
} {
  if (!input.enabled) return { tail: input.tail, head: input.head };

  const tagged: TaggedItem[] = [
    ...input.tail.map((item) => ({ item, source: "tail" as const })),
    ...input.head.map((item) => ({ item, source: "head" as const })),
  ];
  const visible: TaggedItem[] = [];
  let group: TaggedItem[] = [];

  const flushGroup = (active: boolean) => {
    if (group.length === 0) return;
    const belongsToActiveTurn =
      input.isTurnActive &&
      (input.activeTurnId
        ? group.some(({ item }) => item.turnId === input.activeTurnId)
        : group.some(({ source }) => source === "head"));
    const hasAssistant = group.some(({ item }) => item.kind === "assistant_message");
    if (!hasAssistant) {
      if (!active && !belongsToActiveTurn) visible.push(...group);
      group = [];
      return;
    }

    const leading: TaggedItem[] = [];
    let releasedAssistant = false;
    for (const taggedItem of group) {
      const item = taggedItem.item;
      if (item.kind === "assistant_message") {
        const status = input.statusFor(item.text);
        if (status === undefined || status === "pending") break;
        if (!releasedAssistant) {
          visible.push(...leading);
          releasedAssistant = true;
        }
        visible.push(taggedItem);
        if (status === "streaming") break;
      } else if (releasedAssistant) {
        visible.push(taggedItem);
      } else {
        leading.push(taggedItem);
      }
    }
    group = [];
  };

  tagged.forEach((taggedItem) => {
    if (taggedItem.item.kind === "user_message") {
      flushGroup(false);
      visible.push(taggedItem);
    } else {
      group.push(taggedItem);
    }
  });
  flushGroup(input.isTurnActive);

  return {
    tail: visible.filter(({ source }) => source === "tail").map(({ item }) => item),
    head: visible.filter(({ source }) => source === "head").map(({ item }) => item),
  };
}

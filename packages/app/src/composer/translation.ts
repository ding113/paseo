import { generateMessageId } from "@/types/stream";
import { translateComposerInput } from "@/translation/store";
import type { ComposerAttachment } from "@/attachments/types";
import type { ComposerInputMode } from "@/composer/input-mode";
import type { MessagePayload } from "./types";

export async function prepareComposerSubmission(input: {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  inputMode: ComposerInputMode;
  translate?: (text: string, clientMessageId: string) => Promise<string>;
}): Promise<MessagePayload> {
  const payload: MessagePayload = {
    text: input.text,
    attachments: input.attachments,
    cwd: input.cwd,
  };
  if (input.inputMode === "terminal") {
    return payload;
  }

  const clientMessageId = generateMessageId();
  const text = await (input.translate ?? translateComposerInput)(input.text, clientMessageId);
  return { ...payload, text, clientMessageId };
}

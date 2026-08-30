import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  /** Identity used to recover the original text when translation changed the prompt. */
  clientMessageId?: string;
  forceSend?: boolean;
}

export interface TextReplacement {
  key: string;
  text: string;
}

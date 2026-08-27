import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

export interface TextPart {
  text: string;
  /** False for parts that must reach the reader byte-for-byte, such as code. */
  translate: boolean;
}

/**
 * A Markdown block that is a fenced or indented code block.
 *
 * `splitMarkdownBlocks` keeps a fence whole — the blank lines inside it are structural —
 * so excluding code from translation is this check rather than a masking pass over prose.
 */
export function isCodeBlock(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~") || /^ {4}\S/.test(text);
}

/** Split a message into alternating prose and code parts, in order. */
export function splitTranslatableParts(text: string): TextPart[] {
  return splitMarkdownBlocks(text).map((block) => ({
    text: block,
    translate: !isCodeBlock(block),
  }));
}

/**
 * Reassemble parts into a message body.
 *
 * The exact run of blank lines between the original blocks is not preserved. It does not
 * need to be: the renderer re-splits this with the same block splitter, and one blank line
 * separator parses identically to several.
 */
export function joinParts(parts: readonly TextPart[]): string {
  return parts.map((part) => part.text).join("\n\n");
}

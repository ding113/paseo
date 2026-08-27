import MarkdownIt from "markdown-it";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";

const codeBlockParser = new MarkdownIt();

export interface TextPart {
  text: string;
  /** False for parts that must reach the reader byte-for-byte, such as code. */
  translate: boolean;
}

/**
 * Whether a Markdown block contains code that must not be translated.
 *
 * `splitMarkdownBlocks` keeps a fence whole — the blank lines inside it are structural — so
 * excluding code is a property of the block rather than a masking pass over prose. The test
 * is on the *parsed* block, not its first characters: a fence nested under a list item or a
 * blockquote starts with `-`, `*`, or `>`, and a prefix check would hand that code to the
 * model. Any block holding code is skipped whole, which can leave a list's prose
 * untranslated — preserving code verbatim is the contract, translating prose is not.
 */
export function isCodeBlock(text: string): boolean {
  return codeBlockParser
    .parse(text, {})
    .some((token) => token.type === "fence" || token.type === "code_block");
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

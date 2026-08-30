import type { ReactNode } from "react";

export interface StreamingMarkdownBlockProps {
  text: string;
  streaming: boolean;
  children: ReactNode;
  onLinkPress: (url: string) => boolean;
}

/** Native keeps the existing React Native markdown renderer; Streamdown is DOM-only. */
export function StreamingMarkdownBlock({ children }: StreamingMarkdownBlockProps) {
  return children;
}

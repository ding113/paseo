import {
  memo,
  useCallback,
  useMemo,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Streamdown, type Components } from "streamdown";
import "streamdown/styles.css";

export interface StreamingMarkdownBlockProps {
  text: string;
  streaming: boolean;
  children: ReactNode;
  onLinkPress: (url: string) => boolean;
}

export const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  text,
  streaming,
  children: fallback,
  onLinkPress,
}: StreamingMarkdownBlockProps) {
  const components = useMemo<Components>(() => {
    function Link({
      href,
      children,
      node: _node,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
      const handleClick = useCallback(
        (event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          if (href) onLinkPress(href);
        },
        [href],
      );
      return (
        <a {...props} href={href} style={linkStyle} onClick={handleClick}>
          {children}
        </a>
      );
    }
    return {
      a: Link,
      p: ({ children }) => <p style={zeroMarginStyle}>{children}</p>,
      h1: ({ children }) => <h1 style={heading1Style}>{children}</h1>,
      h2: ({ children }) => <h2 style={heading2Style}>{children}</h2>,
      h3: ({ children }) => <h3 style={heading3Style}>{children}</h3>,
      h4: ({ children }) => <h4 style={heading4Style}>{children}</h4>,
      ul: ({ children }) => <ul style={listStyle}>{children}</ul>,
      ol: ({ children }) => <ol style={listStyle}>{children}</ol>,
      blockquote: ({ children }) => <blockquote style={blockquoteStyle}>{children}</blockquote>,
      inlineCode: ({ children }) => <code style={inlineCodeStyle}>{children}</code>,
    };
  }, [onLinkPress]);

  if (!streaming) return fallback;
  return (
    <div style={rootStyle}>
      <Streamdown
        mode="streaming"
        parseIncompleteMarkdown
        controls={false}
        animated={false}
        components={components}
        linkSafety={disabledLinkSafety}
      >
        {text}
      </Streamdown>
    </div>
  );
});

const zeroMarginStyle: CSSProperties = { margin: 0 };
const heading1Style: CSSProperties = { margin: 0, fontSize: "1.45em" };
const heading2Style: CSSProperties = { margin: 0, fontSize: "1.3em" };
const heading3Style: CSSProperties = { margin: 0, fontSize: "1.15em" };
const heading4Style: CSSProperties = { margin: 0, fontSize: "1em" };
const listStyle: CSSProperties = { margin: 0, paddingInlineStart: 24 };
const blockquoteStyle: CSSProperties = {
  margin: 0,
  paddingInlineStart: 12,
  borderInlineStart: "2px solid currentColor",
};
const inlineCodeStyle: CSSProperties = {
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  background: "color-mix(in srgb, currentColor 10%, transparent)",
  borderRadius: 4,
  paddingInline: 3,
};
const linkStyle: CSSProperties = { color: "inherit", textDecorationLine: "underline" };
const rootStyle: CSSProperties = {
  color: "inherit",
  font: "inherit",
  lineHeight: "inherit",
  overflowWrap: "anywhere",
};
const disabledLinkSafety = { enabled: false } as const;

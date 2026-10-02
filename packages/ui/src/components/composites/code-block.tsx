import * as React from 'react';

import { cn } from '../../lib/utilities';

/**
 * The closed set of kinds a highlighter may hand a line. It is the token set of
 * Shiki's CSS-variables theme, which is what makes a grammar's hundreds of
 * TextMate scopes collapse to something a palette can actually define.
 */
export const CODE_TOKEN_KINDS = [
  'changed',
  'comment',
  'constant',
  'deleted',
  'function',
  'inserted',
  'keyword',
  'link',
  'parameter',
  'punctuation',
  'string',
  'string-expression',
] as const;

export type CodeTokenKind = (typeof CODE_TOKEN_KINDS)[number];

/** A run of source text of one kind. `null` takes the surrounding text color. */
export interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind | null;
}

/**
 * Written out in full rather than composed as `text-code-${kind}`: Tailwind
 * extracts utilities from source text, so a computed class name generates no
 * CSS at all. The tokens themselves are defined for both themes in
 * `packages/config/tailwind`.
 */
const TOKEN_CLASS: Record<CodeTokenKind, string> = {
  changed: 'text-code-changed',
  comment: 'text-code-comment',
  constant: 'text-code-constant',
  deleted: 'text-code-deleted',
  function: 'text-code-function',
  inserted: 'text-code-inserted',
  keyword: 'text-code-keyword',
  link: 'text-code-link',
  parameter: 'text-code-parameter',
  punctuation: 'text-code-punctuation',
  string: 'text-code-string',
  'string-expression': 'text-code-string-expression',
};

function LineContent({
  text,
}: Readonly<{ text: string | readonly CodeToken[] }>): React.JSX.Element {
  if (typeof text === 'string') return <>{text}</>;
  return (
    <>
      {text.map((token, index) => (
        <span
          // Tokens carry no identity of their own, and a line re-tokenizes whole.
          key={`${String(index)}:${token.text}`}
          data-code-token={token.kind ?? 'none'}
          className={token.kind === null ? undefined : TOKEN_CLASS[token.kind]}
        >
          {token.text}
        </span>
      ))}
    </>
  );
}

/**
 * `w-fit min-w-full` on a line is load-bearing, not decorative: inside the horizontally
 * scrolling `<pre>`, it paints the highlight across the full scroll width of the longest
 * line instead of stopping at the visible edge.
 */
function CodeBlock({
  lines,
  highlightLine,
  path,
  className,
  ...props
}: Readonly<
  React.ComponentProps<'div'> & {
    lines: readonly { n: number; text: string | readonly CodeToken[] }[];
    highlightLine?: number | undefined;
    path?: string | undefined;
  }
>): React.JSX.Element {
  return (
    <div
      data-slot="code-block"
      className={cn('bg-muted/40 border-border overflow-hidden rounded-md border', className)}
      {...props}
    >
      {path !== undefined && (
        <div
          data-slot="code-block-path"
          className="text-muted-foreground border-border truncate border-b px-3 py-1.5 font-mono text-xs"
        >
          {path}
        </div>
      )}
      <pre className="overflow-x-auto py-2 text-xs leading-relaxed">
        {lines.map((line) => (
          <code
            key={line.n}
            data-slot="code-block-line"
            data-highlighted={line.n === highlightLine}
            className="data-[highlighted=true]:bg-accent data-[highlighted=true]:text-accent-foreground block w-fit min-w-full px-3"
          >
            <code
              aria-hidden="true"
              className="text-muted-foreground mr-4 inline-block w-8 shrink-0 text-right select-none"
            >
              {line.n}
            </code>
            <LineContent text={line.text} />
          </code>
        ))}
      </pre>
    </div>
  );
}

export { CodeBlock };

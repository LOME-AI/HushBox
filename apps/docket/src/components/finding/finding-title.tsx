import { useMemo } from 'react';
import { cn } from '@hushbox/ui';
import type { JSX } from 'react';

/**
 * How a code span inside a title is drawn. It is declared once because six
 * surfaces show a title, and inline code that is a chip on one of them and
 * bare text on the rest is the console disagreeing with itself about what a
 * title says.
 */
const TITLE_CODE = '[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:font-mono';

interface FindingTitleProps {
  /** The title's markup, as the renderer parsed it. */
  readonly html: string;
  /** A row's title sits inside a button, where a paragraph is not legal. */
  readonly as?: 'h2' | 'p' | 'span';
  readonly className?: string;
}

/**
 * A title placed as markup rather than as text. A title is one sentence of
 * inline markdown and the audit writes symbols and paths into it as code
 * spans, so a surface placing it as text shows the reader the backticks. The
 * renderer escapes raw html and drops an href a reader must not follow, so
 * nothing placed here is executable.
 */
export function FindingTitle({ html, as: Tag = 'p', className }: FindingTitleProps): JSX.Element {
  // React compares `dangerouslySetInnerHTML` by object identity, never by the
  // string inside it, and re-assigns `innerHTML` whenever the reference moves.
  // A literal built per render would rebuild the title on every unrelated
  // render of the six surfaces that place one, destroying whatever the reader
  // has selected inside it.
  const markup = useMemo(() => ({ __html: html }), [html]);

  return <Tag className={cn(TITLE_CODE, className)} dangerouslySetInnerHTML={markup} />;
}

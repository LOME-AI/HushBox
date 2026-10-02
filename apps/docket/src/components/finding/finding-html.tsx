import { useMemo } from 'react';
import { cn } from '@hushbox/ui';
import type { JSX } from 'react';

/**
 * Markdown is rendered on the server, where the repository is, so the client
 * only places the result. Raw html in a finding body is escaped by the renderer
 * rather than sanitized here.
 *
 * Typography is child-selector utilities rather than a typography plugin: only
 * this console renders audit prose, and the tokens are the same ones the
 * accessibility overrides redefine.
 *
 * This is what a reader is looking at for hours, so it is sized as the page's
 * reading surface. The measure is the column the card puts it in rather than a
 * cap of its own: a half of the viewport is already narrower than the width a
 * cap would hold it to.
 */
const PROSE = [
  'text-foreground text-base leading-relaxed',
  '[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-semibold',
  '[&_strong]:font-semibold [&_em]:italic',
  '[&_a]:underline [&_a]:underline-offset-2',
  '[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono',
  '[&_pre]:bg-muted [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:p-2',
  '[&_pre>code]:bg-transparent [&_pre>code]:p-0',
  // The peek layer keys off this attribute; the dotted rule is what tells the
  // reader a code span is a citation before they hover it.
  '[&_code[data-citation-path]]:decoration-dotted [&_code[data-citation-path]]:underline',
  // A citation is a whole path and is never shortened, so at a narrow width it
  // has to break somewhere. `break-words` keeps the separator breaks the browser
  // already prefers and only splits mid-segment when one segment cannot fit a
  // line by itself; `break-all` would chop short segments that had room.
  '[&_code[data-citation-path]]:break-words',
  // The other half of that rule. A citation the renderer would not serve is
  // struck through rather than underlined, so the two are told apart before
  // either is reached, and the sentence saying why follows it as prose: a tab
  // stop would promise a peek there is nothing to open.
  '[&_code[data-citation-dead]]:text-muted-foreground [&_code[data-citation-dead]]:line-through',
  '[&_code[data-citation-dead]]:decoration-dotted [&_code[data-citation-dead]]:break-words',
  '[&_[data-citation-note]]:text-muted-foreground [&_[data-citation-note]]:text-sm',
  '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto',
  '[&_th]:border-border [&_td]:border-border [&_th]:border [&_td]:border [&_th]:px-2 [&_td]:px-2',
  '[&_blockquote]:border-border [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3',
].join(' ');

export function FindingHtml({
  html,
  className,
}: Readonly<{
  html: string;
  /**
   * Typography for a surface that is not the reading column: a secondary line
   * placed here has to keep reading as secondary, and these utilities win over
   * the ones above.
   */
  className?: string;
}>): JSX.Element | null {
  // React compares `dangerouslySetInnerHTML` by object identity, never by the
  // string inside it, and re-assigns `innerHTML` whenever the reference moves.
  // A literal built per render would therefore rebuild the whole body on every
  // unrelated shell render, taking with it everything that lives in those
  // nodes: the reader's selection, and the citation a source peek is anchored
  // to, which the peek watches for disconnection.
  const markup = useMemo(() => ({ __html: html }), [html]);

  if (html === '') return null;
  return <div className={cn(PROSE, className)} dangerouslySetInnerHTML={markup} />;
}

import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { ScrollRegion } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { Code, Icon, Maximize2 } from '@hushbox/ui/icons';
import { splitTitle, useDocumentSelection } from '@/components/chat/media/document-card';
import { MermaidDiagram } from '@/components/chat/message/mermaid-diagram';
import type { Document } from '@/lib/chat/document-parser';

interface DiagramCardProps {
  document: Document;
}

const TOOL_CLASS = 'text-muted-foreground hover:text-foreground h-7 px-2 text-xs';

// The card's own width, not the viewport's, decides whether the head has room for the
// title, its language and line count, and the tools' words beside it. The 22rem threshold
// is in rem so it grows with the reader's text size as the head's text does; it is written
// whole in each class, since the stylesheet holds only classes spelled out in source.

/** A tool's word: the icon form's name when the head is narrow, drawn when it has room. */
const WORD_LABEL = 'sr-only @min-[22rem]:not-sr-only';

/** How far below the viewport a diagram starts drawing, so it is ready as it arrives. */
const DRAW_AHEAD_MARGIN = '200px';

/** Whether the element has come within drawing distance of the viewport; once true, it stays. */
function useSeen(element: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = React.useState(false);

  React.useEffect(() => {
    const target = element.current;
    if (seen || target === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setSeen(true);
        }
      },
      { rootMargin: DRAW_AHEAD_MARGIN }
    );
    observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  }, [element, seen]);

  return seen;
}

/**
 * A mermaid document drawn in the thread: a head naming it, with Source to read the chart
 * as written and Open to take it to the document panel. The drawing waits until the card
 * comes into view and its message has finished, since a half-written chart cannot draw.
 */
export function DiagramCard({ document }: Readonly<DiagramCardProps>): React.JSX.Element {
  const { isActive, open } = useDocumentSelection(document);
  const [showSource, setShowSource] = React.useState(false);
  const body = React.useRef<HTMLDivElement>(null);
  const seen = useSeen(body);
  const { firstWord, rest } = splitTitle(document.title);

  return (
    <figure
      data-testid={TEST_IDS.diagramCard}
      data-chrome=""
      className="not-prose border-border @container my-4 overflow-hidden rounded-lg border font-sans"
    >
      {/* The first word keeps its width; the rest of the title and the meta shrink from zero
          and truncate. The tools wrap below when even the first word cannot sit beside them. */}
      <figcaption className="border-border bg-muted text-muted-foreground flex min-h-9 flex-wrap items-center border-b py-1 ps-3.5 pe-1 text-xs">
        <span className="shrink-0">{firstWord}</span>
        <span className="min-w-0 grow basis-0 truncate">
          {rest === '' ? null : <span className="whitespace-pre"> {rest}</span>}
          <span className="hidden whitespace-pre @min-[22rem]:inline">
            {' '}
            · mermaid · {document.lineCount} lines
          </span>
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-2 ps-2">
          <Button
            variant="ghost"
            size="sm"
            className={TOOL_CLASS}
            data-testid={TEST_IDS.diagramSourceToggle}
            aria-pressed={showSource}
            onClick={() => {
              setShowSource((shown) => !shown);
            }}
          >
            <Icon icon={Code} />
            <span className={WORD_LABEL}>Source</span>
          </Button>
          {/* The panel's specs find a message's document opener by the card id, so the
              opener here carries it and its selection state as the document card does. */}
          <Button
            variant="ghost"
            size="sm"
            className={TOOL_CLASS}
            data-testid={TEST_IDS.documentCard}
            data-active={isActive}
            onClick={open}
          >
            <Icon icon={Maximize2} />
            <span className={WORD_LABEL}>Open</span>
          </Button>
        </span>
      </figcaption>
      {/* A drawing keeps its natural size, so a wide one scrolls sideways here. */}
      <ScrollRegion
        ref={body}
        label={document.title}
        tabStop="overflow"
        className="bg-background overflow-x-auto overscroll-x-contain p-4"
      >
        {showSource ? (
          <pre className="text-foreground m-0 bg-transparent p-0 text-[0.8125rem] leading-relaxed md:text-sm">
            <code>{document.content}</code>
          </pre>
        ) : (
          <MermaidDiagram
            chart={document.content}
            deferred={!seen || document.isStreaming}
            placement="thread"
            className="rounded-none bg-transparent p-0"
          />
        )}
      </ScrollRegion>
    </figure>
  );
}

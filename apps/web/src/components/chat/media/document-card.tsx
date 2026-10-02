import * as React from 'react';
import { FileCode, GitBranch, Globe, Atom, ArrowUpRight } from 'lucide-react';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useDocumentStore } from '@/stores/document';
import type { Document } from '@/lib/chat/document-parser';

interface DocumentCardProps {
  document: Document;
  className?: string;
}

function getDocumentIcon(type: Document['type']): React.JSX.Element {
  switch (type) {
    case 'code': {
      return <FileCode className="h-4 w-4" data-testid={TEST_IDS.codeIcon} aria-hidden="true" />;
    }
    case 'mermaid': {
      return (
        <GitBranch className="h-4 w-4" data-testid={TEST_IDS.diagramIcon} aria-hidden="true" />
      );
    }
    case 'html': {
      return <Globe className="h-4 w-4" data-testid={TEST_IDS.htmlIcon} aria-hidden="true" />;
    }
    case 'react': {
      return <Atom className="h-4 w-4" data-testid={TEST_IDS.reactIcon} aria-hidden="true" />;
    }
    case 'js':
    case 'python': {
      return <FileCode className="h-4 w-4" data-testid={TEST_IDS.codeIcon} aria-hidden="true" />;
    }
  }
}

function getTypeLabel(document: Document): string {
  if (document.language) {
    return document.language;
  }
  switch (document.type) {
    case 'mermaid': {
      return 'Mermaid';
    }
    case 'html': {
      return 'HTML';
    }
    case 'react': {
      return 'React';
    }
    default: {
      return 'Code';
    }
  }
}

/**
 * Whether a freshly mounted card is holding a newer state of the document the
 * panel already has open.
 *
 * A card can unmount while its document stays open — the message list
 * virtualizes — and come back after the content grew, by which point the
 * content-hash id names a state the panel never saw and matches nothing. What
 * still holds is how the text got there: a document only ever gains characters
 * as its message streams, so the open document's content is a strict prefix of
 * this card's. Growth must be strict — equal content hashes to the same id, so
 * that case is already an id match and is not this one. Two distinct blocks in
 * one message satisfying this are not a real shape, and the cost if they ever
 * did would be the panel re-anchoring visibly, not corrupting anything.
 */
function claimsRemountedSelection(
  previous: Document | null,
  document_: Document,
  active: Document | null
): boolean {
  if (previous !== null || active === null) return false;
  return (
    active.type === document_.type &&
    document_.content.length > active.content.length &&
    document_.content.startsWith(active.content)
  );
}

interface DocumentSelection {
  /** Whether the panel is showing this document. */
  isActive: boolean;
  /** Opens this document in the panel, as a new selection. */
  open: () => void;
}

/**
 * A card's hold on the document it opens: whether the panel is showing it, and how
 * to open it. Every card that opens a document in the panel reads it here, so a
 * card that remounts or streams keeps the panel on its latest parse.
 */
export function useDocumentSelection(document: Document): DocumentSelection {
  const { activeDocumentId, activeDocument, setActiveDocument, refreshActiveDocument } =
    useDocumentStore();

  // Streaming re-anchor: `generateDocumentId` hashes the source code, so the
  // id mutates each time a token arrives. If this card was the active one on
  // the previous render and its id has now shifted, re-claim the active slot
  // with the fresh Document. Without this, opening a still-streaming card
  // would freeze the panel on the title/content captured at click time —
  // e.g., showing "Mermaid Diagram" forever for a `graph TD` block whose
  // first line wasn't yet streamed when the user clicked.
  //
  // The streaming flag settles independently of the id: the last token of a
  // message can leave the code text untouched, so the hash is unchanged while
  // the panel must stop suppressing failed attempts and surface them.
  //
  // The ref starts empty rather than at the current document so that a remount
  // counts as "nothing published yet": the message list virtualizes, so a card
  // whose document is open in the panel can unmount and come back holding a
  // state the panel never saw.
  const previousRef = React.useRef<Document | null>(null);
  React.useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = document;
    if (previous?.id === document.id && previous.isStreaming === document.isStreaming) return;
    if (
      activeDocumentId === (previous?.id ?? document.id) ||
      claimsRemountedSelection(previous, document, activeDocument)
    ) {
      refreshActiveDocument(document);
    }
  }, [document, activeDocumentId, activeDocument, refreshActiveDocument]);

  return {
    isActive: activeDocumentId === document.id,
    open: () => {
      setActiveDocument(document);
    },
  };
}

interface TitleWords {
  firstWord: string;
  /** Everything after the first space, or empty for a one-word title. */
  rest: string;
}

/**
 * A card title's first word, which a narrow card keeps whole, and the rest, which it
 * elides. Every card that names a document splits its title here.
 */
export function splitTitle(title: string): TitleWords {
  const space = title.indexOf(' ');
  return space === -1
    ? { firstWord: title, rest: '' }
    : { firstWord: title.slice(0, space), rest: title.slice(space + 1) };
}

export function DocumentCard({
  document,
  className,
}: Readonly<DocumentCardProps>): React.JSX.Element {
  const { isActive, open } = useDocumentSelection(document);
  const stateLabel = isActive ? 'Showing' : 'Open';
  const { firstWord, rest } = splitTitle(document.title);

  return (
    <button
      type="button"
      data-testid={TEST_IDS.documentCard}
      data-active={isActive}
      data-chrome=""
      onClick={open}
      aria-label={`${stateLabel} ${document.title}`}
      className={cn(
        'not-prose @container my-4 flex min-h-14 w-full items-center gap-3 rounded-lg border py-2.5 ps-3.5 pe-3 text-left font-sans transition-colors',
        'border-border-control text-foreground hover:border-muted-foreground hover:bg-accent bg-transparent',
        isActive && 'border-foreground hover:border-foreground bg-accent',
        className
      )}
    >
      <span
        className={cn(
          'grid size-8 flex-none place-items-center rounded-md',
          isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        )}
      >
        {getDocumentIcon(document.type)}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The first word keeps its width unless it alone is wider than the column. */}
        <span className="flex min-w-0 text-sm font-semibold">
          <span className="max-w-full shrink-0 truncate">{firstWord}</span>
          {rest === '' ? null : <span className="min-w-0 truncate whitespace-pre"> {rest}</span>}
        </span>
        <span className="text-muted-foreground overflow-hidden font-mono text-xs break-normal wrap-normal text-ellipsis tabular-nums">
          {getTypeLabel(document)} · {document.lineCount} lines
        </span>
      </span>

      <span className="text-muted-foreground inline-flex flex-none items-center gap-1.5 text-[0.8125rem] whitespace-nowrap">
        {/* The card's width, not the viewport's, decides whether the word fits beside the
            title; it is in rem so it grows with the reader's text size. The name carries
            the word either way. */}
        <span className="hidden whitespace-nowrap @min-[12rem]:inline">{stateLabel}</span>
        <ArrowUpRight className="size-3.5" data-testid={TEST_IDS.openIcon} aria-hidden="true" />
      </span>
    </button>
  );
}

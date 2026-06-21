import * as React from 'react';
import { FileCode, GitBranch, Globe, Atom, ArrowUpRight } from 'lucide-react';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useDocumentStore } from '@/stores/document';
import type { Document } from '@/lib/document-parser';

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

export function DocumentCard({
  document,
  className,
}: Readonly<DocumentCardProps>): React.JSX.Element {
  const { activeDocumentId, setActiveDocument } = useDocumentStore();
  const isActive = activeDocumentId === document.id;

  // Streaming re-anchor: `generateDocumentId` hashes the source code, so the
  // id mutates each time a token arrives. If this card was the active one on
  // the previous render and its id has now shifted, re-claim the active slot
  // with the fresh Document. Without this, opening a still-streaming card
  // would freeze the panel on the title/content captured at click time —
  // e.g., showing "Mermaid Diagram" forever for a `graph TD` block whose
  // first line wasn't yet streamed when the user clicked.
  const previousIdRef = React.useRef<string>(document.id);
  React.useEffect(() => {
    const previousId = previousIdRef.current;
    previousIdRef.current = document.id;
    if (previousId === document.id) return;
    if (activeDocumentId === previousId) {
      setActiveDocument(document);
    }
  }, [document, activeDocumentId, setActiveDocument]);

  const handleClick = (): void => {
    setActiveDocument(document);
  };

  return (
    <button
      type="button"
      data-testid={TEST_IDS.documentCard}
      data-active={isActive}
      onClick={handleClick}
      aria-label={`Open ${document.title}`}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
        'bg-muted/50 hover:bg-muted border-border',
        isActive && 'border-primary bg-primary/5',
        className
      )}
    >
      <div className="text-muted-foreground flex-shrink-0">{getDocumentIcon(document.type)}</div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{document.title}</div>
        <div className="text-muted-foreground text-xs">
          {getTypeLabel(document)} &bull; {document.lineCount} lines
        </div>
      </div>

      <ArrowUpRight
        className="text-muted-foreground group-hover:text-foreground h-4 w-4 flex-shrink-0 transition-colors"
        data-testid={TEST_IDS.openIcon}
        aria-hidden="true"
      />
    </button>
  );
}

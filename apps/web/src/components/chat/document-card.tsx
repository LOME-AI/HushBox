import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { FileCode, GitBranch, Globe, Atom, ArrowUpRight } from 'lucide-react';
import { useDocumentStore } from '../../stores/document';
import type { Document } from '../../lib/document-parser';

interface DocumentCardProps {
  document: Document;
  className?: string;
}

function getDocumentIcon(type: Document['type']): React.JSX.Element {
  switch (type) {
    case 'code': {
      return <FileCode className="h-4 w-4" data-testid="code-icon" aria-hidden="true" />;
    }
    case 'mermaid': {
      return <GitBranch className="h-4 w-4" data-testid="diagram-icon" aria-hidden="true" />;
    }
    case 'html': {
      return <Globe className="h-4 w-4" data-testid="html-icon" aria-hidden="true" />;
    }
    case 'react': {
      return <Atom className="h-4 w-4" data-testid="react-icon" aria-hidden="true" />;
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

  const handleClick = (): void => {
    setActiveDocument(document.id);
  };

  return (
    <button
      type="button"
      data-testid="document-card"
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
      {/* Document type icon */}
      <div className="text-muted-foreground flex-shrink-0">{getDocumentIcon(document.type)}</div>

      {/* Document info */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{document.title}</div>
        <div className="text-muted-foreground text-xs">
          {getTypeLabel(document)} &bull; {document.lineCount} lines
        </div>
      </div>

      {/* Open arrow */}
      <ArrowUpRight
        className="text-muted-foreground group-hover:text-foreground h-4 w-4 flex-shrink-0 transition-colors"
        data-testid="open-icon"
        aria-hidden="true"
      />
    </button>
  );
}

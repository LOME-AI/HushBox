import * as React from 'react';
import { Button, cn } from '@lome-chat/ui';
import { X, Code, Eye, Copy, Check } from 'lucide-react';
import { useDocumentStore } from '../../stores/document';
import { CodeBlock } from '../chat/code-block';
import { MermaidDiagram } from '../chat/mermaid-diagram';
import { useIsMobile } from '../../hooks/use-is-mobile';
import type { Document } from '../../lib/document-parser';

interface DocumentPanelProps {
  documents: Document[];
  className?: string;
}

interface ResizeHandleProps {
  isResizing: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
}

function ResizeHandle({
  isResizing,
  onResizeStart,
}: Readonly<ResizeHandleProps>): React.JSX.Element {
  return (
    <div
      data-testid="resize-handle"
      onMouseDown={onResizeStart}
      className={cn(
        'group absolute top-0 left-0 z-10 flex h-full w-2 cursor-ew-resize items-center justify-center',
        'hover:bg-primary/10 transition-colors',
        isResizing && 'bg-primary/20'
      )}
    >
      <div
        data-testid="resize-indicator"
        className={cn(
          'bg-border group-hover:bg-primary/50 h-8 w-0.5 rounded-full transition-colors',
          isResizing && 'bg-primary/50'
        )}
      />
    </div>
  );
}

interface PanelHeaderProps {
  title: string;
  copied: boolean;
  showRaw: boolean;
  supportsRawToggle: boolean;
  onCopy: () => void;
  onToggleRaw: () => void;
  onClose: () => void;
}

function PanelHeader({
  title,
  copied,
  showRaw,
  supportsRawToggle,
  onCopy,
  onToggleRaw,
  onClose,
}: Readonly<PanelHeaderProps>): React.JSX.Element {
  return (
    <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
      <h2 className="text-primary min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
        {supportsRawToggle && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggleRaw}
            aria-label={showRaw ? 'Show rendered' : 'Show raw'}
          >
            {showRaw ? (
              <Eye className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Code className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

interface DocumentContentProps {
  document: Document;
  showRaw: boolean;
}

/** Renders the document content based on type */
function DocumentContent({ document, showRaw }: Readonly<DocumentContentProps>): React.JSX.Element {
  // For mermaid, show raw or rendered based on toggle
  if (document.type === 'mermaid') {
    if (showRaw) {
      return (
        <CodeBlock language="mermaid" variant="transparent" hideHeader>
          {document.content}
        </CodeBlock>
      );
    }
    return <MermaidDiagram chart={document.content} />;
  }

  // For code types, always show as code block with hidden header
  return (
    <CodeBlock language={document.language} variant="transparent" hideHeader>
      {document.content}
    </CodeBlock>
  );
}

export function DocumentPanel({
  documents,
  className,
}: Readonly<DocumentPanelProps>): React.JSX.Element | null {
  const { isPanelOpen, panelWidth, activeDocumentId, closePanel, setPanelWidth } =
    useDocumentStore();
  const [isResizing, setIsResizing] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const activeDocument = documents.find((document_) => document_.id === activeDocumentId);

  // Reset showRaw when active document changes
  React.useEffect(() => {
    setShowRaw(false);
  }, [activeDocumentId]);

  // Handle resize drag (desktop only)
  React.useEffect(() => {
    if (!isResizing || isMobile) return;

    const handleMouseMove = (e: MouseEvent): void => {
      if (!panelRef.current) return;
      const panelRect = panelRef.current.getBoundingClientRect();
      const newWidth = panelRect.right - e.clientX;
      setPanelWidth(newWidth);
    };

    const handleMouseUp = (): void => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isMobile, setPanelWidth]);

  // Don't render if panel is closed or no active document
  if (!isPanelOpen || !activeDocument) {
    return null;
  }

  const handleResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    setIsResizing(true);
  };

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(activeDocument.content);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  // Check if document type supports raw toggle
  const supportsRawToggle = activeDocument.type === 'mermaid';

  return (
    <div
      ref={panelRef}
      data-testid="document-panel"
      className={cn(
        'bg-background border-border relative flex h-full flex-col border-l',
        isResizing && 'select-none',
        className
      )}
      style={{ width: isMobile ? '100%' : `${String(panelWidth)}px` }}
    >
      {!isMobile && <ResizeHandle isResizing={isResizing} onResizeStart={handleResizeStart} />}

      <PanelHeader
        title={activeDocument.title}
        copied={copied}
        showRaw={showRaw}
        supportsRawToggle={supportsRawToggle}
        onCopy={() => void handleCopy()}
        onToggleRaw={() => {
          setShowRaw(!showRaw);
        }}
        onClose={closePanel}
      />

      <div data-testid="document-panel-scroll" className="flex-1 overflow-auto">
        <div className="p-4">
          <DocumentContent document={activeDocument} showRaw={showRaw} />
        </div>
      </div>
    </div>
  );
}

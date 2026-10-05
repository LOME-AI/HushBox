import * as React from 'react';
import { createPortal } from 'react-dom';
import { TEST_IDS } from '@hushbox/shared';
import { cn, useCopyToClipboard } from '@hushbox/ui';
import { IconButton } from '@hushbox/ui/button';
import { Check, Copy, Download, Maximize2, Minimize2, X } from '@hushbox/ui/icons';
import { getTypeLabel } from '@/components/chat/media/document-card';
import { MermaidDiagram } from '@/components/chat/message/mermaid-diagram';
import { PageShellContext } from '@/components/shared/page-shell';
import { downloadTextFile } from '@/lib/download-text-file';
import { useDocumentStore } from '../../stores/document';
import {
  DocumentBar,
  DocumentSandbox,
  DocumentScroll,
  type DocumentView,
} from './document-sandbox';
import { HighlightedSource } from './highlighted-source';
import { DocumentRenderStatus, PENDING_PREVIEW_TEXT } from './document-render-status';
import { getFileExtension, isRunnableDocument } from '../../lib/chat/document-parser';
import type { Document } from '../../lib/chat/document-parser';

interface DocumentPanelProps {
  className?: string;
}

interface PanelHeaderProps {
  document: Document;
  copied: boolean;
  isFullscreen: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

/** "python · 58 lines": what the document is written in, and how long it is. */
function documentSubtitle(document: Document): string {
  return `${getTypeLabel(document)} · ${String(document.lineCount)} lines`;
}

// Fullscreen acts only on a docked panel: below the dock line, and on a phone, the panel
// already lies over everything it could cover.
const DOCKED_ONLY_CLASS = 'max-md:hidden @max-panehost-dock/panehost:hidden';

function PanelHeader({
  document,
  copied,
  isFullscreen,
  onCopy,
  onDownload,
  onToggleFullscreen,
  onClose,
}: Readonly<PanelHeaderProps>): React.JSX.Element {
  return (
    <div className="border-border flex min-h-(--app-header-height) shrink-0 items-center gap-1 border-b py-1 ps-4 pe-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="text-foreground truncate font-sans text-sm font-semibold">
          {document.title}
        </h2>
        <p className="text-muted-foreground truncate font-mono text-xs">
          {documentSubtitle(document)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          type="button"
          icon={copied ? Check : Copy}
          hitArea="extend"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        />
        <IconButton
          type="button"
          icon={Download}
          hitArea="extend"
          onClick={onDownload}
          aria-label="Download file"
        />
        <IconButton
          type="button"
          icon={isFullscreen ? Minimize2 : Maximize2}
          hitArea="extend"
          className={DOCKED_ONLY_CLASS}
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        />
        <IconButton
          type="button"
          icon={X}
          hitArea="extend"
          onClick={onClose}
          aria-label="Close panel"
        />
      </div>
    </div>
  );
}

/** The source, plus the line explaining why no preview is on screen yet. */
function PendingSourceView({ document }: Readonly<{ document: Document }>): React.JSX.Element {
  return (
    <div>
      <HighlightedSource content={document.content} language={document.language} />
      {/* Repeats the status text visibly; the status element announces it. */}
      <p className="text-muted-foreground px-4 pb-4 text-sm" aria-hidden="true">
        {PENDING_PREVIEW_TEXT}
      </p>
    </div>
  );
}

interface DocumentBodyProps {
  document: Document;
  view: DocumentView;
  onViewChange: (view: DocumentView) => void;
}

function MermaidBody({
  document,
  view,
  onViewChange,
}: Readonly<DocumentBodyProps>): React.JSX.Element {
  const content = (): React.JSX.Element => {
    if (view === 'code') {
      return <HighlightedSource content={document.content} language="mermaid" />;
    }
    // Mermaid draws in-app and reports nothing back, so a half-written diagram
    // offers no failed attempt to observe — unlike the sandbox kinds, whose
    // frame says whether the code actually ran. It therefore waits for the
    // message to settle rather than showing a syntax complaint per token.
    if (document.isStreaming) {
      return (
        <>
          <PendingSourceView document={document} />
          <DocumentRenderStatus status="streaming" text={PENDING_PREVIEW_TEXT} />
        </>
      );
    }
    return <MermaidDiagram chart={document.content} />;
  };
  return (
    <>
      <DocumentBar view={view} onViewChange={onViewChange} />
      <DocumentScroll>{content()}</DocumentScroll>
    </>
  );
}

function DocumentBody({
  document,
  view,
  onViewChange,
}: Readonly<DocumentBodyProps>): React.JSX.Element {
  if (document.type === 'mermaid') {
    return <MermaidBody document={document} view={view} onViewChange={onViewChange} />;
  }
  // html/js/react/python execute in the sandbox iframe, which owns the bar
  // because its status and its Run sit there.
  if (isRunnableDocument(document.type)) {
    return (
      <DocumentSandbox
        kind={document.type}
        code={document.content}
        title={document.title}
        isStreaming={document.isStreaming}
        pendingView={<PendingSourceView document={document} />}
        view={view}
        onViewChange={onViewChange}
        codeView={<HighlightedSource content={document.content} language={document.language} />}
      />
    );
  }
  return (
    <DocumentScroll>
      <HighlightedSource content={document.content} language={document.language} />
    </DocumentScroll>
  );
}

// A phone gets the whole screen. From 768 the panel lies over the thread at the main column's
// full width, or docks beside it at 45% of the column wherever that leaves the panel a phone's
// width and the thread a readable one. The column decides, in rem so it follows the reader's text
// size, never the window. Fullscreen keeps the panel over the thread.
const OVER_THREAD_CLASS =
  'absolute inset-0 z-drawer max-md:fixed max-md:pt-[env(safe-area-inset-top,0px)]';
const DOCKED_CLASS =
  'md:@panehost-dock/panehost:relative md:@panehost-dock/panehost:inset-auto md:@panehost-dock/panehost:z-auto md:@panehost-dock/panehost:w-[45cqi] md:@panehost-dock/panehost:shrink-0 md:@panehost-dock/panehost:border-l';

/**
 * The open document. It docks inside the page shell's pane host, the `panehost` container the
 * docking rule above measures.
 */
export function DocumentPanel({
  className,
}: Readonly<DocumentPanelProps>): React.JSX.Element | null {
  const {
    isPanelOpen,
    activeDocument,
    activeSelectionId,
    isFullscreen,
    closePanel,
    toggleFullscreen,
  } = useDocumentStore();
  const [view, setView] = React.useState<DocumentView>('output');
  const { copy, copied } = useCopyToClipboard();
  const shell = React.useContext(PageShellContext);

  // Keyed on the selection, not the document id: the id is a content hash that
  // mutates while a message streams, and re-anchoring must not discard the
  // view the user picked.
  React.useEffect(() => {
    setView('output');
  }, [activeSelectionId]);

  if (!isPanelOpen || !activeDocument) {
    return null;
  }

  const handleCopy = async (): Promise<void> => {
    await copy(activeDocument.content);
  };

  const handleDownload = (): void => {
    const extension = activeDocument.language ? getFileExtension(activeDocument.language) : 'txt';
    downloadTextFile(`${activeDocument.title}.${extension}`, activeDocument.content);
  };

  const panel = (
    <aside
      // Literal HTML `id` (a distinct mechanism from `data-testid`) so the mobile
      // Maestro flow can select this singleton panel container — Maestro's `id:`
      // selector matches an `id` attribute, not `data-testid`.
      id="document-panel"
      aria-label="Document"
      data-testid={TEST_IDS.documentPanel}
      data-chrome=""
      className={cn(
        'bg-background border-border @container/docpane flex h-full flex-col',
        OVER_THREAD_CLASS,
        !isFullscreen && DOCKED_CLASS,
        className
      )}
    >
      <PanelHeader
        document={activeDocument}
        copied={copied}
        isFullscreen={isFullscreen}
        onCopy={() => void handleCopy()}
        onDownload={handleDownload}
        onToggleFullscreen={toggleFullscreen}
        onClose={closePanel}
      />
      {/* Keyed by the selection, not the document id: opening another
          document remounts the content, tearing the sandbox iframe down and
          killing anything running in it, while a streaming document — whose
          content-hash id changes every token — keeps the frame it is
          already driving. */}
      <DocumentBody
        key={activeSelectionId}
        document={activeDocument}
        view={view}
        onViewChange={setView}
      />
    </aside>
  );

  // Inside the page shell the panel stands in its pane slot, so it docks beside, or lies over,
  // the header row as well as the thread; elsewhere it renders where it is.
  if (shell === null) return panel;
  return shell.slots.pane === null ? null : createPortal(panel, shell.slots.pane);
}

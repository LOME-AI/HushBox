import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import { DocumentCard } from '@/components/chat/media/document-card';
import { useDocumentStore } from '@/stores/document';
import type { Document } from '@/lib/chat/document-parser';

describe('DocumentCard', () => {
  const createDocument = (overrides: Partial<Document> = {}): Document => ({
    id: 'doc-123',
    type: 'code',
    language: 'typescript',
    title: 'MyComponent',
    content: 'const x = 1;',
    lineCount: 20,
    isStreaming: false,
    ...overrides,
  });

  const createDocumentWithoutLanguage = (type: Document['type']): Document => ({
    id: 'doc-123',
    type,
    title: 'MyComponent',
    content: 'const x = 1;',
    lineCount: 20,
    isStreaming: false,
  });

  beforeEach(() => {
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
      activeDocument: null,
    });
  });

  describe('rendering', () => {
    it('renders document title', () => {
      render(<DocumentCard document={createDocument({ title: 'UserService' })} />);

      expect(screen.getByText('UserService')).toBeInTheDocument();
    });

    it('renders language and line count for code documents', () => {
      render(<DocumentCard document={createDocument({ language: 'python', lineCount: 42 })} />);

      expect(screen.getByText(/python/i)).toBeInTheDocument();
      expect(screen.getByText(/42 lines/i)).toBeInTheDocument();
    });

    it('renders type label for mermaid documents', () => {
      render(
        <DocumentCard
          document={createDocument({
            type: 'mermaid',
            language: 'mermaid',
            title: 'Flowchart Diagram',
          })}
        />
      );

      expect(screen.getByText(/mermaid/i)).toBeInTheDocument();
    });

    it('renders type label for html documents', () => {
      render(<DocumentCard document={createDocument({ type: 'html', language: 'html' })} />);

      expect(screen.getByText(/html/i)).toBeInTheDocument();
    });

    it('renders type label for react documents', () => {
      render(<DocumentCard document={createDocument({ type: 'react', language: 'tsx' })} />);

      expect(screen.getByText(/tsx/i)).toBeInTheDocument();
    });

    it('renders Mermaid label when language is undefined for mermaid type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('mermaid')} />);

      expect(screen.getByText(/mermaid/i)).toBeInTheDocument();
    });

    it('renders HTML label when language is undefined for html type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('html')} />);

      expect(screen.getByText(/html/i)).toBeInTheDocument();
    });

    it('renders React label when language is undefined for react type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('react')} />);

      expect(screen.getByText(/react/i)).toBeInTheDocument();
    });

    it('renders Code label when language is undefined for code type', () => {
      render(<DocumentCard document={createDocumentWithoutLanguage('code')} />);

      expect(screen.getByText(/code/i)).toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('reads its language and line count as one line', () => {
      render(<DocumentCard document={createDocument({ language: 'rust', lineCount: 64 })} />);

      expect(screen.getByText('rust · 64 lines')).toBeInTheDocument();
    });

    it('offers Open while its document is not showing', () => {
      render(<DocumentCard document={createDocument()} />);

      expect(screen.getByText('Open')).toBeInTheDocument();
      expect(screen.queryByText('Showing')).not.toBeInTheDocument();
    });

    it('reads Showing while its document is open in the panel', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-open', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-open' })} />);

      expect(screen.getByText('Showing')).toBeInTheDocument();
      expect(screen.queryByText('Open')).not.toBeInTheDocument();
    });

    it('fills its icon tile with the brand red while its document is open', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-open', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-open' })} />);

      const tile = screen.getByTestId('code-icon').parentElement;
      expect(tile).toHaveClass('bg-primary', 'text-primary-foreground');
    });

    it('keeps its icon tile neutral while its document is not showing', () => {
      render(<DocumentCard document={createDocument()} />);

      const tile = screen.getByTestId('code-icon').parentElement;
      expect(tile).not.toHaveClass('bg-primary');
    });
  });

  describe('accessible name', () => {
    it('names the card Open with its title while its document is not showing', () => {
      render(<DocumentCard document={createDocument({ title: 'Rust' })} />);

      expect(screen.getByRole('button')).toHaveAccessibleName('Open Rust');
    });

    it('names the card Showing with its title while its document is open', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-open', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-open', title: 'Rust' })} />);

      expect(screen.getByRole('button')).toHaveAccessibleName('Showing Rust');
    });

    it('takes no pressed state, since opening it again does not close it', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-open', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-open' })} />);

      expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed');
    });
  });

  describe('narrow card', () => {
    it('measures its own width to decide whether its end label has room for a word', () => {
      render(<DocumentCard document={createDocument()} />);

      expect(screen.getByRole('button')).toHaveClass('@container');
    });

    it('shows only the arrow of its end label until the card has room for the word', () => {
      render(<DocumentCard document={createDocument()} />);

      const word = screen.getByText('Open');
      expect(word.className).toMatch(/(^| )hidden( |$)/);
      expect(word.className).toMatch(/@min-\[[\d.]+rem\]:inline/);
      expect(screen.getByTestId('open-icon')).not.toHaveClass('hidden');
    });

    it('keeps naming its state and title while the word is hidden', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-open', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-open', title: 'Rust' })} />);

      expect(screen.getByText('Showing').className).toMatch(/(^| )hidden( |$)/);
      expect(screen.getByRole('button')).toHaveAccessibleName('Showing Rust');
    });

    it('keeps the first word of its title whole and elides the rest', () => {
      render(<DocumentCard document={createDocument({ title: 'Ledger balance report' })} />);

      expect(screen.getByText('Ledger')).toHaveClass('shrink-0');
      expect(screen.getByText('balance report')).toHaveClass('min-w-0', 'truncate');
    });

    it('shows a one-word title in one piece', () => {
      render(<DocumentCard document={createDocument({ title: 'Rust' })} />);

      expect(screen.getByText('Rust')).toHaveClass('shrink-0');
    });
  });

  describe('wrapping', () => {
    it('breaks its language line only between words, eliding what does not fit', () => {
      render(<DocumentCard document={createDocument({ language: 'rust', lineCount: 27 })} />);

      expect(screen.getByText('rust · 27 lines')).toHaveClass(
        'wrap-normal',
        'break-normal',
        'overflow-hidden',
        'text-ellipsis'
      );
    });

    it('keeps its Open label on one line', () => {
      render(<DocumentCard document={createDocument()} />);

      expect(screen.getByText('Open')).toHaveClass('whitespace-nowrap');
    });
  });

  describe('icons', () => {
    it('renders code icon for code documents', () => {
      render(<DocumentCard document={createDocument({ type: 'code' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="code-icon"]')).toBeInTheDocument();
    });

    it('renders diagram icon for mermaid documents', () => {
      render(<DocumentCard document={createDocument({ type: 'mermaid' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="diagram-icon"]')).toBeInTheDocument();
    });

    it('renders html icon for html documents', () => {
      render(<DocumentCard document={createDocument({ type: 'html' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="html-icon"]')).toBeInTheDocument();
    });

    it('renders react icon for react documents', () => {
      render(<DocumentCard document={createDocument({ type: 'react' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="react-icon"]')).toBeInTheDocument();
    });

    it('renders code icon for js documents', () => {
      render(<DocumentCard document={createDocument({ type: 'js', language: 'javascript' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="code-icon"]')).toBeInTheDocument();
    });

    it('renders code icon for python documents', () => {
      render(<DocumentCard document={createDocument({ type: 'python', language: 'python' })} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="code-icon"]')).toBeInTheDocument();
    });

    it('renders open arrow icon', () => {
      render(<DocumentCard document={createDocument()} />);

      const card = screen.getByTestId('document-card');
      expect(card.querySelector('[data-testid="open-icon"]')).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('sets active document when clicked', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({ id: 'doc-clicked' });
      render(<DocumentCard document={document_} />);

      await user.click(screen.getByTestId('document-card'));

      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-clicked');
      expect(useDocumentStore.getState().activeDocument).toBe(document_);
    });

    it('opens panel when clicked', async () => {
      const user = userEvent.setup();
      render(<DocumentCard document={createDocument()} />);

      await user.click(screen.getByTestId('document-card'));

      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });
  });

  describe('active state', () => {
    it('shows active indicator when document is active', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-active', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-active' })} />);

      const card = screen.getByTestId('document-card');
      expect(card).toHaveAttribute('data-active', 'true');
    });

    it('does not show active indicator when document is not active', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-other', isPanelOpen: true });
      render(<DocumentCard document={createDocument({ id: 'doc-123' })} />);

      const card = screen.getByTestId('document-card');
      expect(card).toHaveAttribute('data-active', 'false');
    });
  });

  describe('accessibility', () => {
    it('has button role for clickability', () => {
      render(<DocumentCard document={createDocument()} />);

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('has accessible name from title', () => {
      render(<DocumentCard document={createDocument({ title: 'DataProcessor' })} />);

      expect(screen.getByRole('button', { name: /dataprocessor/i })).toBeInTheDocument();
    });
  });

  describe('streaming re-anchor', () => {
    // `generateDocumentId` hashes source content, so a card opened during
    // streaming carries an id derived from partial content. When more tokens
    // arrive the id mutates — without the re-anchor effect the panel would
    // freeze on the partial title captured at click time.
    it('re-anchors active document when id mutates after click', async () => {
      const user = userEvent.setup();
      const partial = createDocument({
        id: 'doc-partial',
        title: 'Mermaid Diagram',
        content: 'g',
      });
      const complete = createDocument({
        id: 'doc-complete',
        title: 'Graph Diagram',
        content: 'graph TD',
      });

      const { rerender } = render(<DocumentCard document={partial} />);

      await user.click(screen.getByTestId('document-card'));
      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-partial');
      expect(useDocumentStore.getState().activeDocument?.title).toBe('Mermaid Diagram');

      rerender(<DocumentCard document={complete} />);

      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-complete');
      expect(useDocumentStore.getState().activeDocument?.title).toBe('Graph Diagram');
    });

    it('keeps the user selection when re-anchoring', async () => {
      const user = userEvent.setup();
      const partial = createDocument({ id: 'doc-partial' });
      const complete = createDocument({ id: 'doc-complete' });

      const { rerender } = render(<DocumentCard document={partial} />);
      await user.click(screen.getByTestId('document-card'));
      const selectionId = useDocumentStore.getState().activeSelectionId;

      rerender(<DocumentCard document={complete} />);

      expect(useDocumentStore.getState().activeSelectionId).toBe(selectionId);
    });

    it('re-anchors when the message settles without changing the id', async () => {
      const user = userEvent.setup();
      const streaming = createDocument({ id: 'doc-same', isStreaming: true });
      const settled = createDocument({ id: 'doc-same' });

      const { rerender } = render(<DocumentCard document={streaming} />);
      await user.click(screen.getByTestId('document-card'));
      expect(useDocumentStore.getState().activeDocument?.isStreaming).toBe(true);

      rerender(<DocumentCard document={settled} />);

      expect(useDocumentStore.getState().activeDocument?.isStreaming).toBe(false);
    });

    it('re-publishes the settled streaming state after the card remounts', async () => {
      // The message list virtualizes, so a card can unmount while its document
      // stays open in the panel. On remount it must publish what it now knows.
      const user = userEvent.setup();
      const streaming = createDocument({ id: 'doc-same', isStreaming: true });
      const settled = createDocument({ id: 'doc-same' });

      const { unmount } = render(<DocumentCard document={streaming} />);
      await user.click(screen.getByTestId('document-card'));
      unmount();

      render(<DocumentCard document={settled} />);

      expect(useDocumentStore.getState().activeDocument?.isStreaming).toBe(false);
    });

    it('re-claims the panel after remounting with content that grew while it was gone', async () => {
      // Virtualization can unmount a card whose document is open. By the time it
      // comes back the content hash names a state the panel never saw, so an id
      // comparison matches nothing and the panel would sit on the stale copy.
      const user = userEvent.setup();
      const streaming = createDocument({
        id: 'doc-early',
        content: 'const x = 1;',
        isStreaming: true,
      });

      const { unmount } = render(<DocumentCard document={streaming} />);
      await user.click(screen.getByTestId('document-card'));
      unmount();

      const grown = createDocument({ id: 'doc-later', content: 'const x = 1;\nconst y = 2;' });
      render(<DocumentCard document={grown} />);

      expect(useDocumentStore.getState().activeDocument?.content).toBe(grown.content);
      expect(useDocumentStore.getState().activeDocument?.isStreaming).toBe(false);
    });

    it('does not let an unrelated document claim the panel on mount', async () => {
      const user = userEvent.setup();
      const open_ = createDocument({ id: 'doc-open', content: 'const x = 1;' });

      const { unmount } = render(<DocumentCard document={open_} />);
      await user.click(screen.getByTestId('document-card'));
      unmount();

      render(
        <DocumentCard document={createDocument({ id: 'doc-other', content: 'let z = 3;' })} />
      );

      expect(useDocumentStore.getState().activeDocument?.id).toBe('doc-open');
    });

    it('does not claim active when a different document is active', () => {
      const otherDocument = createDocument({ id: 'doc-other', title: 'Other' });
      useDocumentStore.setState({
        activeDocumentId: 'doc-other',
        activeDocument: otherDocument,
        isPanelOpen: true,
      });

      const partial = createDocument({ id: 'doc-a-partial', title: 'A1' });
      const evolved = createDocument({ id: 'doc-a-complete', title: 'A2' });

      const { rerender } = render(<DocumentCard document={partial} />);
      rerender(<DocumentCard document={evolved} />);

      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-other');
      expect(useDocumentStore.getState().activeDocument?.title).toBe('Other');
    });

    it('does not touch the store on the initial render', () => {
      const document_ = createDocument({ id: 'doc-initial', title: 'Initial' });
      render(<DocumentCard document={document_} />);

      expect(useDocumentStore.getState().activeDocumentId).toBeNull();
      expect(useDocumentStore.getState().activeDocument).toBeNull();
    });
  });
});

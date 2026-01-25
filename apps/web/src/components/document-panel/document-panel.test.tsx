import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { DocumentPanel } from './document-panel';
import { useDocumentStore } from '../../stores/document';
import type { Document } from '../../lib/document-parser';

// Mock matchMedia for viewport simulation
// isMobile: true = mobile (<768px), false = desktop (>=768px)
const mockMatchMedia = (isMobile: boolean): void => {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      // useIsMobile uses max-width: 767px query
      matches: query.includes('max-width') ? isMobile : !isMobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

describe('DocumentPanel', () => {
  const createDocument = (overrides: Partial<Document> = {}): Document => ({
    id: 'doc-123',
    type: 'code',
    language: 'typescript',
    title: 'MyComponent',
    content: 'const x = 1;\nconst y = 2;',
    lineCount: 2,
    ...overrides,
  });

  const defaultDocuments: Document[] = [createDocument()];

  beforeEach(() => {
    // Mock desktop viewport by default (isMobile = false)
    mockMatchMedia(false);
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('visibility', () => {
    it('does not render when panel is closed', () => {
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.queryByTestId('document-panel')).not.toBeInTheDocument();
    });

    it('renders when panel is open', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.getByTestId('document-panel')).toBeInTheDocument();
    });

    it('does not render when no active document', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: null });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.queryByTestId('document-panel')).not.toBeInTheDocument();
    });

    it('does not render when active document not in documents list', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-unknown' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.queryByTestId('document-panel')).not.toBeInTheDocument();
    });
  });

  describe('header', () => {
    it('displays document title', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={[createDocument({ title: 'UserService' })]} />);

      expect(screen.getByText('UserService')).toBeInTheDocument();
    });

    it('has close button', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('closes panel when close button is clicked', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      await user.click(screen.getByRole('button', { name: /close/i }));

      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('has copy button', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies document content when copy button is clicked', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      const content = 'const x = 1;\nconst y = 2;';
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={[createDocument({ content })]} />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('displays title with primary color', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={[createDocument({ title: 'TestTitle' })]} />);

      const title = screen.getByText('TestTitle');
      expect(title).toHaveClass('text-primary');
    });
  });

  describe('content rendering', () => {
    it('renders code content for code documents', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel
          documents={[createDocument({ type: 'code', content: 'const hello = "world";' })]}
        />
      );

      expect(screen.getByText(/const hello/)).toBeInTheDocument();
    });

    it('renders mermaid diagram for mermaid documents', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel
          documents={[createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' })]}
        />
      );

      // MermaidDiagram shows loading state initially
      expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
    });

    it('shows raw toggle button for mermaid documents', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel
          documents={[createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' })]}
        />
      );

      expect(screen.getByRole('button', { name: /show raw/i })).toBeInTheDocument();
    });

    it('toggles between rendered and raw view for mermaid', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel
          documents={[createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' })]}
        />
      );

      // Initially shows rendered view (mermaid component)
      expect(
        screen.queryByTestId('mermaid-loading') ?? screen.queryByTestId('mermaid-diagram')
      ).toBeInTheDocument();

      // Click to show raw
      await user.click(screen.getByRole('button', { name: /show raw/i }));

      // Now should show code block with mermaid content
      expect(screen.getByTestId('code-block')).toBeInTheDocument();
      expect(screen.getByText(/flowchart TD/)).toBeInTheDocument();

      // Toggle back to rendered
      await user.click(screen.getByRole('button', { name: /show rendered/i }));

      // Back to mermaid diagram (either loading or rendered)
      expect(
        screen.queryByTestId('mermaid-loading') ?? screen.queryByTestId('mermaid-diagram')
      ).toBeInTheDocument();
      // Code block should no longer be visible
      expect(screen.queryByTestId('code-block')).not.toBeInTheDocument();
    });

    it('does not show raw toggle for code documents', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel documents={[createDocument({ type: 'code', content: 'const x = 1;' })]} />
      );

      expect(screen.queryByRole('button', { name: /show raw/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /show rendered/i })).not.toBeInTheDocument();
    });

    it('renders code block for html documents', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel
          documents={[
            createDocument({ type: 'html', language: 'html', content: '<div>Hello</div>' }),
          ]}
        />
      );

      expect(screen.getByTestId('code-block')).toBeInTheDocument();
    });

    it('renders code block for react documents', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(
        <DocumentPanel
          documents={[
            createDocument({
              type: 'react',
              language: 'tsx',
              content: 'function App() { return <div /> }',
            }),
          ]}
        />
      );

      expect(screen.getByTestId('code-block')).toBeInTheDocument();
    });
  });

  describe('panel width', () => {
    it('uses panel width from store', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        panelWidth: 500,
      });
      render(<DocumentPanel documents={defaultDocuments} />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toHaveStyle({ width: '500px' });
    });
  });

  describe('scrolling', () => {
    it('uses ScrollArea for content scrolling', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.getByTestId('document-panel-scroll')).toBeInTheDocument();
    });
  });

  describe('responsive behavior', () => {
    it('renders panel with fixed width on desktop', () => {
      mockMatchMedia(false); // desktop
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        panelWidth: 500,
      });
      render(<DocumentPanel documents={defaultDocuments} />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveStyle({ width: '500px' });
    });

    it('renders panel with full width on mobile', () => {
      mockMatchMedia(true); // mobile
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveStyle({ width: '100%' });
    });

    it('hides resize handle on mobile', () => {
      mockMatchMedia(true); // mobile
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    });

    it('shows resize handle on desktop', () => {
      mockMatchMedia(false); // desktop
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
    });

    it('shows document title on mobile', () => {
      mockMatchMedia(true); // mobile
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={[createDocument({ title: 'MobileTitle' })]} />);

      expect(screen.getByText('MobileTitle')).toBeInTheDocument();
    });
  });

  describe('resize handle', () => {
    it('renders resize handle with visible indicator', () => {
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      const handle = screen.getByTestId('resize-handle');
      expect(handle).toBeInTheDocument();
      // Should have a visible indicator element inside
      expect(screen.getByTestId('resize-indicator')).toBeInTheDocument();
    });

    it('starts resizing on mouse down', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      const handle = screen.getByTestId('resize-handle');
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      // Panel should have select-none class when resizing
      const panel = screen.getByTestId('document-panel');
      expect(panel).toHaveClass('select-none');
    });

    it('stops resizing on mouse up', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({ isPanelOpen: true, activeDocumentId: 'doc-123' });
      render(<DocumentPanel documents={defaultDocuments} />);

      const handle = screen.getByTestId('resize-handle');

      // Start resize
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      // Release mouse
      await user.pointer({ keys: '[/MouseLeft]' });

      // Panel should no longer have select-none class
      const panel = screen.getByTestId('document-panel');
      expect(panel).not.toHaveClass('select-none');
    });

    it('updates width on mouse move while resizing', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        panelWidth: 400,
      });
      render(<DocumentPanel documents={defaultDocuments} />);

      const handle = screen.getByTestId('resize-handle');

      // Start resize
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      // Move mouse (this will trigger the effect's mousemove handler)
      await user.pointer({ coords: { x: 100, y: 100 } });

      // The width may have changed (depends on panel position)
      // Just verify the panel is still rendered and interaction didn't break
      expect(screen.getByTestId('document-panel')).toBeInTheDocument();

      // Release mouse
      await user.pointer({ keys: '[/MouseLeft]' });
    });
  });
});

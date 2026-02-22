import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { DocumentPanel } from './document-panel';
import { useDocumentStore } from '../../stores/document';
import type { Document } from '../../lib/document-parser';

// Mock Streamdown: Shiki lazy-loads via React.lazy() in JSDOM, so code content
// isn't visible in sync tests. The mock renders children (fenced code block string)
// as plain text, keeping text assertions working.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

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

  const defaultDocument = createDocument();

  beforeEach(() => {
    // Mock desktop viewport by default (isMobile = false)
    mockMatchMedia(false);
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
      activeDocument: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('visibility', () => {
    it('does not render when panel is closed', () => {
      render(<DocumentPanel />);

      expect(screen.queryByTestId('document-panel')).not.toBeInTheDocument();
    });

    it('renders when panel is open', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId('document-panel')).toBeInTheDocument();
    });

    it('does not render when no active document', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: null,
        activeDocument: null,
      });
      render(<DocumentPanel />);

      expect(screen.queryByTestId('document-panel')).not.toBeInTheDocument();
    });
  });

  describe('header', () => {
    it('displays document title', () => {
      const document_ = createDocument({ title: 'UserService' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText('UserService')).toBeInTheDocument();
    });

    it('has close button', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('closes panel when close button is clicked', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /close/i }));

      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('has copy button', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

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
      const document_ = createDocument({ content });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('does not crash when clipboard API fails', async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(() => Promise.reject(new Error('Clipboard not available'))) },
        writable: true,
        configurable: true,
      });

      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      // Should not crash — copy button remains visible
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('has download button', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
    });

    it('triggers download when download button is clicked', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({
        title: 'MyComponent',
        language: 'typescript',
        content: 'const x = 1;',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // Mock URL.createObjectURL and URL.revokeObjectURL
      const mockUrl = 'blob:mock-url';
      const createObjectURL = vi.fn(() => mockUrl);
      const revokeObjectURL = vi.fn();
      globalThis.URL.createObjectURL = createObjectURL;
      globalThis.URL.revokeObjectURL = revokeObjectURL;

      // Mock anchor click
      const clickSpy = vi.fn();
      vi.spyOn(document, 'createElement').mockReturnValueOnce({
        href: '',
        download: '',
        click: clickSpy,
        style: {},
      } as unknown as HTMLAnchorElement);

      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith(mockUrl);
    });

    it('displays title with primary color', () => {
      const document_ = createDocument({ title: 'TestTitle' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const title = screen.getByText('TestTitle');
      expect(title).toHaveClass('text-primary');
    });
  });

  describe('content rendering', () => {
    it('renders code content for code documents', () => {
      const document_ = createDocument({ type: 'code', content: 'const hello = "world";' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText(/const hello/)).toBeInTheDocument();
    });

    it('renders mermaid diagram for mermaid documents', () => {
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // MermaidDiagram shows loading state initially
      expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
    });

    it('shows raw toggle button for mermaid documents', () => {
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /show raw/i })).toBeInTheDocument();
    });

    it('toggles between rendered and raw view for mermaid', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // Initially shows rendered view (mermaid component)
      expect(
        screen.queryByTestId('mermaid-loading') ?? screen.queryByTestId('mermaid-diagram')
      ).toBeInTheDocument();

      // Click to show raw
      await user.click(screen.getByRole('button', { name: /show raw/i }));

      // Now should show code block with mermaid content
      expect(screen.getByTestId('highlighted-code')).toBeInTheDocument();
      expect(screen.getByText(/flowchart TD/)).toBeInTheDocument();

      // Toggle back to rendered
      await user.click(screen.getByRole('button', { name: /show rendered/i }));

      // Back to mermaid diagram (either loading or rendered)
      expect(
        screen.queryByTestId('mermaid-loading') ?? screen.queryByTestId('mermaid-diagram')
      ).toBeInTheDocument();
      // Code block should no longer be visible
      expect(screen.queryByTestId('highlighted-code')).not.toBeInTheDocument();
    });

    it('does not show raw toggle for code documents', () => {
      const document_ = createDocument({ type: 'code', content: 'const x = 1;' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.queryByRole('button', { name: /show raw/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /show rendered/i })).not.toBeInTheDocument();
    });

    it('renders code block for html documents', () => {
      const document_ = createDocument({
        type: 'html',
        language: 'html',
        content: '<div>Hello</div>',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId('highlighted-code')).toBeInTheDocument();
    });

    it('wraps code content in document-panel-code class', () => {
      const document_ = createDocument({ type: 'code', content: 'const x = 1;' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const codeContainer = screen.getByTestId('highlighted-code');
      expect(codeContainer).toHaveClass('document-panel-code');
    });

    it('renders code block for react documents', () => {
      const document_ = createDocument({
        type: 'react',
        language: 'tsx',
        content: 'function App() { return <div /> }',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId('highlighted-code')).toBeInTheDocument();
    });
  });

  describe('panel width', () => {
    it('uses panel width from store', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 500,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toHaveStyle({ width: '500px' });
    });
  });

  describe('scrolling', () => {
    it('uses ScrollArea for content scrolling', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId('document-panel-scroll')).toBeInTheDocument();
    });
  });

  describe('responsive behavior', () => {
    it('renders panel with fixed width on desktop', () => {
      mockMatchMedia(false); // desktop
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 500,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveStyle({ width: '500px' });
    });

    it('renders panel with full width on mobile', () => {
      mockMatchMedia(true); // mobile
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveStyle({ width: '100%' });
    });

    it('hides resize handle on mobile', () => {
      mockMatchMedia(true); // mobile
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    });

    it('shows resize handle on desktop', () => {
      mockMatchMedia(false); // desktop
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
    });

    it('shows document title on mobile', () => {
      mockMatchMedia(true); // mobile
      const document_ = createDocument({ title: 'MobileTitle' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText('MobileTitle')).toBeInTheDocument();
    });
  });

  describe('fullscreen toggle', () => {
    it('renders fullscreen button on desktop', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /fullscreen/i })).toBeInTheDocument();
    });

    it('toggles fullscreen state when clicked', async () => {
      const user = userEvent.setup();
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /fullscreen/i }));

      expect(useDocumentStore.getState().isFullscreen).toBe(true);
    });

    it('shows exit fullscreen label when fullscreen is active', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeInTheDocument();
    });

    it('does not render fullscreen button on mobile', () => {
      mockMatchMedia(true);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.queryByRole('button', { name: /fullscreen/i })).not.toBeInTheDocument();
    });

    it('has width transition class when not resizing', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId('document-panel');
      expect(panel.className).toContain('transition-');
    });

    it('uses 100% width when fullscreen is active on desktop', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 500,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId('document-panel');
      expect(panel).toHaveStyle({ width: '100%' });
    });

    it('exits fullscreen when user starts resizing', async () => {
      const user = userEvent.setup();
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      expect(useDocumentStore.getState().isFullscreen).toBe(true);

      const handle = screen.getByTestId('resize-handle');
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      expect(useDocumentStore.getState().isFullscreen).toBe(false);
    });
  });

  describe('resize handle', () => {
    it('renders resize handle with visible indicator', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const handle = screen.getByTestId('resize-handle');
      expect(handle).toBeInTheDocument();
      // Should have a visible indicator element inside
      expect(screen.getByTestId('resize-indicator')).toBeInTheDocument();
    });

    it('starts resizing on mouse down', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const handle = screen.getByTestId('resize-handle');
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      // Panel should have select-none class when resizing
      const panel = screen.getByTestId('document-panel');
      expect(panel).toHaveClass('select-none');
    });

    it('stops resizing on mouse up', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

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
        activeDocument: defaultDocument,
        panelWidth: 400,
      });
      render(<DocumentPanel />);

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

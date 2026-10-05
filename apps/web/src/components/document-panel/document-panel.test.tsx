import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { PageShellContext } from '@/components/shared/page-shell';
import { DocumentPanel } from './document-panel';
import { useDocumentStore } from '../../stores/document';
import type { Document } from '../../lib/chat/document-parser';
import type * as DownloadTextFileModule from '@/lib/download-text-file';

const { downloadTextFile } = vi.hoisted(() => ({
  downloadTextFile: vi.fn<typeof DownloadTextFileModule.downloadTextFile>(),
}));

vi.mock('@/lib/download-text-file', () => ({ downloadTextFile }));

// Mock Streamdown: Shiki lazy-loads via React.lazy() in JSDOM, so code content
// isn't visible in sync tests. The mock renders children (fenced code block string)
// as plain text, keeping text assertions working.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: 'light', triggerTransition: vi.fn() }),
}));

describe('DocumentPanel', () => {
  const createDocument = (overrides: Partial<Document> = {}): Document => ({
    id: 'doc-123',
    type: 'code',
    language: 'typescript',
    title: 'MyComponent',
    content: 'const x = 1;\nconst y = 2;',
    lineCount: 2,
    isStreaming: false,
    ...overrides,
  });

  const defaultDocument = createDocument();

  beforeEach(() => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'http://localhost:7400');
    useDocumentStore.setState({
      isPanelOpen: false,
      activeDocumentId: null,
      activeDocument: null,
    });
  });

  afterEach(() => {
    downloadTextFile.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('visibility', () => {
    it('does not render when panel is closed', () => {
      render(<DocumentPanel />);

      expect(screen.queryByTestId(TEST_IDS.documentPanel)).not.toBeInTheDocument();
    });

    it('renders when panel is open', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.documentPanel)).toBeInTheDocument();
    });

    it('does not render when no active document', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: null,
        activeDocument: null,
      });
      render(<DocumentPanel />);

      expect(screen.queryByTestId(TEST_IDS.documentPanel)).not.toBeInTheDocument();
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

    it('names the language and the length under the title', () => {
      const document_ = createDocument({ language: 'python', lineCount: 58 });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText('python · 58 lines')).toBeInTheDocument();
    });

    it('labels a document without a language the way its card does', () => {
      const document_ = createDocument({ type: 'code', language: '', lineCount: 3 });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText('Code · 3 lines')).toBeInTheDocument();
    });

    it('keeps its header clear of a phone status bar while it fills the screen', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      // The stylesheet is absent here, so the class stands in for the inset a phone applies.
      expect(screen.getByTestId(TEST_IDS.documentPanel)).toHaveClass(
        'max-md:pt-[env(safe-area-inset-top,0px)]'
      );
    });

    it('stands in the page shell pane slot, beside the header as well as the thread', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      const pane = document.createElement('div');
      document.body.append(pane);
      const slots = {
        title: null,
        center: null,
        shield: null,
        facepile: null,
        newChat: null,
        strip: null,
        pane,
      };

      const { container } = render(
        <PageShellContext value={{ slots, setHeaderTestId: vi.fn() }}>
          <DocumentPanel />
        </PageShellContext>
      );

      expect(pane).toContainElement(screen.getByTestId(TEST_IDS.documentPanel));
      expect(container).toBeEmptyDOMElement();
      pane.remove();
    });

    it('draws nothing inside a page shell until its pane slot exists', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      const slots = {
        title: null,
        center: null,
        shield: null,
        facepile: null,
        newChat: null,
        strip: null,
        pane: null,
      };

      render(
        <PageShellContext value={{ slots, setHeaderTestId: vi.fn() }}>
          <DocumentPanel />
        </PageShellContext>
      );

      expect(screen.queryByTestId(TEST_IDS.documentPanel)).not.toBeInTheDocument();
    });

    it('is a landmark named for what it holds', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('complementary', { name: 'Document' })).toHaveAttribute(
        'id',
        'document-panel'
      );
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
      const mockWriteText = vi.fn(() => Promise.reject(new Error('Clipboard not available')));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
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

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalled();
      });
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
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

    it('saves the document under its title through the shared download', async () => {
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

      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(downloadTextFile).toHaveBeenCalledWith('MyComponent.ts', 'const x = 1;');
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
      expect(screen.getByTestId(TEST_IDS.mermaidLoading)).toBeInTheDocument();
    });

    it('offers the Output and Code views for mermaid documents', () => {
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('radio', { name: 'Output' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Code' })).toBeInTheDocument();
    });

    it('toggles between the output and the code view for mermaid', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(
        screen.queryByTestId(TEST_IDS.mermaidLoading) ??
          screen.queryByTestId(TEST_IDS.mermaidDiagram)
      ).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: 'Code' }));

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.getByText(/flowchart TD/)).toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: 'Output' }));

      // Back to mermaid diagram (either loading or rendered)
      expect(
        screen.queryByTestId(TEST_IDS.mermaidLoading) ??
          screen.queryByTestId(TEST_IDS.mermaidDiagram)
      ).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.highlightedCode)).not.toBeInTheDocument();
    });

    it('offers no views for code documents, which have only their source', () => {
      const document_ = createDocument({ type: 'code', content: 'const x = 1;' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    });

    it('renders the sandbox preview for html documents by default', () => {
      const document_ = createDocument({
        type: 'html',
        language: 'html',
        title: 'Landing',
        content: '<div>Hello</div>',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const frame = screen.getByTitle('Landing');
      expect(frame).toBeInTheDocument();
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(screen.queryByTestId(TEST_IDS.highlightedCode)).not.toBeInTheDocument();
    });

    it('shows the source of a runnable document in its code view', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({
        type: 'html',
        language: 'html',
        title: 'Landing',
        content: '<div>Hello</div>',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('radio', { name: 'Code' }));

      expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toContain(
        '<div>Hello</div>'
      );
    });

    it('renders the sandbox preview for js documents', () => {
      const document_ = createDocument({
        type: 'js',
        language: 'javascript',
        title: 'Script',
        content: 'document.body.append("x");',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByTitle('Script')).toBeInTheDocument();
    });

    it('renders a Run control for python documents', () => {
      const document_ = createDocument({
        type: 'python',
        language: 'python',
        title: 'Analysis',
        content: 'print("hi")',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // Until its frame answers the action reads Stop, which replaces a frame that never does.
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    });

    it('wraps code content in document-panel-code class', () => {
      const document_ = createDocument({ type: 'code', content: 'const x = 1;' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const codeContainer = screen.getByTestId(TEST_IDS.highlightedCode);
      expect(codeContainer).toHaveClass('document-panel-code');
    });

    it('renders the sandbox preview for react documents by default', () => {
      const document_ = createDocument({
        type: 'react',
        language: 'tsx',
        title: 'Widget',
        content: 'export default function App() { return <div /> }',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByTitle('Widget')).toBeInTheDocument();
    });
  });

  describe('streaming documents', () => {
    const statusOf = (container: HTMLElement): string | null =>
      container.querySelector<HTMLElement>('#document-render-status')?.dataset['status'] ?? null;

    const reactDocument = (overrides: Partial<Document> = {}): Document =>
      createDocument({
        type: 'react',
        language: 'jsx',
        title: 'Widget',
        content: 'export default function App() { return <div /> }',
        ...overrides,
      });

    const openDocument = (document_: Document): void => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
    };

    it('hands a still-streaming document to the sandbox rather than withholding it', () => {
      openDocument(reactDocument({ isStreaming: true }));
      render(<DocumentPanel />);

      expect(screen.getByTitle('Widget')).toBeInTheDocument();
    });

    it('shows the source and no error until something renders', () => {
      openDocument(reactDocument({ isStreaming: true }));
      const { container } = render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('announces the wait as a status, not as a failure', () => {
      openDocument(reactDocument({ isStreaming: true }));
      const { container } = render(<DocumentPanel />);

      const status = container.querySelector('#document-render-status');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent(/preview starts when the code is ready/i);
      expect(screen.getAllByText(/preview starts when the code is ready/i).length).toBeGreaterThan(
        0
      );
    });

    it('holds back the mermaid diagram while its message streams', () => {
      openDocument(
        createDocument({
          type: 'mermaid',
          language: 'mermaid',
          content: 'flowchart TD\n    A --> B',
          isStreaming: true,
        })
      );
      const { container } = render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.mermaidLoading)).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('shows a plain code document as source with no preview status', () => {
      openDocument(createDocument({ type: 'code', isStreaming: true }));
      const { container } = render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(statusOf(container)).toBeNull();
    });

    it('offers the views while the message is still streaming', () => {
      openDocument(reactDocument({ isStreaming: true }));
      render(<DocumentPanel />);

      expect(screen.getByRole('radio', { name: 'Code' })).toBeInTheDocument();
    });

    it('still requires an explicit run for python while its message streams', () => {
      openDocument(
        createDocument({
          type: 'python',
          language: 'python',
          title: 'Analysis',
          content: 'print("hi")',
          isStreaming: true,
        })
      );
      const { container } = render(<DocumentPanel />);

      expect(statusOf(container)).toBe('booting');
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    });

    it('keeps an explicit code view when the message settles', async () => {
      const user = userEvent.setup();
      const streaming = reactDocument({ isStreaming: true });
      openDocument(streaming);
      render(<DocumentPanel />);

      await user.click(screen.getByRole('radio', { name: 'Code' }));
      act(() => {
        useDocumentStore.getState().refreshActiveDocument({ ...streaming, isStreaming: false });
      });

      expect(screen.getByRole('radio', { name: 'Code' })).toBeChecked();
      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
    });

    it('keeps the same sandbox frame as a streaming document grows', () => {
      const streaming = reactDocument({ isStreaming: true });
      openDocument(streaming);
      render(<DocumentPanel />);
      const frame = screen.getByTitle('Widget');

      act(() => {
        useDocumentStore.getState().refreshActiveDocument({
          ...streaming,
          id: 'doc-grown',
          content: `${streaming.content}\n// more`,
        });
      });

      expect(screen.getByTitle('Widget')).toBe(frame);
    });

    it('returns to the output view when the user opens another document', async () => {
      const user = userEvent.setup();
      openDocument(reactDocument());
      render(<DocumentPanel />);

      await user.click(screen.getByRole('radio', { name: 'Code' }));
      act(() => {
        useDocumentStore
          .getState()
          .setActiveDocument(reactDocument({ id: 'doc-other', title: 'Other' }));
      });

      expect(screen.getByRole('radio', { name: 'Output' })).toBeChecked();
    });

    it('remounts the sandbox frame when the user opens another document', () => {
      openDocument(reactDocument());
      render(<DocumentPanel />);
      const frame = screen.getByTitle('Widget');

      act(() => {
        useDocumentStore.getState().setActiveDocument(reactDocument({ id: 'doc-other' }));
      });

      expect(screen.getByTitle('Widget')).not.toBe(frame);
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

      expect(screen.getByTestId(TEST_IDS.documentPanelScroll)).toBeInTheDocument();
    });
  });

  describe('fullscreen toggle', () => {
    it('renders a fullscreen button', () => {
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
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeInTheDocument();
    });
  });

  describe('code fence generation', () => {
    it('builds a fence longer than any backtick run in the content, with no language', () => {
      const document_ = createDocument({
        language: '',
        // Two backtick runs (3 then 1): the shorter later run exercises the
        // `current > maxRun` false branch in the fence-length scan.
        content: 'intro ``` middle ` end',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // The Streamdown mock echoes the fenced string; the source content survives.
      expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toContain(
        'intro ``` middle ` end'
      );
    });
  });

  describe('copy feedback timeout', () => {
    it('resets the copied indicator after the timeout', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(() => Promise.resolve()) },
        configurable: true,
      });
      const document_ = createDocument({ content: 'copy me' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      });

      // The setTimeout callback flips `copied` back after 2s.
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });

  describe('download without language', () => {
    it('uses a .txt extension when the document has no language', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({ title: 'PlainNotes', language: '', content: 'x' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(downloadTextFile).toHaveBeenCalledWith('PlainNotes.txt', 'x');
    });
  });
});

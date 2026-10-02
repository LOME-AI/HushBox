import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { TEST_IDS } from '@hushbox/shared';
import { DiagramCard } from '@/components/chat/message/diagram-card';
import { useDocumentStore } from '@/stores/document';
import type { Document } from '@/lib/chat/document-parser';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: 'light', triggerTransition: vi.fn() }),
}));

const CHART = 'graph TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]\n  B -->|No| A';

class StubIntersectionObserver implements IntersectionObserver {
  static readonly instances: StubIntersectionObserver[] = [];
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds: readonly number[] = [];
  readonly targets: Element[] = [];
  readonly disconnect = vi.fn<() => void>();
  readonly unobserve = vi.fn<(target: Element) => void>();
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    StubIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(isIntersecting: boolean): void {
    const entries = this.targets.map((target): IntersectionObserverEntry => {
      const rect = target.getBoundingClientRect();
      return {
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: 0,
      };
    });
    this.callback(entries, this);
  }
}

function scrollCardIntoView(isIntersecting = true): void {
  const observer = StubIntersectionObserver.instances.at(-1);
  expect(observer).toBeDefined();
  act(() => {
    observer?.report(isIntersecting);
  });
}

function createDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-diagram',
    type: 'mermaid',
    language: 'mermaid',
    title: 'Graph Diagram',
    content: CHART,
    lineCount: 4,
    isStreaming: false,
    ...overrides,
  };
}

describe('DiagramCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    StubIntersectionObserver.instances.length = 0;
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg><text>Diagram</text></svg>',
      bindFunctions: vi.fn(),
      diagramType: 'flowchart-v2',
    });
    useDocumentStore.setState({
      isPanelOpen: false,
      activeDocumentId: null,
      activeDocument: null,
      activeSelectionId: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('head', () => {
    it('names the diagram by its title', () => {
      render(<DiagramCard document={createDocument()} />);

      const caption = screen.getByTestId(TEST_IDS.diagramCard).querySelector('figcaption');
      expect(caption?.textContent.startsWith('Graph Diagram · mermaid')).toBe(true);
    });

    it('follows the title with its language and line count', () => {
      render(<DiagramCard document={createDocument({ lineCount: 29 })} />);

      expect(screen.getByText('· mermaid · 29 lines')).toBeInTheDocument();
    });

    it('offers Source and Open', () => {
      render(<DiagramCard document={createDocument()} />);

      expect(screen.getByRole('button', { name: 'Source' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    });

    it('keeps the first word of its title whole', () => {
      render(<DiagramCard document={createDocument({ title: 'Signup and verification' })} />);

      expect(screen.getByText('Signup')).toHaveClass('shrink-0');
      expect(screen.getByText('and verification').parentElement).toHaveClass('truncate', 'basis-0');
    });

    it('shows a one-word title whole with only its language and line count after it', () => {
      render(<DiagramCard document={createDocument({ title: 'Pipeline' })} />);

      const caption = screen.getByTestId(TEST_IDS.diagramCard).querySelector('figcaption');
      expect(screen.getByText('Pipeline')).toHaveClass('shrink-0');
      expect(caption?.textContent.startsWith('Pipeline · mermaid · 4 lines')).toBe(true);
    });

    it('moves its tools below the title when the first word cannot sit beside them', () => {
      render(<DiagramCard document={createDocument()} />);

      const caption = screen.getByTestId(TEST_IDS.diagramCard).querySelector('figcaption');
      expect(caption).toHaveClass('flex-wrap');
      expect(screen.getByRole('button', { name: 'Open' }).parentElement).toHaveClass(
        'ms-auto',
        'shrink-0'
      );
    });

    it('measures its own width to decide how much of the head to show', () => {
      render(<DiagramCard document={createDocument()} />);

      expect(screen.getByTestId(TEST_IDS.diagramCard)).toHaveClass('@container');
    });

    it('keeps the word labels as the names of the icon forms', () => {
      render(<DiagramCard document={createDocument()} />);

      for (const word of ['Source', 'Open']) {
        const label = screen.getByText(word);
        expect(label).toHaveClass('sr-only');
        expect(label.className).toMatch(/@min-\[[\d.]+rem\]:not-sr-only/);
      }
    });

    it('hides the language and line count by the card width, not the viewport', () => {
      render(<DiagramCard document={createDocument()} />);

      const meta = screen.getByText('· mermaid · 4 lines');
      expect(meta.className).toMatch(/(^| )hidden( |$)/);
      expect(meta.className).toMatch(/@min-\[[\d.]+rem\]:inline/);
      expect(meta.className).not.toContain('max-md:');
    });

    it('is a figure captioned by its head', () => {
      render(<DiagramCard document={createDocument()} />);

      const figure = screen.getByTestId(TEST_IDS.diagramCard);
      expect(figure.tagName).toBe('FIGURE');
      expect(figure.querySelector('figcaption')).toHaveTextContent('Graph Diagram');
    });
  });

  describe('lazy drawing', () => {
    it('draws nothing before it is scrolled into view', async () => {
      render(<DiagramCard document={createDocument()} />);

      await Promise.resolve();
      expect(mermaid.render).not.toHaveBeenCalled();
    });

    it('draws nothing while it stays out of view', async () => {
      render(<DiagramCard document={createDocument()} />);

      scrollCardIntoView(false);

      await Promise.resolve();
      expect(mermaid.render).not.toHaveBeenCalled();
    });

    it('draws the diagram in the thread once it is scrolled into view', async () => {
      render(<DiagramCard document={createDocument()} />);

      scrollCardIntoView();

      expect(await screen.findByRole('img', { name: 'flowchart diagram' })).toBeInTheDocument();
      expect(vi.mocked(mermaid.render).mock.calls[0]?.[1]).toBe(CHART);
    });

    it('stops watching the scroll once it is in view', async () => {
      render(<DiagramCard document={createDocument()} />);

      scrollCardIntoView();

      expect(StubIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalled();
      await screen.findByRole('img', { name: 'flowchart diagram' });
    });

    it('stops watching the scroll when it unmounts unseen', () => {
      const { unmount } = render(<DiagramCard document={createDocument()} />);

      unmount();

      expect(StubIntersectionObserver.instances.at(-1)?.disconnect).toHaveBeenCalled();
    });

    it('holds the drawing while its message streams', async () => {
      render(<DiagramCard document={createDocument({ isStreaming: true })} />);

      scrollCardIntoView();

      await Promise.resolve();
      expect(mermaid.render).not.toHaveBeenCalled();
    });

    it('draws once its message settles', async () => {
      const { rerender } = render(<DiagramCard document={createDocument({ isStreaming: true })} />);
      scrollCardIntoView();

      rerender(<DiagramCard document={createDocument()} />);

      expect(await screen.findByRole('img', { name: 'flowchart diagram' })).toBeInTheDocument();
    });

    it('carries none of the panel diagram test ids', async () => {
      render(<DiagramCard document={createDocument()} />);

      scrollCardIntoView();

      await screen.findByRole('img', { name: 'flowchart diagram' });
      expect(screen.queryByTestId(TEST_IDS.mermaidDiagram)).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.mermaidLoading)).not.toBeInTheDocument();
    });
  });

  describe('scrolling', () => {
    it('scrolls a wide drawing sideways inside a named region the keyboard reaches', () => {
      render(<DiagramCard document={createDocument()} />);

      const region = screen.getByRole('group', { name: 'Graph Diagram' });
      expect(region).toHaveAttribute('data-slot', 'scroll-region');
      expect(region).toHaveClass('overflow-x-auto');
    });

    it('draws the diagram in the thread at its natural size', async () => {
      vi.mocked(mermaid.render).mockResolvedValue({
        svg: '<svg width="100%" viewBox="-8 -8 437.5 612.25" style="max-width: 437.5px;"></svg>',
        bindFunctions: vi.fn(),
        diagramType: 'flowchart-v2',
      });
      render(<DiagramCard document={createDocument()} />);
      scrollCardIntoView();

      const drawing = await screen.findByRole('img', { name: 'flowchart diagram' });
      expect(drawing.querySelector('svg')).toHaveAttribute('width', '437.5');
    });

    it('keeps the drawing at its natural size once its document opens in the panel', async () => {
      vi.mocked(mermaid.render).mockResolvedValue({
        svg: '<svg width="100%" viewBox="-8 -8 437.5 612.25" style="max-width: 437.5px;"></svg>',
        bindFunctions: vi.fn(),
        diagramType: 'flowchart-v2',
      });
      const user = userEvent.setup();
      render(<DiagramCard document={createDocument()} />);
      scrollCardIntoView();
      const drawing = await screen.findByRole('img', { name: 'flowchart diagram' });

      await user.click(screen.getByRole('button', { name: 'Open' }));

      expect(drawing.querySelector('svg')).toHaveAttribute('width', '437.5');
    });

    it('centres a drawing narrower than the card body', async () => {
      render(<DiagramCard document={createDocument()} />);
      scrollCardIntoView();

      expect(await screen.findByRole('img', { name: 'flowchart diagram' })).toHaveClass(
        '[&>svg]:mx-auto'
      );
    });
  });

  describe('Source', () => {
    it('shows the source in place of the diagram', async () => {
      const user = userEvent.setup();
      render(<DiagramCard document={createDocument()} />);
      scrollCardIntoView();
      await screen.findByRole('img', { name: 'flowchart diagram' });

      await user.click(screen.getByRole('button', { name: 'Source' }));

      expect(screen.getByText(/B -->\|Yes\| C\[Ship\]/)).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'flowchart diagram' })).not.toBeInTheDocument();
    });

    it('reads as pressed while the source shows', async () => {
      const user = userEvent.setup();
      render(<DiagramCard document={createDocument()} />);

      const toggle = screen.getByTestId(TEST_IDS.diagramSourceToggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await user.click(toggle);

      expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    it('returns to the diagram when pressed again', async () => {
      const user = userEvent.setup();
      render(<DiagramCard document={createDocument()} />);
      scrollCardIntoView();
      const toggle = screen.getByRole('button', { name: 'Source' });

      await user.click(toggle);
      await user.click(toggle);

      expect(await screen.findByRole('img', { name: 'flowchart diagram' })).toBeInTheDocument();
      expect(screen.queryByText(/B -->\|Yes\| C\[Ship\]/)).not.toBeInTheDocument();
    });
  });

  describe('Open', () => {
    it('opens its document in the panel', async () => {
      const user = userEvent.setup();
      const document_ = createDocument();
      render(<DiagramCard document={document_} />);

      await user.click(screen.getByRole('button', { name: 'Open' }));

      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
      expect(useDocumentStore.getState().activeDocument).toBe(document_);
    });

    it('marks itself active while its document is showing', () => {
      useDocumentStore.setState({ activeDocumentId: 'doc-diagram', isPanelOpen: true });
      render(<DiagramCard document={createDocument()} />);

      expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('data-active', 'true');
    });

    it('keeps the panel on the diagram as its message streams', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <DiagramCard document={createDocument({ id: 'doc-partial', isStreaming: true })} />
      );
      await user.click(screen.getByRole('button', { name: 'Open' }));

      rerender(<DiagramCard document={createDocument({ id: 'doc-complete' })} />);

      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-complete');
      expect(useDocumentStore.getState().activeDocument?.isStreaming).toBe(false);
    });
  });
});

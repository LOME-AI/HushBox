import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import mermaid from 'mermaid';
import { MermaidDiagram } from '@/components/chat/message/mermaid-diagram';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

let mockThemeMode: 'light' | 'dark' = 'light';
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: mockThemeMode, triggerTransition: vi.fn() }),
}));

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThemeMode = 'light';
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><text>Diagram</text></svg>',
      bindFunctions: vi.fn(),
      diagramType: 'flowchart',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders mermaid diagram from chart definition', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
    });
  });

  it('calls mermaid.render with chart definition', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalled();
    });

    const renderCalls = vi.mocked(mermaid.render).mock.calls;
    expect(renderCalls[0]?.[1]).toBe(chart);
  });

  it('displays rendered SVG content', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      const container = screen.getByTestId('mermaid-diagram');
      expect(container.innerHTML).toContain('svg');
    });
  });

  it('shows error message for invalid diagram syntax', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error'));

    const invalidChart = 'invalid mermaid syntax !!!';

    render(<MermaidDiagram chart={invalidChart} />);

    await waitFor(() => {
      expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    });
  });

  it('names the rendered diagram after the diagram type', async () => {
    // Mermaid returns the internal, version-suffixed id for flowcharts.
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg><text>Diagram</text></svg>',
      bindFunctions: vi.fn(),
      diagramType: 'flowchart-v2',
    });

    render(<MermaidDiagram chart={'graph TD\n  A --> B'} />);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'flowchart diagram' })).toBeInTheDocument();
    });
  });

  it('names the rendered diagram after the chart accessibility title when it declares one', async () => {
    render(<MermaidDiagram chart={'graph TD\n  accTitle: Deploy pipeline\n  A --> B'} />);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Deploy pipeline' })).toBeInTheDocument();
    });
  });

  it('never renders the raw failure text from mermaid', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error on line 3'));

    render(<MermaidDiagram chart="invalid mermaid syntax !!!" />);

    await waitFor(() => {
      expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/parse error on line 3/i)).not.toBeInTheDocument();
  });

  it('applies custom className', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} className="custom-class" />);

    await waitFor(() => {
      const container = screen.getByTestId('mermaid-diagram');
      expect(container).toHaveClass('custom-class');
    });
  });

  it('shows loading state while rendering', () => {
    vi.mocked(mermaid.render).mockImplementation(() => new Promise(() => {}));

    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
  });

  it('initializes mermaid with the light theme in light mode', async () => {
    mockThemeMode = 'light';
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ theme: 'default' });
  });

  it('initializes mermaid with the dark theme in dark mode', async () => {
    mockThemeMode = 'dark';
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ theme: 'dark' });
  });

  it.each(['light', 'dark'] as const)(
    'paints the drawing from the app colour tokens in %s mode',
    async (mode) => {
      mockThemeMode = mode;

      render(<MermaidDiagram chart={'graph TD\n  A --> B'} />);

      await waitFor(() => {
        expect(mermaid.initialize).toHaveBeenCalled();
      });
      const themeCSS = vi.mocked(mermaid.initialize).mock.calls.at(-1)?.[0].themeCSS ?? '';
      for (const token of [
        '--background-paper',
        '--background-subtle',
        '--border-strong',
        '--foreground',
        '--foreground-muted',
        '--brand-red',
      ]) {
        expect(themeCSS).toContain(`var(${token})`);
      }
    }
  );

  it('names no literal colour of its own', async () => {
    render(<MermaidDiagram chart={'graph TD\n  A --> B'} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const themeCSS = vi.mocked(mermaid.initialize).mock.calls.at(-1)?.[0].themeCSS ?? '';
    expect(themeCSS).not.toMatch(/#[\da-f]{3,8}\b|rgb\(|hsl\(/i);
  });

  it('holds its loading state without drawing while deferred', async () => {
    render(<MermaidDiagram chart={'graph TD\n  A --> B'} deferred />);

    expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
    await Promise.resolve();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it('draws once it is no longer deferred', async () => {
    const { rerender } = render(<MermaidDiagram chart={'graph TD\n  A --> B'} deferred />);

    rerender(<MermaidDiagram chart={'graph TD\n  A --> B'} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
    });
  });

  it('carries none of the panel diagram test ids when drawn in the thread', async () => {
    const { container } = render(
      <MermaidDiagram chart={'graph TD\n  A --> B'} placement="thread" />
    );

    expect(screen.queryByTestId('mermaid-loading')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'flowchart diagram' })).toBeInTheDocument();
    });
    expect(container.querySelector('[data-testid]:not([data-testid="mermaid-svg"])')).toBeNull();
  });

  it('carries no test id on its failure notice when drawn in the thread', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error'));

    render(<MermaidDiagram chart="not a chart" placement="thread" />);

    await waitFor(() => {
      expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });

  describe('size', () => {
    const FITTED_SVG =
      '<svg id="drawn" width="100%" viewBox="-8 -8 437.5 612.25" style="max-width: 437.5px;"><text>Diagram</text></svg>';

    beforeEach(() => {
      vi.mocked(mermaid.render).mockResolvedValue({
        svg: FITTED_SVG,
        bindFunctions: vi.fn(),
        diagramType: 'flowchart-v2',
      });
    });

    it('draws at its natural size in the thread, one unit to a pixel', async () => {
      const { container } = render(
        <MermaidDiagram chart={'graph TD\n  A --> B'} placement="thread" />
      );

      await waitFor(() => {
        const svg = container.querySelector('svg#drawn');
        expect(svg).toHaveAttribute('width', '437.5');
        expect(svg).toHaveAttribute('height', '612.25');
      });
    });

    it('keeps its natural size when it renders again with the same drawing', async () => {
      const { container, rerender } = render(
        <MermaidDiagram chart={'graph TD\n  A --> B'} placement="thread" />
      );
      await waitFor(() => {
        expect(container.querySelector('svg#drawn')).toHaveAttribute('width', '437.5');
      });

      rerender(<MermaidDiagram chart={'graph TD\n  A --> B'} placement="thread" />);

      expect(container.querySelector('svg#drawn')).toHaveAttribute('width', '437.5');
    });

    it('centres a drawing narrower than the thread column', async () => {
      render(<MermaidDiagram chart={'graph TD\n  A --> B'} placement="thread" />);

      expect(await screen.findByRole('img', { name: 'flowchart diagram' })).toHaveClass(
        '[&>svg]:mx-auto'
      );
    });

    it('keeps fitting its container in the panel', async () => {
      const { container } = render(<MermaidDiagram chart={'graph TD\n  A --> B'} />);

      await waitFor(() => {
        expect(container.querySelector('svg#drawn')).toHaveAttribute('width', '100%');
      });
    });
  });

  it('keeps securityLevel strict to mitigate XSS', async () => {
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ securityLevel: 'strict' });
  });

  it('shows the error UI when a non-Error value is thrown', async () => {
    vi.mocked(mermaid.render).mockRejectedValue('boom');

    render(<MermaidDiagram chart="graph TD\n A --> B" />);

    await waitFor(() => {
      expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    });
  });

  it('renders an empty diagram container when mermaid resolves without svg', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: undefined as unknown as string,
      bindFunctions: vi.fn(),
      diagramType: 'flowchart',
    });

    render(<MermaidDiagram chart="graph TD\n A --> B" />);

    await waitFor(() => {
      const container = screen.getByTestId('mermaid-diagram');
      expect(container).toBeInTheDocument();
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('ignores a successful render that resolves after unmount', async () => {
    let resolveRender: ((value: { svg: string }) => void) | undefined;
    vi.mocked(mermaid.render).mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve as (value: { svg: string }) => void;
      })
    );

    const { unmount } = render(<MermaidDiagram chart="graph TD\n A --> B" />);
    unmount();
    resolveRender?.({ svg: '<svg></svg>' });

    // The mounted guard must skip state updates, leaving nothing rendered.
    await Promise.resolve();
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });

  it('ignores a failed render that rejects after unmount', async () => {
    let rejectRender: ((reason: unknown) => void) | undefined;
    vi.mocked(mermaid.render).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRender = reject;
      })
    );

    const { unmount } = render(<MermaidDiagram chart="graph TD\n A --> B" />);
    unmount();
    rejectRender?.(new Error('late failure'));

    await Promise.resolve();
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });
});

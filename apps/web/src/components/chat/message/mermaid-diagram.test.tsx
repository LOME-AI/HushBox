import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

import mermaid from 'mermaid';

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

  it('keeps securityLevel strict to mitigate XSS', async () => {
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ securityLevel: 'strict' });
  });
});

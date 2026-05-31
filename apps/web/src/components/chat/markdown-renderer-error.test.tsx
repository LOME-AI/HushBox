import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock Streamdown so individual tests can toggle whether the next render throws.
// Defaults to throwing — the recovery test below flips this to false mid-test
// to simulate streamdown succeeding once content advances past the problem
// chunk (e.g. an incomplete code-fence at chunk N is completed by chunk N+1).
let mockStreamdownShouldThrow = true;
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => {
    if (mockStreamdownShouldThrow) {
      throw new Error('Failed to fetch dynamically imported module');
    }
    return <span data-testid="streamdown-rendered">{children}</span>;
  },
}));

vi.mock('@streamdown/code', () => ({
  code: {
    name: 'shiki',
    type: 'code-highlighter',
    supportsLanguage: () => false,
    getSupportedLanguages: () => [],
    getThemes: () => ['github-light', 'github-dark'],
    highlight: () => null,
  },
}));
vi.mock('@streamdown/mermaid', () => ({ mermaid: {} }));
vi.mock('@streamdown/math', () => ({ math: {} }));

vi.mock('../../stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    setActiveDocument: vi.fn(),
  }),
}));

import { MarkdownRenderer } from './markdown-renderer';

describe('MarkdownRenderer error handling', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStreamdownShouldThrow = true;
  });

  it('shows raw content as fallback when Streamdown throws', () => {
    render(<MarkdownRenderer content="Hello **world**" />);

    expect(screen.getByTestId('markdown-render-fallback')).toBeInTheDocument();
    expect(screen.getByText('Hello **world**')).toBeInTheDocument();
  });

  it('still renders the outer markdown-renderer wrapper', () => {
    render(<MarkdownRenderer content="test content" />);

    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
  });

  it('does not crash the parent component', () => {
    render(
      <div data-testid="parent">
        <MarkdownRenderer content="safe content" />
      </div>
    );

    expect(screen.getByTestId('parent')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /something went wrong/i })
    ).not.toBeInTheDocument();
  });

  it('shows formatting unavailable message', () => {
    render(<MarkdownRenderer content="content" />);

    expect(screen.getByText('Message formatting unavailable.')).toBeInTheDocument();
  });

  it('handles empty content in fallback without crashing', () => {
    render(<MarkdownRenderer content="" />);

    expect(screen.getByTestId('markdown-render-fallback')).toBeInTheDocument();
  });

  it('preserves multiline content in fallback', () => {
    render(<MarkdownRenderer content={'line1\nline2\nline3'} />);

    expect(screen.getByText(/line1/)).toBeInTheDocument();
    expect(screen.getByText(/line2/)).toBeInTheDocument();
    expect(screen.getByText(/line3/)).toBeInTheDocument();
  });

  it('recovers from a transient streamdown failure when content changes', () => {
    // Simulates the streaming case: streamdown throws on a partial chunk
    // (e.g. incomplete code fence with a `{`), and we want subsequent
    // chunks to re-attempt rendering rather than getting stuck on the fallback.
    const { rerender } = render(<MarkdownRenderer content="partial {" />);
    expect(screen.getByTestId('markdown-render-fallback')).toBeInTheDocument();

    // Next chunk arrives; streamdown can now render successfully.
    mockStreamdownShouldThrow = false;
    rerender(<MarkdownRenderer content="partial { complete }" />);

    expect(screen.queryByTestId('markdown-render-fallback')).not.toBeInTheDocument();
    expect(screen.getByTestId('streamdown-rendered')).toBeInTheDocument();
  });
});

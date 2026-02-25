import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock Streamdown to throw — simulates chunk load failure or any rendering error
vi.mock('streamdown', () => ({
  Streamdown: () => {
    throw new Error('Failed to fetch dynamically imported module');
  },
}));

vi.mock('@streamdown/code', () => ({ code: {} }));
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
});

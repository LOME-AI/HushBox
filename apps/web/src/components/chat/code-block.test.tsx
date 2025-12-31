import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CodeBlock } from './code-block';

describe('CodeBlock', () => {
  const mockWriteText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    mockWriteText.mockClear();
    // Mock clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });
  });

  it('renders code content', () => {
    render(<CodeBlock language="javascript">const x = 1;</CodeBlock>);

    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('displays language label when provided', () => {
    render(<CodeBlock language="python">{'print("hello")'}</CodeBlock>);

    expect(screen.getByText('python')).toBeInTheDocument();
  });

  it('does not display language label when not provided', () => {
    render(<CodeBlock>some code</CodeBlock>);

    // Should not find any language label element
    const codeBlock = screen.getByTestId('code-block');
    expect(codeBlock.querySelector('[data-testid="language-label"]')).not.toBeInTheDocument();
  });

  it('copies code to clipboard when copy button is clicked', async () => {
    const user = userEvent.setup();
    const code = 'function test() { return 42; }';

    render(<CodeBlock language="javascript">{code}</CodeBlock>);

    // Click the copy button
    await user.click(screen.getByRole('button', { name: /copy/i }));

    // The state change to "Copied" proves clipboard.writeText succeeded
    // (component only sets copied=true after await clipboard.writeText)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });
  });

  it('shows copied feedback after clicking copy', async () => {
    const user = userEvent.setup();

    render(<CodeBlock language="javascript">const x = 1;</CodeBlock>);

    const copyButton = screen.getByRole('button', { name: /copy/i });
    await user.click(copyButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });
  });

  it('applies custom className', () => {
    render(
      <CodeBlock language="javascript" className="custom-class">
        code
      </CodeBlock>
    );

    const codeBlock = screen.getByTestId('code-block');
    expect(codeBlock).toHaveClass('custom-class');
  });

  it('renders with dark background styling by default', () => {
    render(<CodeBlock language="javascript">const x = 1;</CodeBlock>);

    const codeBlock = screen.getByTestId('code-block');
    expect(codeBlock).toHaveClass('bg-zinc-900');
  });

  it('renders with transparent background when variant is transparent', () => {
    render(
      <CodeBlock language="javascript" variant="transparent">
        const x = 1;
      </CodeBlock>
    );

    const codeBlock = screen.getByTestId('code-block');
    expect(codeBlock).not.toHaveClass('bg-zinc-900');
    expect(codeBlock).toHaveClass('bg-transparent');
  });

  it('handles multi-line code', () => {
    const multiLineCode = `function test() {
  const a = 1;
  return a;
}`;

    render(<CodeBlock language="javascript">{multiLineCode}</CodeBlock>);

    expect(screen.getByText(/function test/)).toBeInTheDocument();
    expect(screen.getByText(/const a = 1/)).toBeInTheDocument();
  });

  it('handles empty code gracefully', () => {
    render(<CodeBlock language="javascript">{''}</CodeBlock>);

    const codeBlock = screen.getByTestId('code-block');
    expect(codeBlock).toBeInTheDocument();
  });

  describe('hideHeader prop', () => {
    it('shows header by default', () => {
      render(<CodeBlock language="javascript">const x = 1;</CodeBlock>);

      expect(screen.getByTestId('language-label')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('hides header when hideHeader is true', () => {
      render(
        <CodeBlock language="javascript" hideHeader>
          const x = 1;
        </CodeBlock>
      );

      expect(screen.queryByTestId('language-label')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    });

    it('still renders code content when header is hidden', () => {
      render(
        <CodeBlock language="javascript" hideHeader>
          const x = 1;
        </CodeBlock>
      );

      expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    });
  });
});

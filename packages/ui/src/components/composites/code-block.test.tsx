import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CodeBlock } from './code-block';

const LINES = [
  { n: 12, text: 'const a = 1;' },
  { n: 13, text: 'const b = 2;' },
  { n: 14, text: 'return a + b;' },
];

describe('CodeBlock', () => {
  it('has data-slot attribute', () => {
    render(<CodeBlock lines={LINES} data-testid="block" />);

    expect(screen.getByTestId('block')).toHaveAttribute('data-slot', 'code-block');
  });

  it('renders every line of source text', () => {
    render(<CodeBlock lines={LINES} />);

    expect(screen.getByText('const a = 1;')).toBeInTheDocument();
    expect(screen.getByText('const b = 2;')).toBeInTheDocument();
    expect(screen.getByText('return a + b;')).toBeInTheDocument();
  });

  it('renders the line number of every line', () => {
    render(<CodeBlock lines={LINES} />);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
  });

  it('renders the code inside real pre and code elements', () => {
    const { container } = render(<CodeBlock lines={LINES} />);

    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('const a = 1;');
  });

  it('renders each line of source inside a code element', () => {
    render(<CodeBlock lines={LINES} />);

    expect(screen.getByText('const a = 1;').tagName).toBe('CODE');
  });

  it('renders each gutter number inside a code element', () => {
    render(<CodeBlock lines={LINES} />);

    expect(screen.getByText('12').tagName).toBe('CODE');
  });

  it('marks the highlighted line', () => {
    render(<CodeBlock lines={LINES} highlightLine={13} />);

    expect(screen.getByText('const b = 2;')).toHaveAttribute('data-highlighted', 'true');
  });

  it('leaves lines other than the highlighted one unmarked', () => {
    render(<CodeBlock lines={LINES} highlightLine={13} />);

    expect(screen.getByText('const a = 1;')).toHaveAttribute('data-highlighted', 'false');
  });

  it('marks no line when no highlight target is given', () => {
    render(<CodeBlock lines={LINES} />);

    expect(screen.getByText('const b = 2;')).toHaveAttribute('data-highlighted', 'false');
  });

  it('renders the path as a header when one is given', () => {
    render(<CodeBlock lines={LINES} path="apps/api/src/routes.ts" />);

    expect(screen.getByText('apps/api/src/routes.ts')).toBeInTheDocument();
  });

  it('omits the path header when no path is given', () => {
    const { container } = render(<CodeBlock lines={LINES} />);

    expect(container.querySelector('[data-slot="code-block-path"]')).toBeNull();
  });

  // Containment is a pair: the pre takes the horizontal scroll, the root clips so it
  // cannot reach the page. Whether it actually scrolls needs layout, so it belongs to
  // the live browser review, not here.
  it('declares the overflow containment pair that keeps long lines off the page', () => {
    const { container } = render(<CodeBlock lines={LINES} data-testid="block" />);

    expect(container.querySelector('pre')).toHaveClass('overflow-x-auto');
    expect(screen.getByTestId('block')).toHaveClass('overflow-hidden');
  });

  it('applies custom className', () => {
    render(<CodeBlock lines={LINES} className="custom-class" data-testid="block" />);

    expect(screen.getByTestId('block')).toHaveClass('custom-class');
  });

  it('renders no lines for an empty line list', () => {
    const { container } = render(<CodeBlock lines={[]} />);

    expect(container.querySelector('pre')).toBeEmptyDOMElement();
  });
});

const TOKENIZED = [
  {
    n: 12,
    text: [
      { text: 'const', kind: 'keyword' as const },
      { text: ' a = ', kind: null },
      { text: '1', kind: 'constant' as const },
    ],
  },
];

describe('CodeBlock, given tokenized lines', () => {
  it('renders the whole line of source', () => {
    const { container } = render(<CodeBlock lines={TOKENIZED} />);

    expect(container.querySelector('[data-slot="code-block-line"]')).toHaveTextContent(
      'const a = 1'
    );
  });

  it('colors a token through the theme token its kind names', () => {
    const { container } = render(<CodeBlock lines={TOKENIZED} />);

    expect(container.querySelector('[data-code-token="keyword"]')).toHaveClass('text-code-keyword');
  });

  it('leaves a token of no kind in the surrounding text color', () => {
    const { container } = render(<CodeBlock lines={TOKENIZED} />);

    expect(container.querySelector('[data-code-token="none"]')).not.toHaveAttribute('class');
  });

  it('still marks the highlighted line', () => {
    const { container } = render(<CodeBlock lines={TOKENIZED} highlightLine={12} />);

    expect(container.querySelector('[data-slot="code-block-line"]')).toHaveAttribute(
      'data-highlighted',
      'true'
    );
  });

  it('still numbers the line', () => {
    render(<CodeBlock lines={TOKENIZED} />);

    expect(screen.getByText('12')).toBeInTheDocument();
  });
});

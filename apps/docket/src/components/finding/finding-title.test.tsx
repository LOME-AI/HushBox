import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingTitle } from './finding-title';
import type { JSX } from 'react';

/**
 * Two titles of the same byte length, so a dependency on anything but the
 * markup itself — its length included — leaves the first one on screen.
 */
const FIRST_TITLE = 'the pool is torn down a little early';
const SECOND_TITLE = 'the lease outlives the claim it made';

describe('FindingTitle', () => {
  it('places the title as markup rather than as its source', () => {
    const { container } = render(<FindingTitle html="A bare <code>fetch</code> slips past" />);

    expect(container.querySelector('code')).toHaveTextContent('fetch');
    expect(container.textContent).not.toContain('`');
  });

  it('draws a code span in a title the same way wherever it is placed', () => {
    const { container: paragraph } = render(<FindingTitle html="a <code>fetch</code>" />);
    const { container: heading } = render(<FindingTitle as="h2" html="a <code>fetch</code>" />);

    expect(heading.firstElementChild?.className).toBe(paragraph.firstElementChild?.className);
  });

  it('renders the element the surface asked for', () => {
    render(<FindingTitle as="h2" html="a title" />);

    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('renders a paragraph when the surface asks for nothing', () => {
    const { container } = render(<FindingTitle html="a title" />);

    expect(container.firstElementChild?.tagName).toBe('P');
  });

  it('keeps the classes the surface needs alongside the shared ones', () => {
    const { container } = render(<FindingTitle className="line-clamp-2" html="a title" />);

    expect(container.firstElementChild?.className).toContain('line-clamp-2');
    expect(container.firstElementChild?.className).toContain('[&_code]:font-mono');
  });

  it('leaves the title it already placed alone when the surface re-renders around it', () => {
    function Host({ unrelated }: Readonly<{ unrelated: number }>): JSX.Element {
      return (
        <div>
          <span>{unrelated}</span>
          <FindingTitle html={`a <code>fetch</code> in ${FIRST_TITLE}`} />
        </div>
      );
    }

    const { container, rerender } = render(<Host unrelated={1} />);
    const code = container.querySelector('code');

    rerender(<Host unrelated={2} />);

    expect(container.querySelector('code')).toBe(code);
    expect(code?.isConnected).toBe(true);
  });

  it('places the title of the finding it is given now, not the one it was given before', () => {
    const { rerender } = render(<FindingTitle html={FIRST_TITLE} />);

    rerender(<FindingTitle html={SECOND_TITLE} />);

    expect(screen.getByText(SECOND_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(FIRST_TITLE)).toBeNull();
  });
});

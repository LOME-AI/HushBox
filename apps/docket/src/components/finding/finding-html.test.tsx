import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingHtml } from './finding-html';
import type { JSX } from 'react';

describe('FindingHtml', () => {
  it('renders the markup the server rendered', () => {
    render(<FindingHtml html="<p>the pool is torn down early</p>" />);

    expect(screen.getByText('the pool is torn down early')).toBeInTheDocument();
  });

  it('keeps a citation as the code element the peek layer looks for', () => {
    const { container } = render(
      <FindingHtml html='<p><code data-citation-path="apps/api/x.ts" data-citation-start="68" data-citation-end="68">apps/api/x.ts:68</code></p>' />
    );

    expect(container.querySelector('code[data-citation-path]')).not.toBeNull();
  });

  it('breaks a citation path that is wider than the column instead of letting it run off the edge', () => {
    const { container } = render(
      <FindingHtml html='<p><code data-citation-path="apps/api/x.ts">apps/api/x.ts:68</code></p>' />
    );

    expect(container.firstElementChild?.className).toContain(
      '[&_code[data-citation-path]]:break-words'
    );
  });

  it('marks a citation the console will not serve so it does not read as a live one', () => {
    const { container } = render(
      <FindingHtml html='<p><code data-citation-dead="">apps/api/x.ts:68</code> <span data-citation-note="">This path is not in the working tree.</span></p>' />
    );

    expect(container.firstElementChild?.className).toContain(
      '[&_code[data-citation-dead]]:line-through'
    );
  });

  it('renders the reason a citation was not served as prose the reader can read', () => {
    render(
      <FindingHtml html='<p><code data-citation-dead="">apps/api/x.ts:68</code> <span data-citation-note="">This path is not in the working tree.</span></p>' />
    );

    expect(screen.getByText('This path is not in the working tree.')).toBeInTheDocument();
  });

  it('leaves the prose it already placed alone when the shell re-renders around it', () => {
    function Host({ unrelated }: Readonly<{ unrelated: number }>): JSX.Element {
      return (
        <div>
          <span>{unrelated}</span>
          <FindingHtml html='<p><code data-citation-path="apps/api/x.ts">apps/api/x.ts:68</code> the pool is torn down early</p>' />
        </div>
      );
    }

    const { container, rerender } = render(<Host unrelated={1} />);
    const citation = container.querySelector('code[data-citation-path]');
    const paragraph = container.querySelector('p');

    rerender(<Host unrelated={2} />);

    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('code[data-citation-path]')).toBe(citation);
    expect(citation?.isConnected).toBe(true);
  });

  it('places the body of the finding it is given now, not the one it was given before', () => {
    const { rerender } = render(<FindingHtml html="<p>the pool is torn down early</p>" />);

    rerender(<FindingHtml html="<p>the lease outlives the claim</p>" />);

    expect(screen.getByText('the lease outlives the claim')).toBeInTheDocument();
    expect(screen.queryByText('the pool is torn down early')).toBeNull();
  });

  /**
   * This is the surface the reader spends the session inside, so it is sized as
   * a page of prose rather than as the metadata around it. Nothing here lays
   * anything out, so the utilities are the only observable form of both of these.
   */
  it('sets the body at a reading size rather than a metadata one', () => {
    const { container } = render(<FindingHtml html="<p>the pool is torn down early</p>" />);

    expect(container.firstElementChild?.className).toContain('text-base');
    expect(container.firstElementChild?.className).not.toContain('text-xs');
  });

  /**
   * A caller placing a secondary line through this placer needs it to read as
   * the metadata it is, so what the caller asks for settles the typography.
   */
  it('takes the typography a caller asks for over its own', () => {
    const { container } = render(
      <FindingHtml
        html="<p>the pool is torn down early</p>"
        className="text-muted-foreground text-sm"
      />
    );

    expect(container.firstElementChild?.className).toContain('text-sm');
    expect(container.firstElementChild?.className).toContain('text-muted-foreground');
    expect(container.firstElementChild?.className).not.toContain('text-base');
  });

  it('holds the body to no measure narrower than the column it is given', () => {
    const { container } = render(<FindingHtml html="<p>the pool is torn down early</p>" />);

    expect(container.firstElementChild?.className).not.toContain('max-w-');
  });

  it('renders nothing at all for an option that carries no prose', () => {
    const { container } = render(<FindingHtml html="" />);

    expect(container).toBeEmptyDOMElement();
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { ShareHead } from './share-head';

const TRUST_TEXT =
  "Decrypted in this browser with the key in your link. HushBox's servers never receive that key.";

function trustLine(): HTMLElement {
  const line = screen.getByText(TRUST_TEXT);
  if (line.tagName.toLowerCase() !== 'p') throw new Error('the trust line is not a paragraph');
  return line;
}

describe('ShareHead', () => {
  it('renders its title as the page heading', () => {
    render(<ShareHead title="Shared reply" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Shared reply' })).toBeInTheDocument();
  });

  it('renders exactly one heading', () => {
    render(<ShareHead title="Shared reply" meta="Shared by Alice" />);

    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('sets the title in the shared-page title role', () => {
    render(<ShareHead title="Shared reply" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('font-serif', 'text-share-title');
  });

  it('renders the meta line when given', () => {
    render(<ShareHead title="Shared conversation" meta="Shared by Alice" />);

    expect(screen.getByText('Shared by Alice')).toBeInTheDocument();
  });

  it('renders no meta line when none is given', () => {
    render(<ShareHead title="Shared reply" />);

    const head = screen.getByTestId(TEST_IDS.shareHead);
    expect(head.querySelectorAll('p')).toHaveLength(1);
    expect(head.querySelector('p')).toBe(trustLine());
  });

  it('renders the trust line text', () => {
    render(<ShareHead title="Shared reply" />);

    expect(trustLine()).toBeInTheDocument();
  });

  it('leads the trust line with its icon, on its first line', () => {
    render(<ShareHead title="Shared reply" />);

    const icon = trustLine().firstElementChild;
    expect(icon?.tagName.toLowerCase()).toBe('svg');
    expect(icon).toHaveClass('inline-block', 'text-success');
  });

  it('centres the trust line at the small UI size', () => {
    render(<ShareHead title="Shared reply" />);

    expect(trustLine()).toHaveClass('text-center', 'text-ui-sm');
  });

  it('omits the trust line when told the page decrypted nothing', () => {
    render(<ShareHead title="Shared reply" showTrustLine={false} />);

    expect(screen.queryByText(TRUST_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Shared reply' })).toBeInTheDocument();
  });

  it('centres the head', () => {
    render(<ShareHead title="Shared reply" />);

    expect(screen.getByTestId(TEST_IDS.shareHead)).toHaveClass('items-center', 'text-center');
  });
});

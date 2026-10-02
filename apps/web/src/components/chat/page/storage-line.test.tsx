import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { StorageLine } from './storage-line';

const ACCOUNT_COPY =
  'Saved encrypted with a key only your devices hold. AI providers retain nothing.';
const VISITOR_COPY = 'AI providers retain nothing · Sign up for encrypted storage';

function lineIn(): HTMLElement {
  const line = screen.getByTestId(TEST_IDS.storageLine).querySelector('p');
  if (line === null) throw new Error('the storage line draws no paragraph');
  return line;
}

describe('StorageLine', () => {
  it('tells an account its conversations are saved encrypted', () => {
    render(<StorageLine signedIn />);

    expect(lineIn().textContent).toBe(ACCOUNT_COPY);
  });

  it('leads the account line with the lock', () => {
    render(<StorageLine signedIn />);

    expect(lineIn().querySelector('svg')).toHaveClass('lucide-lock');
  });

  it('tells a visitor that signing up adds encrypted storage', () => {
    render(<StorageLine signedIn={false} />);

    expect(lineIn().textContent).toBe(VISITOR_COPY);
  });

  it('leads the visitor line with the shield', () => {
    render(<StorageLine signedIn={false} />);

    expect(lineIn().querySelector('svg')).toHaveClass('lucide-shield-check');
  });

  it('sets the line in the small ui size, centred', () => {
    render(<StorageLine signedIn />);

    expect(lineIn()).toHaveClass('text-ui-sm', 'text-center');
  });
});

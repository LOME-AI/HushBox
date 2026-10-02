import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChoiceLabel } from './choice-label';

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

function blockOf(text: string): HTMLElement {
  const block = screen.getByText(text).parentElement;
  if (block === null) throw new Error('the label has no block');
  return block;
}

describe('ChoiceLabel', () => {
  it('labels the control it names', () => {
    render(
      <>
        <input type="checkbox" id="remember" />
        <ChoiceLabel htmlFor="remember" label="Remember this device" disabled={false} />
      </>
    );

    expect(screen.getByRole('checkbox', { name: 'Remember this device' })).toBeInTheDocument();
  });

  it('sets the label muted at 0.875rem', () => {
    render(<ChoiceLabel htmlFor="remember" label="Remember this device" disabled={false} />);

    expect(tokens(screen.getByText('Remember this device'))).toEqual(
      expect.arrayContaining(['text-muted-foreground', 'text-sm'])
    );
  });

  it('shows a pointer over an enabled label', () => {
    render(<ChoiceLabel htmlFor="remember" label="Remember this device" disabled={false} />);

    expect(tokens(screen.getByText('Remember this device'))).toContain('cursor-pointer');
  });

  it('shows the not-allowed cursor over a disabled label', () => {
    render(<ChoiceLabel htmlFor="remember" label="Remember this device" disabled />);

    expect(tokens(screen.getByText('Remember this device'))).toContain('cursor-not-allowed');
  });

  it('dims the whole block while disabled', () => {
    render(<ChoiceLabel htmlFor="remember" label="Remember this device" disabled />);

    expect(tokens(blockOf('Remember this device'))).toContain('opacity-50');
  });

  it('leaves the block undimmed while enabled', () => {
    render(<ChoiceLabel htmlFor="remember" label="Remember this device" disabled={false} />);

    expect(tokens(blockOf('Remember this device'))).not.toContain('opacity-50');
  });

  it('draws the description under the label, muted at 0.75rem, under the id it is given', () => {
    render(
      <ChoiceLabel
        htmlFor="forfeit"
        label="Forfeit my balance"
        description="Any credit left in your account is lost."
        descriptionId="forfeit-description"
        disabled={false}
      />
    );
    const description = screen.getByText('Any credit left in your account is lost.');

    expect(description).toHaveAttribute('id', 'forfeit-description');
    expect(tokens(description)).toEqual(
      expect.arrayContaining(['text-muted-foreground', 'text-xs'])
    );
    expect(blockOf('Forfeit my balance')).toContainElement(description);
  });

  it('draws no description when none is given', () => {
    render(<ChoiceLabel htmlFor="remember" label="Remember this device" disabled={false} />);

    expect(blockOf('Remember this device').children).toHaveLength(1);
  });
});

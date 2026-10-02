import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { InlineInput } from './inline-input';

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

describe('InlineInput', () => {
  it('is named by its aria-label', () => {
    render(<InlineInput aria-label="Search members" />);

    expect(screen.getByRole('textbox', { name: 'Search members' })).toBeInTheDocument();
  });

  it('is named by the element its aria-labelledby points at', () => {
    render(
      <>
        <span id="column-name">Amount</span>
        <InlineInput aria-labelledby="column-name" />
      </>
    );

    expect(screen.getByRole('textbox', { name: 'Amount' })).toBeInTheDocument();
  });

  it('rejects an input with no accessible name', () => {
    // An input no one can name must not compile, so the directive is the assertion.
    // @ts-expect-error -- an aria-label or aria-labelledby is required
    render(<InlineInput />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('draws its 1px border in the control border colour', () => {
    render(<InlineInput aria-label="Search members" />);

    const classes = tokens(screen.getByRole('textbox'));
    expect(classes).toEqual(expect.arrayContaining(['border', 'border-border-control']));
    expect(classes).not.toContain('border-input');
  });

  it('keeps the simple input height and radius', () => {
    render(<InlineInput aria-label="Search members" />);

    expect(tokens(screen.getByRole('textbox'))).toEqual(
      expect.arrayContaining(['h-9', 'rounded-md'])
    );
  });

  it('grows to the touch target height on a coarse pointer', () => {
    render(<InlineInput aria-label="Search members" />);

    expect(tokens(screen.getByRole('textbox'))).toContain('pointer-coarse:min-h-11');
  });

  it('turns its border red on keyboard focus', () => {
    render(<InlineInput aria-label="Search members" />);

    expect(tokens(screen.getByRole('textbox'))).toContain('focus-visible:border-ring');
  });

  it('leaves the shared focus outline to draw', () => {
    render(<InlineInput aria-label="Search members" />);

    const outlineTokens = tokens(screen.getByRole('textbox')).filter((token) =>
      token.includes('outline')
    );
    expect(outlineTokens).toEqual([]);
  });

  it('draws a destructive border when marked invalid', () => {
    render(<InlineInput aria-label="Amount" aria-invalid />);

    expect(tokens(screen.getByRole('textbox'))).toContain('aria-invalid:border-destructive');
  });

  it('shows its placeholder in muted ink', () => {
    render(<InlineInput aria-label="Search members" placeholder="Search members" />);

    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('placeholder', 'Search members');
    expect(tokens(input)).toContain('placeholder:text-muted-foreground');
  });

  it('hands onChange the native change event', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(event: React.ChangeEvent<HTMLInputElement>) => void>();
    render(<InlineInput aria-label="Search members" onChange={onChange} />);

    await user.type(screen.getByRole('textbox'), 'a');

    expect(onChange.mock.calls[0]?.[0].target.value).toBe('a');
  });

  it('adds the caller class', () => {
    render(<InlineInput aria-label="Search members" className="w-40" />);

    expect(tokens(screen.getByRole('textbox'))).toContain('w-40');
  });

  it('hands the ref to the input', () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<InlineInput aria-label="Search members" ref={ref} />);

    expect(ref.current).toBe(screen.getByRole('textbox'));
  });
});

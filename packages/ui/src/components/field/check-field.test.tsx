import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { HIT_AREA_CLASSES } from '../button/icon-button';
import { CheckField } from './check-field';

function noop(): void {
  /* the handler a render-only case needs */
}

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

describe('CheckField', () => {
  it('names the checkbox by its label', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Keep me signed in" />);

    expect(screen.getByRole('checkbox', { name: 'Keep me signed in' })).toBeInTheDocument();
  });

  it('reports its checked state to assistive technology', () => {
    render(<CheckField checked onCheckedChange={noop} label="Keep me signed in" />);

    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles when its label is clicked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <CheckField checked={false} onCheckedChange={onCheckedChange} label="Keep me signed in" />
    );

    await user.click(screen.getByText('Keep me signed in'));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('toggles from the keyboard with Space', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<CheckField checked onCheckedChange={onCheckedChange} label="Keep me signed in" />);

    act(() => {
      screen.getByRole('checkbox').focus();
    });
    await user.keyboard(' ');

    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('describes the checkbox by its description', () => {
    render(
      <CheckField
        checked={false}
        onCheckedChange={noop}
        label="Forfeit my balance"
        description="Any credit left in your account is lost."
      />
    );

    expect(screen.getByRole('checkbox')).toHaveAccessibleDescription(
      'Any credit left in your account is lost.'
    );
  });

  it('carries no description when none is given', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Keep me signed in" />);

    expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-describedby');
  });

  it('places its test id on the checkbox, not the row', () => {
    render(
      <CheckField
        testId={TEST_IDS.deleteAccountForfeitCheckbox}
        checked={false}
        onCheckedChange={noop}
        label="Forfeit my balance"
      />
    );

    expect(screen.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox)).toHaveAttribute(
      'role',
      'checkbox'
    );
  });

  it('uses the id it is given for the checkbox', () => {
    render(
      <CheckField id="keep-signed-in" checked={false} onCheckedChange={noop} label="Keep me" />
    );

    expect(screen.getByRole('checkbox')).toHaveAttribute('id', 'keep-signed-in');
  });

  it('centres the checkbox on the whole label block, with no margin nudge', () => {
    render(
      <CheckField
        checked={false}
        onCheckedChange={noop}
        label="Forfeit my balance"
        description="Any credit left in your account is lost."
      />
    );
    const control = screen.getByRole('checkbox');
    const row = control.parentElement;
    if (row === null) throw new Error('the checkbox has no row');

    expect(tokens(row)).toContain('items-center');
    expect(tokens(control).filter((token) => /^-?m[tby]?-/.test(token))).toEqual([]);
  });

  it('draws the 1rem box by default', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Remember" />);

    expect(tokens(screen.getByRole('checkbox'))).toContain('size-4');
  });

  it('draws the 24px box at size lg', () => {
    render(<CheckField size="lg" checked={false} onCheckedChange={noop} label="Remember" />);

    const control = screen.getByRole('checkbox');
    expect(tokens(control)).toContain('size-6');
    expect(tokens(control)).not.toContain('size-4');
  });

  it('extends the checkbox to a 2.75rem target on a coarse pointer', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Remember" />);

    expect(screen.getByRole('checkbox')).toHaveClass(...HIT_AREA_CLASSES.extend.split(' '));
  });

  it('extends the 24px box to the same target on a coarse pointer', () => {
    render(<CheckField size="lg" checked={false} onCheckedChange={noop} label="Remember" />);

    expect(screen.getByRole('checkbox')).toHaveClass(...HIT_AREA_CLASSES.extend.split(' '));
  });

  it('stands its row at least 2.75rem tall on a coarse pointer', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Remember" />);
    const row = screen.getByRole('checkbox').parentElement;
    if (row === null) throw new Error('the checkbox has no row');

    expect(tokens(row)).toContain('pointer-coarse:min-h-11');
  });

  it('sets no minimum row height for a fine pointer', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Remember" />);
    const row = screen.getByRole('checkbox').parentElement;
    if (row === null) throw new Error('the checkbox has no row');

    expect(tokens(row).filter((token) => token.startsWith('min-h-'))).toEqual([]);
  });

  it('draws its box on the control border', () => {
    render(<CheckField checked={false} onCheckedChange={noop} label="Remember" />);

    const control = screen.getByRole('checkbox');
    expect(tokens(control)).toContain('border-border-control');
    expect(tokens(control)).not.toContain('border-input');
  });

  it('disables the checkbox', () => {
    render(<CheckField disabled checked={false} onCheckedChange={noop} label="Remember" />);

    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('ignores a click on its label while disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <CheckField disabled checked={false} onCheckedChange={onCheckedChange} label="Remember" />
    );

    await user.click(screen.getByText('Remember'));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('dims its label block while disabled', () => {
    render(<CheckField disabled checked={false} onCheckedChange={noop} label="Remember" />);
    const block = screen.getByText('Remember').parentElement;
    if (block === null) throw new Error('the label has no block');

    expect(tokens(block)).toContain('opacity-50');
  });
});

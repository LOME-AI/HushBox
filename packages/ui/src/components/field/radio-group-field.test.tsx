import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RadioGroupField } from './radio-group-field';

type Period = 'monthly' | 'lifetime' | 'weekly';

const OPTIONS = [
  { value: 'monthly', label: 'Monthly', description: 'Resets on the first of each month.' },
  { value: 'lifetime', label: 'Lifetime' },
  { value: 'weekly', label: 'Weekly', disabled: true },
] as const satisfies readonly {
  value: Period;
  label: string;
  description?: string;
  disabled?: boolean;
}[];

function noop(): void {
  /* the handler a render-only case needs */
}

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

function renderField(onValueChange: (value: Period) => void = noop): void {
  render(
    <RadioGroupField<Period>
      legend="Budget period"
      value="monthly"
      onValueChange={onValueChange}
      options={OPTIONS}
    />
  );
}

describe('RadioGroupField', () => {
  it('groups its options in a fieldset named by the legend', () => {
    renderField();

    expect(screen.getByRole('group', { name: 'Budget period' }).tagName).toBe('FIELDSET');
  });

  it('names the radio group by the legend', () => {
    renderField();

    expect(screen.getByRole('radiogroup', { name: 'Budget period' })).toBeInTheDocument();
  });

  it('names each radio by its option label', () => {
    renderField();

    expect(screen.getByRole('radio', { name: 'Lifetime' })).toBeInTheDocument();
  });

  it('checks the radio for the current value', () => {
    renderField();

    expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked();
  });

  it('reports the option whose label is clicked', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderField(onValueChange);

    await user.click(screen.getByText('Lifetime'));

    expect(onValueChange).toHaveBeenCalledWith('lifetime');
  });

  it('moves the choice with the arrow keys', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderField(onValueChange);

    act(() => {
      screen.getByRole('radio', { name: 'Monthly' }).focus();
    });
    // Held, because the group moves focus a task later and checks what it lands on
    // only while an arrow key is down, as a person's key still is.
    await user.keyboard('{ArrowDown>}');

    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalledWith('lifetime');
    });
  });

  it('describes a radio by its option description', () => {
    renderField();

    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveAccessibleDescription(
      'Resets on the first of each month.'
    );
  });

  it('describes nothing on an option without a description', () => {
    renderField();

    expect(screen.getByRole('radio', { name: 'Lifetime' })).not.toHaveAttribute('aria-describedby');
  });

  it('disables an option marked disabled', () => {
    renderField();

    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeDisabled();
  });

  it('dims a disabled option label block', () => {
    renderField();
    const block = screen.getByText('Weekly').parentElement;
    if (block === null) throw new Error('the label has no block');

    expect(tokens(block)).toContain('opacity-50');
  });

  it('centres each radio on its whole label block, with no margin nudge', () => {
    renderField();

    for (const radio of screen.getAllByRole('radio')) {
      const row = radio.parentElement;
      if (row === null) throw new Error('the radio has no row');
      expect(tokens(row)).toContain('items-center');
      expect(tokens(radio).filter((token) => /^-?m[tby]?-/.test(token))).toEqual([]);
    }
  });

  it('draws each radio on the control border', () => {
    renderField();

    for (const radio of screen.getAllByRole('radio')) {
      expect(tokens(radio)).toContain('border-border-control');
      expect(tokens(radio)).not.toContain('border-input');
    }
  });
});

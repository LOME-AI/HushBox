import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { DecisionFields } from './decision-fields';
import type { DecisionFieldsProps } from './decision-fields';

function renderFields(overrides: Partial<DecisionFieldsProps> = {}): {
  onRule: ReturnType<typeof vi.fn>;
  onDeny: ReturnType<typeof vi.fn>;
  onDrafting: ReturnType<typeof vi.fn>;
  onDedicated: ReturnType<typeof vi.fn>;
  rerender: (next: Partial<DecisionFieldsProps>) => void;
} {
  const onRule = vi.fn();
  const onDeny = vi.fn();
  const onDrafting = vi.fn();
  const onDedicated = vi.fn();
  const props = {
    canDeny: true,
    focused: null,
    dedicated: false,
    onRule,
    onDeny,
    onDrafting,
    onDedicated,
    ...overrides,
  };
  const view = render(<DecisionFields {...props} />);
  return {
    onRule,
    onDeny,
    onDrafting,
    onDedicated,
    rerender: (next) => {
      view.rerender(<DecisionFields {...props} {...next} />);
    },
  };
}

function write(label: string, text: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

describe('DecisionFields', () => {
  it('carries both boxes with nothing clicked to reveal them', () => {
    renderFields();

    expect(screen.getAllByTestId(TEST_IDS.promptInput)).toHaveLength(2);
  });

  it('rules in the reader’s own words', () => {
    const { onRule } = renderFields();

    write('Rule in your own words', 'ship it behind the flag');
    fireEvent.click(screen.getByRole('button', { name: 'Rule' }));

    expect(onRule).toHaveBeenCalledWith('ship it behind the flag');
  });

  it('denies with the reason that was written', () => {
    const { onDeny } = renderFields();

    write('Reason for denying', 'the audit misread the code');
    fireEvent.click(screen.getByRole('button', { name: 'Deny with this reason' }));

    expect(onDeny).toHaveBeenCalledWith('the audit misread the code');
  });

  /** Refusing a finding is not always explicable, and a forced sentence is an empty one. */
  it('denies without one, because a denial does not owe an explanation', () => {
    const { onDeny } = renderFields();

    fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));

    expect(onDeny).toHaveBeenCalledWith(null);
  });

  it('withholds the denial from a finding that is already denied', () => {
    renderFields({ canDeny: false });

    expect(screen.queryByLabelText('Reason for denying')).toBeNull();
    expect(screen.getByLabelText('Rule in your own words')).toBeInTheDocument();
  });

  it('takes the caret to the ruling when the keyboard asks for it', () => {
    renderFields({ focused: { field: 'rule', at: 1 } });

    expect(screen.getByLabelText('Rule in your own words')).toHaveFocus();
  });

  it('takes the caret to the denial when the keyboard asks for it', () => {
    renderFields({ focused: { field: 'deny', at: 1 } });

    expect(screen.getByLabelText('Reason for denying')).toHaveFocus();
  });

  it('reports which box is carrying words nobody has sent', () => {
    const { onDrafting } = renderFields();

    write('Reason for denying', 'the audit misread the code');

    expect(onDrafting).toHaveBeenLastCalledWith('deny', true);
  });

  it('reports the ruling box separately from the denial', () => {
    const { onDrafting } = renderFields();

    write('Rule in your own words', 'ship it behind the flag');

    expect(onDrafting).toHaveBeenLastCalledWith('rule', true);
  });

  it('offers the mark beside the decisions it is not part of', () => {
    renderFields();

    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).not.toBeChecked();
  });

  it('opens checked where the finding or its chosen option says so', () => {
    renderFields({ dedicated: true });

    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).toBeChecked();
  });

  it('reports the mark the reader set', () => {
    const { onDedicated } = renderFields();

    fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));

    expect(onDedicated).toHaveBeenCalledWith(true);
  });

  it('reports a proposal the reader turned down', () => {
    const { onDedicated } = renderFields({ dedicated: true });

    fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));

    expect(onDedicated).toHaveBeenCalledWith(false);
  });

  /**
   * The mark is the card's and this box only shows it, so it follows wherever
   * the card moves it — a ruling on an option carrying the marker moves it.
   * Whether the card re-seeds when the mark moves is the card's own guard.
   */
  it('shows the mark it is handed rather than one of its own', () => {
    const { rerender } = renderFields();

    rerender({ dedicated: true });

    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).toBeChecked();
  });
});

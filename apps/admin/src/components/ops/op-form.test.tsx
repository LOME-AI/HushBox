import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LABELLED_FIELD_CLASSES } from '@hushbox/ui/field';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { describeOpFields } from '@/lib/op-fields';
import { OpForm } from './op-form.js';
import type { OpFieldDescriptor } from '@/lib/op-fields';

const WALLET_FIELDS = describeOpFields('wallet.credit', []);
const LOCK_FIELDS = describeOpFields('user.lock', []);
const BANNER_FIELDS = describeOpFields('banner.set', []);
/** A boolean whose contract refuses the untouched switch, so submitting surfaces its error. */
const CONFIRM_FIELDS: readonly OpFieldDescriptor[] = [
  { name: 'confirmed', required: true, control: 'boolean', schema: z.literal(true) },
];
const UUID = '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40';

function messageRow(index: number): HTMLElement {
  return screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', index));
}

/** The element a selector finds, failing the test when there is none. */
function present(selector: string): Element {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`nothing matches ${selector}`);
  return element;
}

/** The field error line a control's description points at, or null when none does. */
function errorDescribing(control: HTMLElement): Element | null {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(' ');
  for (const id of ids) {
    const line = document
      .querySelector(`[id="${id}"]`)
      ?.querySelector(`[data-testid="${TEST_IDS.adminOpFieldError}"]`);
    if (line !== null && line !== undefined) return line;
  }
  return null;
}

/** The optionality marker a control carries, or null when it carries none. */
function optionalMarker(control: HTMLElement): string | null {
  const describedBy = control.getAttribute('aria-describedby');
  if (describedBy === null) {
    return null;
  }
  return document.querySelector(`[id="${describedBy}"]`)?.textContent ?? null;
}

/** Maps each descriptor to the marker it carries, and to the marker it should
 * carry — both derived from the contract, never from a hand-written roster. */
function markerComparison(
  fields: readonly OpFieldDescriptor[],
  controlOf: (field: OpFieldDescriptor) => HTMLElement
): {
  readonly actual: Record<string, string | null>;
  readonly expected: Record<string, string | null>;
} {
  return {
    actual: Object.fromEntries(
      fields.map((field) => [field.name, optionalMarker(controlOf(field))])
    ),
    expected: Object.fromEntries(
      fields.map((field) => [field.name, field.required ? null : 'optional'])
    ),
  };
}

/** A marker test proves a distinction only when its fixture holds both classes. */
function expectBothClassesPresent(expected: Record<string, string | null>): void {
  expect(Object.values(expected)).toContain('optional');
  expect(Object.values(expected)).toContain(null);
}

describe('OpForm', () => {
  it('renders a labeled control per field with reason last', () => {
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} />);
    const form = screen.getByTestId(TEST_IDS.adminOpForm);
    const inputs = form.querySelectorAll('input');
    expect(inputs).toHaveLength(3);
    expect(screen.getByLabelText('walletId')).toBeInTheDocument();
    expect(screen.getByLabelText('amountNanoUsd')).toBeInTheDocument();
    expect(screen.getByLabelText('reason')).toBeInTheDocument();
    expect([...inputs].at(-1)).toHaveAttribute('name', 'reason');
  });

  it('renders enum fields as a select with the contract options', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={LOCK_FIELDS} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'lockReason' }));
    expect(screen.getByRole('option', { name: 'chargeback' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'admin' })).toBeInTheDocument();
  });

  it('submits a selected enum value with the rest of the input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={LOCK_FIELDS} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('userId'), UUID);
    await user.click(screen.getByRole('combobox', { name: 'lockReason' }));
    await user.click(screen.getByRole('option', { name: 'chargeback' }));
    await user.type(screen.getByLabelText('reason'), 'lock for dispute');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      userId: UUID,
      lockReason: 'chargeback',
      reason: 'lock for dispute',
    });
  });

  it('submits the built wire input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={WALLET_FIELDS} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('walletId'), UUID);
    await user.type(screen.getByLabelText('amountNanoUsd'), '5000000000');
    await user.type(screen.getByLabelText('reason'), 'test credit');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      walletId: UUID,
      amountNanoUsd: '5000000000',
      reason: 'test credit',
    });
  });

  it('blocks submit and shows field errors for invalid values', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={WALLET_FIELDS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByTestId(TEST_IDS.adminOpFieldError).length).toBeGreaterThan(0);
  });

  it('renders a number control and submits its value as a number', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <OpForm fields={[{ name: 'count', required: true, control: 'number' }]} onSubmit={onSubmit} />
    );
    const input = screen.getByLabelText('count');
    expect(input).toHaveAttribute('type', 'number');
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(onSubmit).toHaveBeenCalledWith({ count: 3 });
  });

  it('renders an enum descriptor without options as an empty select', async () => {
    const user = userEvent.setup();
    render(
      <OpForm fields={[{ name: 'mode', required: true, control: 'enum' }]} onSubmit={vi.fn()} />
    );
    await user.click(screen.getByRole('combobox', { name: 'mode' }));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('prefills initial values', () => {
    render(
      <OpForm
        fields={WALLET_FIELDS}
        initialValues={{ walletId: UUID, amountNanoUsd: '1', reason: 'undo' }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByLabelText('walletId')).toHaveValue(UUID);
    expect(screen.getByLabelText('reason')).toHaveValue('undo');
  });

  it('disables the submit button while pending', () => {
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} pending />);
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
  });

  it('renders a boolean field as a labeled switch that is off by default', () => {
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);
    const toggle = screen.getByRole('switch', { name: 'enabled' });
    expect(toggle).toHaveAttribute('data-testid', TEST_ID_BUILDERS.adminOpBooleanToggle('enabled'));
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
  });

  it('toggles a boolean field and submits it as true', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    await user.type(screen.getByLabelText('reason'), 'toggle banner');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({ enabled: true, messages: [], reason: 'toggle banner' });
  });

  it('renders a group with exactly one trailing empty row', () => {
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminOpGroup('messages'))).toBeInTheDocument();
    expect(messageRow(0)).toBeInTheDocument();
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('grows a new trailing empty row when the user types into the last row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First message');

    expect(messageRow(1)).toBeInTheDocument();
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('');
  });

  it('shows a delete button on filled rows but not the trailing empty row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First message');

    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowDelete('messages', 0))
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRowDelete('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('removes a row when its delete button is clicked', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'Doomed row');
    await user.click(screen.getByRole('button', { name: 'Remove messages row 1' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('');
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('submits group rows as the exact contract payload, dropping the trailing empty row', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Maintenance at noon');
    await user.type(within(messageRow(0)).getByLabelText('href'), 'https://status.hushbox.ai');
    await user.type(screen.getByLabelText('reason'), 'announce maintenance');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { variant: 'warning', text: 'Maintenance at noon', href: 'https://status.hushbox.ai' },
      ],
      reason: 'announce maintenance',
    });
  });

  it('shows per-sub-field errors for a partially filled row instead of dropping it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(screen.getByLabelText('reason'), 'partial row');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
  });

  it('moves a row up, swapping full row values, and submits the new order', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Second');
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.click(screen.getByRole('button', { name: 'Move messages row 2 up' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Second');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');

    await user.type(screen.getByLabelText('reason'), 'reorder');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(onSubmit).toHaveBeenCalledWith({
      enabled: false,
      messages: [
        { variant: 'warning', text: 'Second' },
        { variant: 'info', text: 'First' },
      ],
      reason: 'reorder',
    });
  });

  it('moves a row down, swapping full row values', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Second');
    await user.click(screen.getByRole('button', { name: 'Move messages row 1 down' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Second');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');
  });

  it('disables move up on the first row and move down on the last filled row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Second');

    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 0))
    ).toBeDisabled();
    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 0))
    ).toBeEnabled();
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 1))).toBeEnabled();
    expect(
      screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 1))
    ).toBeDisabled();
  });

  it('renders no move controls on the trailing empty row', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');

    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', 1))
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', 1))
    ).not.toBeInTheDocument();
  });

  it('prepends an empty row, shifting existing rows down intact, and focuses its first control', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'First');
    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');
    // The row object's first sub-field control receives focus.
    expect(within(messageRow(0)).getByRole('combobox', { name: 'variant' })).toHaveFocus();
  });

  it('submits a typed-into prepended row first in the payload', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'Old first');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));
    await user.type(within(messageRow(0)).getByLabelText('text'), 'New first');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.type(screen.getByLabelText('reason'), 'prepend');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: false,
      messages: [
        { variant: 'warning', text: 'New first' },
        { variant: 'info', text: 'Old first' },
      ],
      reason: 'prepend',
    });
  });

  it('keeps a displayed row error on its row when the row moves', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    // Row 0 valid, row 1 missing its required text — submit surfaces the error.
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Valid');
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'critical' }));
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(screen.getByLabelText('reason'), 'errors follow');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );

    await user.click(screen.getByRole('button', { name: 'Move messages row 2 up' }));

    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
    expect(within(messageRow(1)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();

    // And back down: the error rides the row in both directions.
    await user.click(screen.getByRole('button', { name: 'Move messages row 1 down' }));
    expect(within(messageRow(0)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
  });

  it('keeps a displayed row error on its row when a row is prepended', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(screen.getByLabelText('reason'), 'errors follow');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));

    expect(within(messageRow(0)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'This field is required.'
    );
  });

  it('reorders prefilled rows and submits them in the new order', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <OpForm
        fields={BANNER_FIELDS}
        initialValues={{
          enabled: true,
          messages: [
            { variant: 'info', text: 'A' },
            { variant: 'warning', text: 'B' },
          ],
          reason: 'undo',
        }}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Move messages row 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { variant: 'warning', text: 'B' },
        { variant: 'info', text: 'A' },
      ],
      reason: 'undo',
    });
  });

  it('reorders then prepends prefilled rows and submits the new order', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <OpForm
        fields={BANNER_FIELDS}
        initialValues={{
          enabled: true,
          messages: [
            { variant: 'warning', text: 'First', href: 'https://status.hushbox.ai', linkText: 'S' },
            { variant: 'critical', text: 'Edited' },
          ],
        }}
        onSubmit={onSubmit}
      />
    );

    // Move row 1 up (swaps the two filled rows).
    await user.click(screen.getByRole('button', { name: 'Move messages row 2 up' }));
    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Edited');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('First');

    // Prepend a fresh row at the front and fill it.
    await user.click(screen.getByRole('button', { name: 'Add messages row at the front' }));
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Third');

    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Third');
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('Edited');
    expect(within(messageRow(2)).getByLabelText('text')).toHaveValue('First');

    await user.type(screen.getByLabelText('reason'), 'reorder and prepend');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(onSubmit).toHaveBeenCalledWith({
      enabled: true,
      messages: [
        { variant: 'info', text: 'Third' },
        { variant: 'critical', text: 'Edited' },
        { variant: 'warning', text: 'First', href: 'https://status.hushbox.ai', linkText: 'S' },
      ],
      reason: 'reorder and prepend',
    });
  });

  it('leaves an error on an unaffected row when other rows move', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    // Rows 0 and 2 miss their required text; rows 1 and 2 then swap.
    await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(messageRow(1)).getByLabelText('text'), 'Valid');
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.click(within(messageRow(2)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'critical' }));
    await user.type(screen.getByLabelText('reason'), 'unaffected row');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Move messages row 3 up' }));

    expect(within(messageRow(0)).getByTestId(TEST_IDS.adminOpFieldError)).toBeInTheDocument();
    expect(within(messageRow(1)).getByTestId(TEST_IDS.adminOpFieldError)).toBeInTheDocument();
    expect(within(messageRow(2)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
  });

  it('neither submits nor validates when a row delete button is clicked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={onSubmit} />);

    await user.type(within(messageRow(0)).getByLabelText('text'), 'Doomed row');
    await user.click(screen.getByRole('button', { name: 'Remove messages row 1' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId(TEST_IDS.adminOpFieldError)).toHaveLength(0);
  });

  it('drops the deleted row errors and shifts later row errors down on delete', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    // Row 0 misses variant (its error must stay put); row 1 misses text (its
    // error dies with it); row 2 misses variant (its error must follow the
    // row up to index 1).
    await user.type(within(messageRow(0)).getByLabelText('text'), 'Above');
    await user.click(within(messageRow(1)).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'warning' }));
    await user.type(within(messageRow(2)).getByLabelText('text'), 'Keeper');
    await user.type(screen.getByLabelText('reason'), 'delete remap');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(screen.getByRole('button', { name: 'Remove messages row 2' }));

    const aboveErrors = within(messageRow(0)).getAllByTestId(TEST_IDS.adminOpFieldError);
    expect(aboveErrors).toHaveLength(1);
    expect(errorDescribing(within(messageRow(0)).getByLabelText('variant'))).toBe(aboveErrors[0]);
    const keeperErrors = within(messageRow(1)).getAllByTestId(TEST_IDS.adminOpFieldError);
    expect(keeperErrors).toHaveLength(1);
    expect(errorDescribing(within(messageRow(1)).getByLabelText('variant'))).toBe(keeperErrors[0]);
    expect(within(messageRow(2)).queryByTestId(TEST_IDS.adminOpFieldError)).not.toBeInTheDocument();
  });

  it('renders a group descriptor without sub-fields as a bare empty row', () => {
    render(
      <OpForm fields={[{ name: 'rows', required: true, control: 'group' }]} onSubmit={vi.fn()} />
    );
    const row = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('rows', 0));
    expect(row.querySelectorAll('input')).toHaveLength(0);
  });

  it('prepends on a group without sub-fields without moving focus', async () => {
    const user = userEvent.setup();
    render(
      <OpForm fields={[{ name: 'rows', required: true, control: 'group' }]} onSubmit={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: 'Add rows row at the front' }));

    // No first control exists to focus; the empty rows still stack up.
    expect(screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('rows', 1))).toBeInTheDocument();
  });

  it('treats a group-shaped initial value on a scalar field as untouched', () => {
    render(
      <OpForm
        fields={[{ name: 'note', required: false, control: 'text' }]}
        initialValues={{ note: [] }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByLabelText('note')).toHaveValue('');
  });

  it('prefills group rows and booleans from initial values', () => {
    render(
      <OpForm
        fields={BANNER_FIELDS}
        initialValues={{
          enabled: true,
          messages: [{ variant: 'info', text: 'Restored', href: '' }],
          reason: 'undo',
        }}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByRole('switch', { name: 'enabled' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    expect(within(messageRow(0)).getByLabelText('text')).toHaveValue('Restored');
    // The prefilled list still gets its trailing empty row.
    expect(within(messageRow(1)).getByLabelText('text')).toHaveValue('');
  });
  it('marks exactly the top-level fields the contract declares optional', () => {
    const fields = describeOpFields('payment.forceExpire', []);
    render(<OpForm fields={fields} onSubmit={vi.fn()} />);

    const { actual, expected } = markerComparison(fields, (field) =>
      screen.getByLabelText(field.name)
    );
    expectBothClassesPresent(expected);
    expect(actual).toStrictEqual(expected);
  });

  it('marks exactly the group sub-fields the contract declares optional', () => {
    const group = BANNER_FIELDS.find((field) => field.control === 'group');
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    const row = messageRow(0);
    const { actual, expected } = markerComparison(group?.fields ?? [], (field) =>
      within(row).getByLabelText(field.name)
    );
    expectBothClassesPresent(expected);
    expect(actual).toStrictEqual(expected);
  });

  it('marks a group field the contract declares optional', () => {
    render(<OpForm fields={describeOpFields('twoFactor.clearStranded', [])} onSubmit={vi.fn()} />);

    expect(optionalMarker(screen.getByRole('group', { name: 'keys' }))).toBe('optional');
  });

  it('leaves a group field the contract declares required unmarked', () => {
    render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

    expect(optionalMarker(screen.getByRole('group', { name: 'messages' }))).toBeNull();
  });

  it('floats each text field label inside its box, after the input', () => {
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} />);
    const input = screen.getByLabelText('walletId');
    const label = present('label[for="op-field-walletId"]');
    expect(input.compareDocumentPosition(label)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the op-field id on a choice trigger', () => {
    render(<OpForm fields={LOCK_FIELDS} onSubmit={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'lockReason' })).toHaveAttribute(
      'id',
      'op-field-lockReason'
    );
  });

  it('asks the operator to select a value on an unchosen choice list', () => {
    render(<OpForm fields={LOCK_FIELDS} onSubmit={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'lockReason' })).toHaveTextContent(
      'Select a value'
    );
  });

  it('writes the optional marker under the control it describes', () => {
    const fields = describeOpFields('payment.forceExpire', []);
    render(<OpForm fields={fields} onSubmit={vi.fn()} />);
    const optionalField = fields.find((field) => !field.required);
    const control = screen.getByLabelText(optionalField?.name ?? '');
    const markerId = control.getAttribute('aria-describedby') ?? '';
    const marker = present(`[id="${markerId}"]`);
    expect(control.compareDocumentPosition(marker)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('marks a refused text field invalid', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(screen.getByLabelText('walletId')).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks a refused choice list invalid', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={LOCK_FIELDS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(screen.getByRole('combobox', { name: 'lockReason' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('shows each field error once, on the error line the test id names', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={WALLET_FIELDS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    const lines = screen.getAllByTestId(TEST_IDS.adminOpFieldError);
    expect(screen.getAllByText('This field is required.')).toStrictEqual(lines);
  });

  it('marks a refused switch invalid', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={CONFIRM_FIELDS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(screen.getByRole('switch', { name: 'confirmed' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('shows a refused switch error on the field error line', async () => {
    const user = userEvent.setup();
    render(<OpForm fields={CONFIRM_FIELDS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(screen.getByTestId(TEST_IDS.adminOpFieldError)).toHaveAttribute('role', 'alert');
  });

  it("shows a group's own error on the field error line", async () => {
    const user = userEvent.setup();
    const fields: readonly OpFieldDescriptor[] = [
      {
        name: 'rows',
        required: true,
        control: 'group',
        schema: z.array(z.unknown()).min(1, 'Add at least one row.'),
        fields: [{ name: 'text', required: true, control: 'text' }],
      },
    ];
    render(<OpForm fields={fields} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(screen.getByTestId(TEST_IDS.adminOpFieldError)).toHaveTextContent(
      'Add at least one row.'
    );
  });

  describe('a group row', () => {
    /** Every control a keyboard reaches in message row 0, beside the row's own buttons. */
    function rowControls(): HTMLElement[] {
      const row = messageRow(0);
      return [...within(row).getAllByRole('combobox'), ...within(row).getAllByRole('textbox')];
    }

    /** A control's height classes, reading a `data-[size=…]:` variant as its own size's. */
    function heightClasses(control: HTMLElement): string[] {
      const sizePrefix = `data-[size=${control.dataset['size'] ?? ''}]:`;
      return control.className
        .split(' ')
        .map((token) => (token.startsWith(sizePrefix) ? token.slice(sizePrefix.length) : token))
        .filter((token) => /^h-\d/.test(token));
    }

    /** The label element that names a control, found through its label relation. */
    function labelOf(control: HTMLElement): HTMLElement {
      const labelledBy = control.getAttribute('aria-labelledby');
      const label =
        labelledBy === null
          ? document.querySelector(`label[for="${control.id}"]`)
          : document.querySelector(`[id="${labelledBy}"]`);
      if (!(label instanceof HTMLElement)) throw new Error(`no label names ${control.id}`);
      return label;
    }

    it('draws every control at the choice trigger height', () => {
      render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

      const heights = rowControls().map((control) => heightClasses(control));
      expect(heights).toStrictEqual(heights.map(() => ['h-9']));
    });

    it('sets every control label above its control', () => {
      render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

      const placements = rowControls().map((control) =>
        labelOf(control).compareDocumentPosition(control)
      );
      expect(placements).toStrictEqual(placements.map(() => Node.DOCUMENT_POSITION_FOLLOWING));
    });

    it('draws every control label with the shared field label classes', () => {
      render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

      const looks = rowControls().map((control) => labelOf(control).className);
      expect(looks).toStrictEqual(looks.map(() => LABELLED_FIELD_CLASSES.label));
    });

    it('marks a refused text control invalid', async () => {
      const user = userEvent.setup();
      render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);

      await user.click(within(messageRow(0)).getByRole('combobox', { name: 'variant' }));
      await user.click(screen.getByRole('option', { name: 'info' }));
      await user.click(screen.getByRole('button', { name: 'Preview changes' }));

      expect(within(messageRow(0)).getByLabelText('text')).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe("a group's own name and error", () => {
    const CAPPED_GROUP: readonly OpFieldDescriptor[] = [
      {
        name: 'rows',
        required: true,
        control: 'group',
        schema: z.array(z.unknown()).min(1, 'Add at least one row.'),
        fields: [{ name: 'text', required: true, control: 'text' }],
      },
    ];

    it('ends the group at its last row while no error shows', () => {
      render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);
      const group = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroup('messages'));

      expect(group.lastElementChild).toBe(messageRow(0));
    });

    it('draws the group name with the shared field label classes', () => {
      render(<OpForm fields={BANNER_FIELDS} onSubmit={vi.fn()} />);
      const group = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroup('messages'));

      expect(within(group).getByText('messages').className).toBe(LABELLED_FIELD_CLASSES.label);
    });

    it("describes the group by its error's message row", async () => {
      const user = userEvent.setup();
      render(<OpForm fields={CAPPED_GROUP} onSubmit={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: 'Preview changes' }));

      const group = screen.getByRole('group', { name: 'rows' });
      const line = screen.getByTestId(TEST_IDS.adminOpFieldError);
      expect(group.getAttribute('aria-describedby')?.split(' ')).toContain(line.parentElement?.id);
    });
  });
});

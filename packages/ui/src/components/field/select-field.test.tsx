import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { SelectField } from './select-field';
import { PortalContainerProvider } from '../primitives/portal-container';

type Font = 'merriweather' | 'atkinson' | 'lexend';

const OPTIONS = [
  { value: 'merriweather', label: 'Merriweather (default)' },
  { value: 'atkinson', label: 'Atkinson Hyperlegible (low vision)' },
  { value: 'lexend', label: 'Lexend (reading speed)' },
] as const satisfies readonly { value: Font; label: string }[];

function noop(): void {
  /* the handler a render-only case needs */
}

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

function renderField(
  extra: {
    help?: string;
    error?: string;
    disabled?: boolean;
    labelHidden?: boolean;
    triggerTestId?: string;
    id?: string;
    errorTestId?: string;
  } = {},
  onValueChange: (value: Font) => void = noop
): void {
  render(
    <SelectField<Font>
      label="Font"
      value="merriweather"
      onValueChange={onValueChange}
      options={OPTIONS}
      {...extra}
    />
  );
}

describe('SelectField', () => {
  it('names the select by its label', () => {
    renderField();

    expect(screen.getByRole('combobox', { name: 'Font' })).toBeInTheDocument();
  });

  it('puts the label above the select', () => {
    renderField();

    expect(screen.getByText('Font').compareDocumentPosition(screen.getByRole('combobox'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('sets the label at 0.875rem and weight 500', () => {
    renderField();

    expect(tokens(screen.getByText('Font'))).toEqual(
      expect.arrayContaining(['text-sm', 'font-medium'])
    );
  });

  it('shows the label of the current value', () => {
    renderField();

    expect(screen.getByRole('combobox')).toHaveTextContent('Merriweather (default)');
  });

  it('reports the option chosen from the keyboard', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderField({}, onValueChange);

    await user.tab();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('atkinson');
  });

  it('describes the select by its help line', () => {
    renderField({ help: 'Applies to reading surfaces.' });

    expect(screen.getByRole('combobox')).toHaveAccessibleDescription(
      'Applies to reading surfaces.'
    );
  });

  it('puts the help line below the select', () => {
    renderField({ help: 'Applies to reading surfaces.' });

    expect(
      screen
        .getByRole('combobox')
        .compareDocumentPosition(screen.getByText('Applies to reading surfaces.'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('announces its error as an alert', () => {
    renderField({ error: 'Choose a font.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a font.');
  });

  it('reports invalid while it holds an error', () => {
    renderField({ error: 'Choose a font.' });

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('describes the select by its error', () => {
    renderField({ error: 'Choose a font.' });

    expect(screen.getByRole('combobox')).toHaveAccessibleDescription('Choose a font.');
  });

  it('is not invalid without an error', () => {
    renderField();

    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-invalid');
  });

  it('describes nothing without help or an error', () => {
    renderField();

    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-describedby');
  });

  it('draws the select on the control border', () => {
    renderField();
    const control = screen.getByRole('combobox');

    expect(tokens(control)).toContain('border-border-control');
    expect(tokens(control)).not.toContain('border-input');
  });

  it('fills the width of its field', () => {
    renderField();

    expect(tokens(screen.getByRole('combobox'))).toContain('w-full');
  });

  it('grows to the touch height on a coarse pointer', () => {
    renderField();

    expect(tokens(screen.getByRole('combobox'))).toContain('pointer-coarse:min-h-11');
  });

  it('is enabled by default', () => {
    renderField();

    expect(screen.getByRole('combobox')).toBeEnabled();
  });

  it('disables the select when disabled, so it draws dimmed with the not-allowed cursor', () => {
    renderField({ disabled: true });
    const control = screen.getByRole('combobox');

    expect(control).toBeDisabled();
    expect(tokens(control)).toEqual(
      expect.arrayContaining(['disabled:opacity-50', 'disabled:cursor-not-allowed'])
    );
  });

  it('opens no list while disabled', async () => {
    const user = userEvent.setup();
    renderField({ disabled: true });

    await user.click(screen.getByRole('combobox'));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows its label by default', () => {
    renderField();

    expect(tokens(screen.getByText('Font'))).not.toContain('sr-only');
  });

  it('hides a hidden label visually', () => {
    renderField({ labelHidden: true });

    expect(tokens(screen.getByText('Font'))).toContain('sr-only');
  });

  it('names the select by a hidden label', () => {
    render(
      <SelectField<Font>
        label="Model"
        labelHidden
        value="merriweather"
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument();
  });

  it('keeps a hidden label as a label element for the select', () => {
    renderField({ labelHidden: true });
    const label = screen.getByText('Font');

    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', screen.getByRole('combobox').id);
  });

  it('puts its trigger test id on the select', () => {
    renderField({ triggerTestId: 'model-filter' });

    expect(screen.getByTestId('model-filter')).toBe(screen.getByRole('combobox'));
  });

  it('puts no test id on the select by default', () => {
    renderField();

    expect(screen.getByRole('combobox')).not.toHaveAttribute('data-testid');
  });

  it('reports no choice from the keyboard while disabled', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderField({ disabled: true }, onValueChange);

    await user.tab();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('sets the caller id on the trigger', () => {
    renderField({ id: 'op-field-font' });

    expect(screen.getByRole('combobox', { name: 'Font' })).toHaveAttribute('id', 'op-field-font');
  });

  it('names the help line after the caller id', () => {
    renderField({ id: 'op-field-font', help: 'optional' });

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-describedby', 'op-field-font-help');
  });

  it('shows the placeholder while no value is chosen', () => {
    render(
      <SelectField<Font | ''>
        label="Font"
        value=""
        placeholder="Select a value"
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('Select a value');
  });

  it('puts the error test id on the error line', () => {
    renderField({ error: 'Choose a font', errorTestId: 'field-error' });

    expect(screen.getByTestId('field-error')).toBe(screen.getByRole('alert'));
  });

  it('shows its trigger text in the select in place of the chosen label', () => {
    render(
      <SelectField<Font>
        label="Font"
        value="merriweather"
        triggerText="Merriweather"
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    expect(screen.getByRole('combobox')).toHaveTextContent(/^Merriweather$/);
  });

  it('keeps every full label in the list while it shows a trigger text', async () => {
    const user = userEvent.setup();
    render(
      <SelectField<Font>
        label="Font"
        value="merriweather"
        triggerText="Merriweather"
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Merriweather (default)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Lexend (reading speed)' })).toBeInTheDocument();
  });

  it('places the chosen label where a trigger-text function puts the value', () => {
    render(
      <SelectField<Font>
        label="Font"
        value="merriweather"
        triggerText={(value) => <span data-testid="frame">{value}</span>}
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    expect(screen.getByTestId('frame')).toHaveTextContent('Merriweather (default)');
  });

  it('anchors the list to the value a trigger-text function places, not to its frame', () => {
    render(
      <SelectField<Font>
        label="Font"
        value="merriweather"
        triggerText={(value) => <span data-testid="frame">{value}</span>}
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    expect(
      screen.getByTestId('frame').querySelector('[data-slot="select-value"]')
    ).toBeInTheDocument();
  });

  it('draws the small trigger when asked for the small size', () => {
    render(
      <SelectField<Font>
        label="Font"
        size="sm"
        value="merriweather"
        onValueChange={noop}
        options={OPTIONS}
      />
    );

    expect(screen.getByRole('combobox')).toHaveAttribute('data-size', 'sm');
  });

  it('draws the default trigger when no size is given', () => {
    renderField();

    expect(screen.getByRole('combobox')).toHaveAttribute('data-size', 'default');
  });

  it('draws an option label given as markup', async () => {
    const user = userEvent.setup();
    render(
      <SelectField<Font>
        label="Font"
        value="merriweather"
        onValueChange={noop}
        options={[
          { value: 'merriweather', label: <span className="font-mono">merriweather</span> },
          { value: 'lexend', label: <span className="font-mono">lexend</span> },
        ]}
      />
    );

    await user.click(screen.getByRole('combobox'));
    expect(
      screen.getByRole('option', { name: 'lexend' }).querySelector('.font-mono')
    ).toHaveTextContent('lexend');
  });
});

function portalTarget(): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  onTestFinished(() => {
    target.remove();
  });
  return target;
}

describe('SelectField portal', () => {
  it('portals its list into the element its provider gives', async () => {
    const user = userEvent.setup();
    const target = portalTarget();
    render(
      <PortalContainerProvider container={target}>
        <SelectField<Font>
          label="Font"
          value="merriweather"
          onValueChange={noop}
          options={OPTIONS}
        />
      </PortalContainerProvider>
    );

    await user.click(screen.getByRole('combobox'));

    expect(target).toContainElement(screen.getByRole('listbox'));
  });
});

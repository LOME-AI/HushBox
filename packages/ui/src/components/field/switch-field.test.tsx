import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { SwitchField } from './switch-field';

function noop(): void {
  /* the handler a render-only case needs */
}

function tokens(element: Element): string[] {
  return element.className.split(/\s+/);
}

function rowOf(control: HTMLElement): HTMLElement {
  const row = control.parentElement;
  if (row === null) throw new Error('the switch has no row');
  return row;
}

describe('SwitchField', () => {
  it('names the switch by its label', () => {
    render(<SwitchField checked={false} onCheckedChange={noop} label="Email notifications" />);

    expect(screen.getByRole('switch', { name: 'Email notifications' })).toBeInTheDocument();
  });

  it('reports its state to assistive technology', () => {
    render(<SwitchField checked onCheckedChange={noop} label="Email notifications" />);

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles when its label is clicked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <SwitchField checked={false} onCheckedChange={onCheckedChange} label="Email notifications" />
    );

    await user.click(screen.getByText('Email notifications'));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('toggles from the keyboard with Space', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<SwitchField checked onCheckedChange={onCheckedChange} label="Email notifications" />);

    act(() => {
      screen.getByRole('switch').focus();
    });
    await user.keyboard(' ');

    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('describes the switch by its description', () => {
    render(
      <SwitchField
        checked={false}
        onCheckedChange={noop}
        label="Email notifications"
        description="A message when a long reply finishes."
      />
    );

    expect(screen.getByRole('switch')).toHaveAccessibleDescription(
      'A message when a long reply finishes.'
    );
  });

  it('carries no description when none is given', () => {
    render(<SwitchField checked={false} onCheckedChange={noop} label="Email notifications" />);

    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-describedby');
  });

  it('places its test id on the switch, not the row', () => {
    const testId = TEST_ID_BUILDERS.adminOpBooleanToggle('enabled');
    render(<SwitchField testId={testId} checked={false} onCheckedChange={noop} label="Enabled" />);

    expect(screen.getByTestId(testId)).toHaveAttribute('role', 'switch');
  });

  it('uses the id it is given for the switch', () => {
    render(<SwitchField id="op-field-enabled" checked={false} onCheckedChange={noop} label="On" />);

    expect(screen.getByRole('switch')).toHaveAttribute('id', 'op-field-enabled');
  });

  it('puts the switch after the label block in DOM order', () => {
    render(
      <SwitchField
        checked={false}
        onCheckedChange={noop}
        label="Email notifications"
        description="A message when a long reply finishes."
      />
    );
    const control = screen.getByRole('switch');
    const children = [...rowOf(control).children];

    expect(children.indexOf(control)).toBe(children.length - 1);
    expect(children[0]).toContainElement(screen.getByText('Email notifications'));
  });

  it('draws the switch at the end of the row, with no reordering', () => {
    render(<SwitchField checked={false} onCheckedChange={noop} label="Email notifications" />);
    const control = screen.getByRole('switch');
    const row = rowOf(control);
    const reorders = (element: Element): string[] =>
      tokens(element).filter((token) => /^(order-|flex-row-reverse|flex-col-reverse)/.test(token));

    expect(tokens(row)).toContain('justify-between');
    expect([...reorders(row), ...reorders(control)]).toEqual([]);
  });

  it('centres the switch on the whole label block, with no margin nudge', () => {
    render(
      <SwitchField
        checked={false}
        onCheckedChange={noop}
        label="Email notifications"
        description="A message when a long reply finishes."
      />
    );
    const control = screen.getByRole('switch');

    expect(tokens(rowOf(control))).toContain('items-center');
    expect(tokens(control).filter((token) => /^-?m[tby]?-/.test(token))).toEqual([]);
  });

  it('transitions no outline property, so the focus outline appears at once', () => {
    render(<SwitchField checked={false} onCheckedChange={noop} label="Email notifications" />);
    const transitions = tokens(screen.getByRole('switch')).filter((token) =>
      token.startsWith('transition')
    );
    const properties = transitions.flatMap((token) => {
      const list = /^transition-\[(.+)\]$/.exec(token)?.[1];
      return list === undefined ? [token] : list.split(',');
    });

    expect(properties.length).toBeGreaterThan(0);
    expect(
      properties.filter((property) =>
        /outline|^all$|^transition$|^transition-(all|colors)$/.test(property)
      )
    ).toEqual([]);
  });

  it('disables the switch', () => {
    render(<SwitchField disabled checked={false} onCheckedChange={noop} label="Enabled" />);

    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('ignores a click on its label while disabled', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <SwitchField disabled checked={false} onCheckedChange={onCheckedChange} label="Enabled" />
    );

    await user.click(screen.getByText('Enabled'));

    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('dims its label block while disabled', () => {
    render(<SwitchField disabled checked={false} onCheckedChange={noop} label="Enabled" />);
    const block = screen.getByText('Enabled').parentElement;
    if (block === null) throw new Error('the label has no block');

    expect(tokens(block)).toContain('opacity-50');
  });

  it('keeps its own text sizes and gap by default', () => {
    render(
      <SwitchField
        checked={false}
        onCheckedChange={noop}
        label="Email notifications"
        description="A message when a long reply finishes."
      />
    );
    const label = screen.getByText('Email notifications');
    const description = screen.getByText('A message when a long reply finishes.');

    expect(tokens(label)).toContain('text-sm');
    expect(tokens(description)).toContain('text-sm');
    expect(tokens(label.parentElement ?? label)).toContain('gap-1');
  });

  it('draws its label at a settings row title size when asked', () => {
    render(
      <SwitchField
        settingsRow
        checked={false}
        onCheckedChange={noop}
        label="Sound"
        description="A chime."
      />
    );
    const label = screen.getByText('Sound');

    expect(tokens(label)).toEqual(expect.arrayContaining(['text-ui', 'font-medium']));
    expect(tokens(label)).not.toContain('text-sm');
  });

  it('draws its description at a settings row description size when asked', () => {
    render(
      <SwitchField
        settingsRow
        checked={false}
        onCheckedChange={noop}
        label="Sound"
        description="A chime."
      />
    );
    const description = screen.getByText('A chime.');

    expect(tokens(description)).toContain('text-ui-sm');
    expect(tokens(description)).not.toContain('text-sm');
  });

  it('sets a settings row gap between label and description when asked', () => {
    render(
      <SwitchField
        settingsRow
        checked={false}
        onCheckedChange={noop}
        label="Sound"
        description="A chime."
      />
    );
    const block = screen.getByText('Sound').parentElement;
    if (block === null) throw new Error('the label has no block');

    expect(tokens(block)).toContain('gap-0.5');
    expect(tokens(block)).not.toContain('gap-1');
  });

  describe('with an error', () => {
    it('announces the error under the switch row', () => {
      render(
        <SwitchField checked={false} onCheckedChange={noop} label="Enabled" error="Turn it on" />
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Turn it on');
      expect(rowOf(screen.getByRole('switch')).compareDocumentPosition(alert)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('marks the switch invalid', () => {
      render(
        <SwitchField checked={false} onCheckedChange={noop} label="Enabled" error="Turn it on" />
      );

      expect(screen.getByRole('switch')).toHaveAttribute('aria-invalid', 'true');
    });

    it('describes the switch by the error row after its description', () => {
      render(
        <SwitchField
          id="enabled"
          checked={false}
          onCheckedChange={noop}
          label="Enabled"
          description="optional"
          error="Turn it on"
        />
      );

      expect(screen.getByRole('switch')).toHaveAttribute(
        'aria-describedby',
        'enabled-description enabled-message'
      );
    });

    it('puts the error test id on the error line', () => {
      render(
        <SwitchField
          checked={false}
          onCheckedChange={noop}
          label="Enabled"
          error="Turn it on"
          errorTestId="field-error"
        />
      );

      expect(screen.getByTestId('field-error')).toBe(screen.getByRole('alert'));
    });
  });

  describe('without an error', () => {
    it('draws no message row', () => {
      const { container } = render(
        <SwitchField checked={false} onCheckedChange={noop} label="Enabled" errorTestId="x" />
      );

      expect(container.firstElementChild).toBe(rowOf(screen.getByRole('switch')));
    });

    it('leaves the switch valid', () => {
      render(<SwitchField checked={false} onCheckedChange={noop} label="Enabled" />);

      expect(screen.getByRole('switch')).not.toHaveAttribute('aria-invalid');
    });
  });
});

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@hushbox/ui/button';
import { Check } from '@hushbox/ui/icons';
import { SettingsRow } from '@/components/settings/settings-row';
import { SettingsStatusBadge } from '@/components/settings/settings-status-badge';

describe('SettingsRow, navigate', () => {
  it('hands its ref the row button', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<SettingsRow kind="navigate" title="Change Password" onClick={vi.fn()} ref={ref} />);

    expect(ref.current).toBe(screen.getByRole('button', { name: 'Change Password' }));
  });

  it('is one button named by its title', () => {
    render(
      <SettingsRow
        kind="navigate"
        title="Change Password"
        description="Update your account password"
        onClick={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument();
  });

  it('describes the button with its description', () => {
    render(
      <SettingsRow
        kind="navigate"
        title="Change Password"
        description="Update your account password"
        onClick={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Change Password' })).toHaveAccessibleDescription(
      'Update your account password'
    );
  });

  it('adds its badge to the description, so the status is announced', () => {
    render(
      <SettingsRow
        kind="navigate"
        title="Two-Factor Authentication"
        description="Add an extra layer of security"
        badge={<SettingsStatusBadge status="Disabled" />}
        onClick={vi.fn()}
      />
    );

    expect(
      screen.getByRole('button', { name: 'Two-Factor Authentication' })
    ).toHaveAccessibleDescription('Add an extra layer of security Disabled');
  });

  it('is described by its badge alone when it has no description', () => {
    render(
      <SettingsRow
        kind="navigate"
        title="Recovery Phrase"
        badge={<SettingsStatusBadge status="Enabled" />}
        onClick={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Recovery Phrase' })).toHaveAccessibleDescription(
      'Enabled'
    );
  });

  it('carries no description reference when it has neither description nor badge', () => {
    render(<SettingsRow kind="navigate" title="Change Password" onClick={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Change Password' })).not.toHaveAttribute(
      'aria-describedby'
    );
  });

  it('calls onClick when pressed', async () => {
    const onClick = vi.fn();
    render(<SettingsRow kind="navigate" title="Change Password" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is a plain button, never a submit', () => {
    render(<SettingsRow kind="navigate" title="Change Password" onClick={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Change Password' })).toHaveAttribute(
      'type',
      'button'
    );
  });

  it('draws the chevron after the badge', () => {
    render(
      <SettingsRow
        kind="navigate"
        title="Recovery Phrase"
        badge={<SettingsStatusBadge status="Enabled" />}
        onClick={vi.fn()}
      />
    );

    const trailing = screen.getByText('Enabled').closest('[data-settings-trailing]');
    expect(trailing?.lastElementChild?.tagName.toLowerCase()).toBe('svg');
  });

  it('centres its trailing items on the text block', () => {
    render(<SettingsRow kind="navigate" title="Change Password" onClick={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Change Password' })).toHaveClass(
      'flex',
      'items-center'
    );
  });

  it('carries its test id', () => {
    render(
      <SettingsRow kind="navigate" title="Change Password" testId="row-id" onClick={vi.fn()} />
    );

    expect(screen.getByTestId('row-id')).toBe(
      screen.getByRole('button', { name: 'Change Password' })
    );
  });
});

describe('SettingsRow, toggle', () => {
  it('names its switch by the row title', () => {
    render(
      <SettingsRow kind="toggle" title="Mailing list" checked={false} onCheckedChange={vi.fn()} />
    );

    expect(screen.getByRole('switch', { name: 'Mailing list' })).toBeInTheDocument();
  });

  it('describes its switch by the row description', () => {
    render(
      <SettingsRow
        kind="toggle"
        title="Sound"
        description="Plays a short chime."
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );

    expect(screen.getByRole('switch', { name: 'Sound' })).toHaveAccessibleDescription(
      'Plays a short chime.'
    );
  });

  it('places the switch after the text', () => {
    render(<SettingsRow kind="toggle" title="Sound" checked={false} onCheckedChange={vi.fn()} />);

    const label = screen.getByText('Sound');
    const control = screen.getByRole('switch', { name: 'Sound' });
    expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sets its title and description at the sizes every row takes', () => {
    render(
      <SettingsRow
        kind="toggle"
        title="Sound"
        description="Plays a short chime."
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );

    expect(screen.getByText('Sound')).toHaveClass('text-ui', 'font-medium');
    expect(screen.getByText('Plays a short chime.')).toHaveClass('text-ui-sm');
    expect(screen.getByText('Sound').parentElement).toHaveClass('gap-0.5');
  });

  it('styles the switch field through its own prop, not its markup', () => {
    render(<SettingsRow kind="toggle" title="Sound" checked={false} onCheckedChange={vi.fn()} />);

    const wrapper = screen.getByText('Sound').closest('[data-settings-row]')?.firstElementChild;
    expect(wrapper?.className).not.toContain('[&_');
  });

  it('reports the new state when switched', async () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingsRow kind="toggle" title="Sound" checked={false} onCheckedChange={onCheckedChange} />
    );

    await userEvent.click(screen.getByRole('switch', { name: 'Sound' }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('shows the state it is given', () => {
    render(<SettingsRow kind="toggle" title="Sound" checked onCheckedChange={vi.fn()} />);

    expect(screen.getByRole('switch', { name: 'Sound' })).toBeChecked();
  });

  it('disables its switch when asked', () => {
    render(
      <SettingsRow kind="toggle" title="Sound" checked={false} disabled onCheckedChange={vi.fn()} />
    );

    expect(screen.getByRole('switch', { name: 'Sound' })).toBeDisabled();
  });

  it('puts the switch test id on the switch', () => {
    render(
      <SettingsRow
        kind="toggle"
        title="Sound"
        checked={false}
        switchTestId="sound-switch"
        testId="sound-row"
        onCheckedChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('sound-switch')).toBe(screen.getByRole('switch', { name: 'Sound' }));
    expect(screen.getByTestId('sound-row')).toContainElement(screen.getByTestId('sound-switch'));
  });
});

describe('SettingsRow, link', () => {
  it('is a link named by its title', () => {
    render(<SettingsRow kind="link" title="Terms of Service" onOpen={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('calls onOpen when pressed', async () => {
    const onOpen = vi.fn();
    render(<SettingsRow kind="link" title="Terms of Service" external onOpen={onOpen} />);

    await userEvent.click(screen.getByRole('link', { name: 'Terms of Service' }));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows the external-link icon when the target is external', () => {
    render(<SettingsRow kind="link" title="Terms of Service" external onOpen={vi.fn()} />);

    expect(
      screen
        .getByRole('link', { name: 'Terms of Service' })
        .querySelector('svg.lucide-external-link')
    ).not.toBeNull();
  });

  it('shows no icon when the target is in the app', () => {
    render(<SettingsRow kind="link" title="Usage" onOpen={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Usage' }).querySelector('svg')).toBeNull();
  });

  it('describes the link with its description', () => {
    render(
      <SettingsRow kind="link" title="Usage" description="Spending by model." onOpen={vi.fn()} />
    );

    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAccessibleDescription(
      'Spending by model.'
    );
  });
});

describe('SettingsRow, value', () => {
  it('shows its value at the right of the text', () => {
    render(<SettingsRow kind="value" title="Username" value="alice" />);

    const value = screen.getByText('alice');
    expect(value.closest('[data-settings-trailing]')).not.toBeNull();
    expect(
      screen.getByText('Username').compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('is no control', () => {
    render(<SettingsRow kind="value" title="Username" value="alice" />);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows its description under the title', () => {
    render(
      <SettingsRow
        kind="value"
        title="Email"
        description="alice@hushbox.ai"
        value={<SettingsStatusBadge status="Verified" icon={Check} />}
      />
    );

    expect(screen.getByText('alice@hushbox.ai')).toHaveClass('text-muted-foreground');
  });
});

describe('SettingsRow, action', () => {
  it('renders the foundation Button it is given', () => {
    render(
      <SettingsRow
        kind="action"
        description="Permanently delete your account and all associated data."
        action={
          <Button variant="destructive" block>
            Delete Account
          </Button>
        }
      />
    );

    expect(screen.getByRole('button', { name: 'Delete Account' })).toHaveAttribute(
      'data-slot',
      'button'
    );
  });

  it('draws no title when it has none', () => {
    const { container } = render(
      <SettingsRow kind="action" description="Delete it." action={<Button>Delete</Button>} />
    );

    expect(screen.getByText('Delete it.')).toBeInTheDocument();
    expect(container.querySelector('[data-settings-title]')).toBeNull();
  });

  it('puts the button on a line of its own under the text', () => {
    render(<SettingsRow kind="action" title="Recovery" action={<Button>Save phrase</Button>} />);

    const actionCell = screen.getByRole('button', { name: 'Save phrase' }).parentElement;
    expect(actionCell).toHaveClass('flex-[1_0_100%]');
    expect(actionCell).not.toHaveClass('md:flex-none');
  });

  it('keeps the stacked button on its own line at every width', () => {
    render(<SettingsRow kind="action" title="Recovery" action={<Button>Save phrase</Button>} />);

    const row = screen.getByText('Recovery').closest('[data-settings-row]');
    expect(row).toHaveClass('flex-wrap');
    expect(row).not.toHaveClass('md:flex-nowrap');
  });

  it('moves an inline button onto the text line from 768', () => {
    render(
      <SettingsRow
        kind="action"
        title="Recovery"
        inline
        action={<Button block>Save phrase</Button>}
      />
    );

    const row = screen.getByText('Recovery').closest('[data-settings-row]');
    const actionCell = screen.getByRole('button', { name: 'Save phrase' }).parentElement;
    expect(row).toHaveClass('flex-wrap', 'md:flex-nowrap', 'items-center');
    expect(actionCell).toHaveClass('flex-[1_0_100%]', 'md:flex-none');
  });

  it('sizes an inline button from the list width', () => {
    render(
      <SettingsRow kind="action" title="Recovery" inline action={<Button block>Save</Button>} />
    );

    expect(screen.getByRole('button', { name: 'Save' }).parentElement).toHaveClass(
      'md:[&>*]:w-[calc(7rem_+_clamp(0rem,(100cqw_-_var(--btn-full-max))_*_1e5,5rem))]!'
    );
  });

  it('draws its icon before the text', () => {
    render(
      <SettingsRow
        kind="action"
        title="Recovery phrase not saved"
        icon={<span data-testid="row-icon" />}
        action={<Button>Save phrase</Button>}
      />
    );

    const icon = screen.getByTestId('row-icon');
    expect(
      icon.compareDocumentPosition(screen.getByText('Recovery phrase not saved')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(icon.parentElement).toHaveClass('flex-none');
  });

  it('carries its test id on the row', () => {
    render(
      <SettingsRow
        kind="action"
        title="Recovery"
        testId="recovery-row"
        action={<Button>Save phrase</Button>}
      />
    );

    expect(screen.getByTestId('recovery-row')).toContainElement(
      screen.getByRole('button', { name: 'Save phrase' })
    );
  });
});

describe('SettingsRow, text block', () => {
  it('sets the title in the UI face at medium weight', () => {
    render(<SettingsRow kind="value" title="Username" value="alice" />);

    expect(screen.getByText('Username')).toHaveClass('text-ui', 'font-medium', 'text-foreground');
  });

  it('sets the description one step smaller, muted', () => {
    render(<SettingsRow kind="value" title="Email" description="a@b.c" value="x" />);

    expect(screen.getByText('a@b.c')).toHaveClass('text-ui-sm', 'text-muted-foreground');
  });

  it('is taller when it carries a description', () => {
    render(
      <>
        <SettingsRow kind="value" title="Username" value="alice" />
        <SettingsRow kind="value" title="Email" description="a@b.c" value="x" />
      </>
    );

    expect(screen.getByText('Username').closest('[data-settings-row]')).toHaveClass('min-h-14');
    expect(screen.getByText('Email').closest('[data-settings-row]')).toHaveClass('min-h-16');
  });
});

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Menu } from './menu';
import { MenuRadioGroup } from './menu-radio-group';
import { MenuRadioItem } from './menu-radio-item';
import { DESKTOP, PHONE, installViewport, restoreViewport } from './menu-viewport.setup';

afterEach(() => {
  restoreViewport();
});

type Effort = 'auto' | 'mid' | 'max';

function EffortMenu({
  onValueChange = vi.fn(),
  label,
}: Readonly<{
  onValueChange?: (value: Effort) => void;
  label?: string;
}>): React.JSX.Element {
  return (
    <Menu
      trigger={<button type="button">Effort</button>}
      title="Reasoning effort"
      sheetHeader="none"
    >
      <MenuRadioGroup<Effort>
        value="mid"
        onValueChange={onValueChange}
        {...(label !== undefined && { label })}
      >
        <MenuRadioItem<Effort>
          value="auto"
          title="Auto"
          description="The model decides for each message"
        />
        <MenuRadioItem<Effort> value="mid" title="Mid" description="Most everyday questions" />
        <MenuRadioItem<Effort>
          value="max"
          title="Max"
          disabled
          disabledReason="This model can't write a long enough answer."
        />
      </MenuRadioGroup>
    </Menu>
  );
}

async function openEffort(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Effort' }));
  await screen.findByRole('menu');
  return user;
}

/**
 * Clicks an item. In a sheet it is a bare click: vaul's release handler reads a computed transform
 * the test DOM never provides, and throws on a pointer release inside the sheet.
 */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  item: HTMLElement,
  width: number
): Promise<void> {
  if (width === PHONE) fireEvent.click(item);
  else await user.click(item);
}

describe.each([
  ['a sheet', PHONE],
  ['an anchored menu', DESKTOP],
])('MenuRadioGroup in %s', (_presentation, width) => {
  it('renders each item as a menuitemradio', async () => {
    installViewport(width);
    render(<EffortMenu />);

    await openEffort();

    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
  });

  it('marks the chosen value checked', async () => {
    installViewport(width);
    render(<EffortMenu />);

    await openEffort();

    expect(screen.getByRole('menuitemradio', { name: 'Mid' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('marks the other values unchecked', async () => {
    installViewport(width);
    render(<EffortMenu />);

    await openEffort();

    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('calls onValueChange with the chosen value', async () => {
    installViewport(width);
    const onValueChange = vi.fn();
    render(<EffortMenu onValueChange={onValueChange} />);
    const user = await openEffort();

    await choose(user, screen.getByRole('menuitemradio', { name: 'Auto' }), width);

    expect(onValueChange).toHaveBeenCalledWith('auto');
  });

  it('closes after a value is chosen', async () => {
    installViewport(width);
    render(<EffortMenu />);
    const user = await openEffort();

    await choose(user, screen.getByRole('menuitemradio', { name: 'Auto' }), width);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Effort', hidden: true })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });
  });

  it('does not choose a disabled value', async () => {
    installViewport(width);
    const onValueChange = vi.fn();
    render(<EffortMenu onValueChange={onValueChange} />);
    const user = await openEffort();

    await choose(user, screen.getByRole('menuitemradio', { name: 'Max' }), width);

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('describes a disabled value by its reason', async () => {
    installViewport(width);
    render(<EffortMenu />);

    await openEffort();

    expect(screen.getByRole('menuitemradio', { name: 'Max' })).toHaveAccessibleDescription(
      "This model can't write a long enough answer."
    );
  });

  it('names the group by its label', async () => {
    installViewport(width);
    render(<EffortMenu label="Effort levels" />);

    await openEffort();

    expect(screen.getByRole('group', { name: 'Effort levels' })).toContainElement(
      screen.getByRole('menuitemradio', { name: 'Mid' })
    );
  });

  it('places a caller test id on the menuitemradio element', async () => {
    installViewport(width);
    render(
      <Menu trigger={<button type="button">Effort</button>} title="Reasoning effort">
        <MenuRadioGroup<Effort> value="mid" onValueChange={vi.fn()}>
          <MenuRadioItem<Effort> value="auto" title="Auto" data-testid="effort-auto" />
        </MenuRadioGroup>
      </Menu>
    );

    await openEffort();

    expect(screen.getByTestId('effort-auto')).toBe(
      screen.getByRole('menuitemradio', { name: 'Auto' })
    );
  });

  it('puts no test id on an item given none', async () => {
    installViewport(width);
    render(<EffortMenu />);

    const menu = await openEffort().then(() => screen.getByRole('menu'));

    expect(menu.querySelector('[data-testid]')).toBeNull();
  });
});

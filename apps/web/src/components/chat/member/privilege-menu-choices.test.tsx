import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Menu, MenuItem } from '@hushbox/ui/menu';
import { PrivilegeMenuChoices } from '@/components/chat/member/privilege-menu-choices';

interface OpenOptions {
  choices: readonly string[];
  followed?: boolean;
  onChoose?: (privilege: string) => void;
}

async function openMenu({
  choices,
  followed = false,
  onChoose = vi.fn(),
}: OpenOptions): Promise<{ menu: HTMLElement; user: ReturnType<typeof userEvent.setup> }> {
  const user = userEvent.setup();
  render(
    <Menu trigger={<button type="button">More</button>} title="More options">
      <PrivilegeMenuChoices
        choices={choices}
        current="write"
        labelTestId="label"
        optionTestId={(privilege) => `option-${privilege}`}
        followed={followed}
        onChoose={onChoose}
      />
      <MenuItem title="Remove" onSelect={vi.fn()} />
    </Menu>
  );
  await user.click(screen.getByRole('button', { name: 'More' }));
  return { menu: await screen.findByRole('menu'), user };
}

describe('PrivilegeMenuChoices', () => {
  it('draws one radio item per allowed privilege, in the order given', async () => {
    await openMenu({ choices: ['write', 'read'] });

    expect(
      screen.getAllByRole('menuitemradio').map((item) => item.dataset['testid'])
    ).toStrictEqual(['option-write', 'option-read']);
  });

  it('labels the group Change privilege', async () => {
    await openMenu({ choices: ['write', 'read'] });

    expect(screen.getByTestId('label')).toHaveTextContent('Change privilege');
  });

  it('marks the current privilege checked', async () => {
    await openMenu({ choices: ['write', 'read'] });

    expect(screen.getByTestId('option-write')).toHaveAttribute('aria-checked', 'true');
  });

  it('passes the chosen privilege to the handler', async () => {
    const onChoose = vi.fn();
    const { user } = await openMenu({ choices: ['write', 'read'], onChoose });

    await user.click(screen.getByTestId('option-read'));

    expect(onChoose).toHaveBeenCalledWith('read');
  });

  it('draws nothing with no allowed privilege', async () => {
    const { menu } = await openMenu({ choices: [] });

    expect(menu.querySelectorAll('[data-testid]')).toHaveLength(0);
  });

  it('closes the group with a separator when more items follow', async () => {
    const { menu } = await openMenu({ choices: ['read'], followed: true });

    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it('draws no separator when nothing follows', async () => {
    const { menu } = await openMenu({ choices: ['read'], followed: false });

    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(0);
  });
});

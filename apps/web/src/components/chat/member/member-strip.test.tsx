import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { MemberStrip } from '@/components/chat/member/member-strip';
import { MEMBERS_PANE_ID } from '@/components/chat/member/member-sidebar';
import { useRightPane } from '@/stores/ui/right-pane';

type StripMembers = Parameters<typeof MemberStrip>[0]['members'];

const THREE: StripMembers = [
  { name: 'Alice', online: true },
  { name: 'Bob', online: true },
  { name: 'Charlie', online: false },
];

function strip(): HTMLElement {
  return screen.getByTestId(TEST_IDS.memberStrip);
}

describe('MemberStrip', () => {
  beforeEach(() => {
    useRightPane.setState({ active: null });
  });

  it('puts the memberStrip id on the button', () => {
    render(<MemberStrip members={THREE} />);

    expect(strip().tagName).toBe('BUTTON');
  });

  it('counts the members and those online', () => {
    render(<MemberStrip members={THREE} />);

    expect(within(strip()).getByText('3 members · 2 online')).toBeInTheDocument();
  });

  it('counts a lone member in the singular', () => {
    render(<MemberStrip members={[{ name: 'Alice', online: true }]} />);

    expect(within(strip()).getByText('1 member · 1 online')).toBeInTheDocument();
  });

  it('names the button by its count and what it shows', () => {
    render(<MemberStrip members={THREE} />);

    expect(strip()).toHaveAccessibleName('3 members · 2 online. Show members');
  });

  it('draws three avatars then the number left over', () => {
    const eleven: StripMembers = Array.from({ length: 11 }, (_, index) => ({
      name: `Member ${String(index)}`,
      online: false,
    }));

    render(<MemberStrip members={eleven} />);

    expect(strip().querySelectorAll('[data-slot="avatar"]')).toHaveLength(3);
    expect(within(strip()).getByText('+8')).toBeInTheDocument();
  });

  it('draws no number left over for three members', () => {
    render(<MemberStrip members={THREE} />);

    expect(within(strip()).queryByText(/^\+\d/)).not.toBeInTheDocument();
  });

  it('sets the avatar initials at the strip size, 0.6875rem', () => {
    render(<MemberStrip members={THREE} />);

    const pile = strip().querySelector('[data-slot="avatar"]')?.parentElement;
    expect(pile).toHaveClass('[&>[data-slot=avatar]]:text-[0.6875rem]');
  });

  it('rings the avatars of the members online', () => {
    render(<MemberStrip members={THREE} />);

    expect(strip().querySelectorAll('[data-slot="avatar"][data-online]')).toHaveLength(2);
  });

  it('holds its row while the members load, named by what it shows', () => {
    render(<MemberStrip members={undefined} />);

    expect(strip()).toHaveAccessibleName('Show members');
    expect(strip()).toHaveClass('min-h-11');
    expect(strip().querySelector('[data-slot="avatar"]')).toBeNull();
  });

  it('opens the members pane when pressed', async () => {
    const user = userEvent.setup();
    render(<MemberStrip members={THREE} />);

    await user.click(strip());

    expect(useRightPane.getState().active).toBe(MEMBERS_PANE_ID);
  });
});

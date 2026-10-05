import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { MemberFacepile } from '@/components/chat/member/member-facepile';
import { MEMBERS_PANE_ID } from '@/components/chat/member/member-sidebar';
import { useRightPane } from '@/stores/ui/right-pane';

type FacepileMembers = Parameters<typeof MemberFacepile>[0]['members'];

const ELEVEN: FacepileMembers = Array.from({ length: 11 }, (_, index) => ({
  name: `Member ${String(index)}`,
  online: index === 0,
}));

function facepile(): HTMLElement {
  return screen.getByTestId(TEST_IDS.memberFacepile);
}

describe('MemberFacepile', () => {
  beforeEach(() => {
    useRightPane.setState({ active: null });
  });

  it('draws nothing without members', () => {
    const { container } = render(<MemberFacepile members={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('puts the memberFacepile id on the button', () => {
    render(<MemberFacepile members={ELEVEN} />);

    expect(facepile().tagName).toBe('BUTTON');
  });

  it('draws three avatars then the number left over', () => {
    render(<MemberFacepile members={ELEVEN} />);

    expect(facepile().querySelectorAll('[data-slot="avatar"]')).toHaveLength(3);
    expect(within(facepile()).getByText('+8')).toBeInTheDocument();
  });

  it('is named by the member count', () => {
    render(<MemberFacepile members={ELEVEN} />);

    expect(facepile()).toHaveAccessibleName('Members (11)');
  });

  it('rings the avatar of a member online', () => {
    render(<MemberFacepile members={ELEVEN} />);

    expect(facepile().querySelectorAll('[data-slot="avatar"][data-online]')).toHaveLength(1);
  });

  it('opens the members pane when pressed', async () => {
    const user = userEvent.setup();
    render(<MemberFacepile members={ELEVEN} />);

    await user.click(facepile());

    expect(useRightPane.getState().active).toBe(MEMBERS_PANE_ID);
  });
});

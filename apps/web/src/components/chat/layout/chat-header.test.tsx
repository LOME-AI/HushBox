import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as renderInDocument, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { PageShell } from '@/components/shared/page-shell';
import { ChatHeader } from '@/components/chat/layout/chat-header';
import type { RenderResult } from '@testing-library/react';

vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: 'light', triggerTransition: vi.fn() }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

// The header fills the page shell's slots, so every case renders it inside one.
function render(ui: React.ReactElement): RenderResult {
  return renderInDocument(<PageShell>{ui}</PageShell>);
}

function slot(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-page-slot="${name}"]`);
  if (element === null) throw new Error(`no ${name} slot`);
  return element;
}

describe('ChatHeader', () => {
  it('draws no theme toggle of its own', () => {
    renderInDocument(<ChatHeader />);
    expect(screen.queryByTestId(TEST_IDS.themeToggle)).not.toBeInTheDocument();
  });

  it('puts the encryption badge in the shield slot', () => {
    render(<ChatHeader />);
    expect(within(slot('shield')).getByTestId('encryption-badge')).toBeInTheDocument();
  });

  it('gives the shell header the chat header test id', () => {
    render(<ChatHeader />);
    expect(document.querySelector('header')).toHaveAttribute('data-testid', TEST_IDS.chatHeader);
  });

  it('draws no model picker, which the composer holds', () => {
    render(<ChatHeader />);
    expect(screen.queryByTestId(TEST_IDS.modelSelectorButton)).not.toBeInTheDocument();
  });

  it('leaves the centre slot empty without a branch switcher', () => {
    render(<ChatHeader />);
    expect(slot('center')).toBeEmptyDOMElement();
  });

  it('puts the branch switcher in the centre slot, after the title', () => {
    render(<ChatHeader title="Test Conversation" branchSwitcher={<button>Branch: Main</button>} />);
    expect(
      within(slot('center')).getByRole('button', { name: 'Branch: Main' })
    ).toBeInTheDocument();
  });

  describe('title', () => {
    it('renders title when provided', () => {
      render(<ChatHeader title="Test Conversation" />);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Test Conversation');
    });

    it('does not render title when not provided', () => {
      render(<ChatHeader />);
      expect(screen.queryByTestId('chat-title')).not.toBeInTheDocument();
    });

    it('has truncate class for long titles', () => {
      render(<ChatHeader title="A Very Long Conversation Title That Should Be Truncated" />);
      expect(screen.getByRole('heading', { level: 1 })).toHaveClass('truncate');
    });

    it('has title attribute for full text on hover', () => {
      const fullTitle = 'A Very Long Conversation Title That Should Be Truncated';
      render(<ChatHeader title={fullTitle} />);
      const title = screen.getByTestId('chat-title');
      expect(title).toHaveAttribute('title', fullTitle);
    });

    it('draws no heading for an empty title', () => {
      render(<ChatHeader title="" />);
      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    });

    it('puts the title in the title slot', () => {
      render(<ChatHeader title="Test Conversation" />);
      expect(slot('title')).toContainElement(screen.getByTestId('chat-title'));
    });
  });

  describe('the New chat icon', () => {
    it('is in the New chat slot when the page asks for it', () => {
      render(<ChatHeader title="Test Conversation" showNewChat />);
      expect(within(slot('new-chat')).getByRole('button', { name: 'New Chat' })).toBeVisible();
    });

    it('is absent by default', () => {
      render(<ChatHeader title="Test Conversation" />);
      expect(screen.queryByTestId(TEST_IDS.headerNewChat)).not.toBeInTheDocument();
    });
  });

  describe('group chat features', () => {
    const groupMembers = [
      { id: 'user-1', userId: 'user-1', username: 'alice' },
      { id: 'user-2', userId: 'user-2', username: 'bob' },
    ];

    describe('facepile', () => {
      it('renders facepile when members are provided', () => {
        render(
          <ChatHeader
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        expect(screen.getByTestId('member-facepile')).toBeInTheDocument();
      });

      it('does not render facepile when members is undefined', () => {
        render(<ChatHeader />);
        expect(screen.queryByTestId('member-facepile')).not.toBeInTheDocument();
      });

      it('does not render facepile when members is empty', () => {
        render(<ChatHeader members={[]} onlineMemberIds={new Set()} onFacepileClick={vi.fn()} />);
        expect(screen.queryByTestId('member-facepile')).not.toBeInTheDocument();
      });

      it('calls onFacepileClick when facepile is clicked', async () => {
        const user = userEvent.setup();
        const onFacepileClick = vi.fn();
        render(
          <ChatHeader
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={onFacepileClick}
          />
        );
        await user.click(screen.getByTestId('member-facepile'));
        expect(onFacepileClick).toHaveBeenCalledOnce();
      });

      it('renders the facepile with fallbacks when presence and click handler are omitted', async () => {
        const user = userEvent.setup();
        render(<ChatHeader members={groupMembers} />);
        const facepile = screen.getByTestId('member-facepile');
        expect(facepile).toBeInTheDocument();
        // The noop fallback must be safe to invoke.
        await expect(user.click(facepile)).resolves.toBeUndefined();
      });
    });

    describe('the encryption assurance the header composes', () => {
      afterEach(() => {
        clearLinkGuestAuth();
      });

      async function openEncryptionTooltip(): Promise<void> {
        const user = userEvent.setup();
        render(<ChatHeader isAuthenticated={false} />);
        await user.hover(screen.getByTestId('encryption-badge'));
      }

      it('does not tell a link guest to sign up to save encrypted chats', async () => {
        setLinkGuestAuth('link-public-key');

        await openEncryptionTooltip();

        // Radix mirrors the open tooltip into its live region, so the assurance
        // appears twice; the false line must appear nowhere.
        await waitFor(() => {
          expect(screen.getAllByText(/not even we can read your messages/i).length).toBeGreaterThan(
            0
          );
        });
        expect(screen.queryByText(/save encrypted chats/i)).not.toBeInTheDocument();
      });

      it('does offer sign-up to a visitor holding neither an account nor a link', async () => {
        await openEncryptionTooltip();

        await waitFor(() => {
          expect(screen.getAllByText(/save encrypted chats/i).length).toBeGreaterThan(0);
        });
      });
    });

    describe('slot placement', () => {
      it('puts the facepile in the facepile slot', () => {
        render(
          <ChatHeader
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        expect(within(slot('facepile')).getByTestId('member-facepile')).toBeInTheDocument();
      });

      it('does not render add dropdown', () => {
        render(
          <ChatHeader
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        expect(screen.queryByTestId('header-add-dropdown-trigger')).not.toBeInTheDocument();
      });
    });
  });
});

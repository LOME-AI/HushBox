import * as React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { useRightPane } from '@/stores/ui/right-pane';
import { RightPane, RightPaneHostContext } from './right-pane';

/** Stands in for the shell: one slot element the panes portal into. */
function Shell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  return (
    <RightPaneHostContext value={host}>
      <main>{children}</main>
      <div ref={setHost} data-slot-under-test="" />
    </RightPaneHostContext>
  );
}

function slot(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot-under-test]');
  if (element === null) throw new Error('the shell rendered no slot');
  return element;
}

/** Narrows the window below 768px, where a pane takes its phone form. */
function stubPhoneWidth(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

function openPane(id: string): void {
  act(() => {
    useRightPane.getState().open(id);
  });
}

describe('RightPane', () => {
  beforeEach(() => {
    useRightPane.setState({ active: null });
  });

  it('draws nothing while its pane is closed', () => {
    render(
      <Shell>
        <RightPane
          id="members"
          title="Members"
          width="20rem"
          head="plain"
          surface="sidebar"
          phone="fullscreen"
          onClose={vi.fn()}
        >
          body
        </RightPane>
      </Shell>
    );

    expect(screen.queryByRole('complementary', { name: 'Members' })).not.toBeInTheDocument();
  });

  it('draws into the shell slot once its pane opens', () => {
    render(
      <Shell>
        <RightPane
          id="members"
          title="Members"
          width="20rem"
          head="plain"
          surface="sidebar"
          phone="fullscreen"
          onClose={vi.fn()}
        >
          body
        </RightPane>
      </Shell>
    );

    openPane('members');

    expect(within(slot()).getByRole('complementary', { name: 'Members' })).toBeInTheDocument();
  });

  it('draws nothing outside a shell', () => {
    useRightPane.setState({ active: 'members' });
    render(
      <RightPane
        id="members"
        title="Members"
        width="20rem"
        head="plain"
        surface="sidebar"
        phone="fullscreen"
        onClose={vi.fn()}
      >
        body
      </RightPane>
    );

    expect(screen.queryByRole('complementary', { name: 'Members' })).not.toBeInTheDocument();
  });

  describe('one pane at a time', () => {
    function renderTwo(): void {
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            member list
          </RightPane>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            settings
          </RightPane>
        </Shell>
      );
    }

    it('shows only the pane opened', () => {
      renderTwo();

      openPane('members');

      expect(screen.getAllByRole('complementary')).toHaveLength(1);
    });

    it('replaces the open pane with the one opened after it', () => {
      renderTwo();
      openPane('members');

      openPane('accessibility');

      expect(screen.getAllByRole('complementary').map((pane) => pane.textContent)).toEqual([
        expect.stringContaining('settings'),
      ]);
    });
  });

  describe('the head', () => {
    it('titles the pane with a second-level heading', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Members');
    });

    it('sets the aside muted, after the title', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            titleAside="· 3"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const aside = within(screen.getByRole('heading', { level: 2 })).getByText('· 3');
      expect(aside).toHaveClass('text-muted-foreground');
    });

    it('reads the title and its aside as separate words', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            titleAside="· 3"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Members · 3');
    });

    it('names the close button for the pane', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('button', { name: 'Close members' })).toBeInTheDocument();
    });
  });

  it('carries the test id given on its root', () => {
    useRightPane.setState({ active: 'members' });
    render(
      <Shell>
        <RightPane
          id="members"
          title="Members"
          width="20rem"
          head="plain"
          surface="sidebar"
          phone="fullscreen"
          onClose={vi.fn()}
          data-testid={TEST_IDS.memberSidebar}
        >
          body
        </RightPane>
      </Shell>
    );

    expect(screen.getByTestId(TEST_IDS.memberSidebar)).toBe(
      screen.getByRole('complementary', { name: 'Members' })
    );
  });

  describe('closing', () => {
    it('closes its pane when the close button is pressed', async () => {
      const user = userEvent.setup();
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      await user.click(screen.getByRole('button', { name: 'Close members' }));

      expect(useRightPane.getState().active).toBeNull();
    });

    it('tells its owner when the close button is pressed', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={onClose}
          >
            body
          </RightPane>
        </Shell>
      );

      await user.click(screen.getByRole('button', { name: 'Close members' }));

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('closes on Escape pressed inside the pane', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={onClose}
          >
            <button type="button">inside</button>
          </RightPane>
        </Shell>
      );
      screen.getByRole('button', { name: 'inside' }).focus();

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('stays open on a key other than Escape', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={onClose}
          >
            <button type="button">inside</button>
          </RightPane>
        </Shell>
      );
      screen.getByRole('button', { name: 'inside' }).focus();

      await user.keyboard('{Enter}');

      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes its pane when it unmounts open, so no fold outlives it', () => {
      useRightPane.setState({ active: 'members' });
      const { rerender } = render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      rerender(<Shell>{null}</Shell>);

      expect(useRightPane.getState().active).toBeNull();
    });

    it('leaves another pane open when it unmounts closed', () => {
      useRightPane.setState({ active: 'accessibility' });
      const { rerender } = render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      rerender(<Shell>{null}</Shell>);

      expect(useRightPane.getState().active).toBe('accessibility');
    });
  });

  it('takes focus as it opens, so Escape reaches it', () => {
    render(
      <Shell>
        <RightPane
          id="members"
          title="Members"
          width="20rem"
          head="plain"
          surface="sidebar"
          phone="fullscreen"
          onClose={vi.fn()}
        >
          body
        </RightPane>
      </Shell>
    );

    openPane('members');

    expect(screen.getByRole('complementary', { name: 'Members' })).toHaveFocus();
  });

  describe('the surface', () => {
    it('draws on the page background when asked', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('complementary', { name: 'Accessibility' })).toHaveClass(
        'bg-background',
        'border-border'
      );
    });

    it('draws on the sidebar surface when asked', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('complementary', { name: 'Members' })).toHaveClass(
        'bg-sidebar',
        'border-sidebar-border'
      );
    });

    it('rules the head in the surface border colour', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const head = screen.getByRole('heading', { level: 2 }).closest('header');
      expect(head).toHaveClass('border-b', 'border-inherit');
    });

    it('refuses a pane with no surface named', () => {
      const pane = (
        // @ts-expect-error -- the surface is required, so a pane cannot fall back to one silently
        <RightPane id="p" title="P" width="20rem" head="plain" phone="sheet" onClose={vi.fn()}>
          body
        </RightPane>
      );

      expect(pane).toBeDefined();
    });
  });

  describe('the head', () => {
    it('sets a plain head title in the reading title role', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-title-3-read');
    });

    it('keeps a plain head at the app header height below 768', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const head = screen.getByRole('heading', { level: 2 }).closest('header');
      expect(head).toHaveClass('min-h-[var(--app-header-height)]', 'pl-4');
    });

    it('sets a display head title at 1.125rem', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('heading', { level: 2 })).toHaveClass('text-[1.125rem]', 'font-bold');
    });

    it('insets a display head 1.25rem and lets it take its content height below 768', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const head = screen.getByRole('heading', { level: 2 }).closest('header');
      expect(head).toHaveClass('min-h-0', 'pt-1', 'pb-2', 'pl-5');
    });

    it('draws a display head at the app header height from 768', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const head = screen.getByRole('heading', { level: 2 }).closest('header');
      expect(head).toHaveClass('md:min-h-[var(--app-header-height)]', 'md:py-1', 'md:pl-4');
    });

    it('refuses a pane with no head named', () => {
      const pane = (
        // @ts-expect-error -- the head is required, so a pane cannot take the wrong one silently
        <RightPane id="p" title="P" width="20rem" surface="sidebar" phone="sheet" onClose={vi.fn()}>
          body
        </RightPane>
      );

      expect(pane).toBeDefined();
    });
  });

  describe('below 768, over the page', () => {
    const originalMatchMedia = globalThis.matchMedia;

    /** A control rendered straight into body, outside the app's tree, as the banner is. */
    function mountBodySibling(): HTMLElement {
      const sibling = document.createElement('div');
      sibling.innerHTML = '<button type="button">Dismiss announcement</button>';
      document.body.append(sibling);
      return sibling;
    }

    function renderPanes(): void {
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            <button type="button">member action</button>
          </RightPane>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );
    }

    let banner: HTMLElement;

    beforeEach(() => {
      banner = mountBodySibling();
    });

    afterEach(() => {
      banner.remove();
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
    });

    describe('keyboard and assistive technology under the full-screen form', () => {
      /** A conversation's message list: a live log holding controls, as the chat draws it. */
      function MessageLog(): React.JSX.Element {
        return (
          <ul role="log" aria-label="Messages">
            <li>
              <button type="button">Copy message</button>
            </li>
            <li>
              <button type="button">Regenerate reply</button>
            </li>
          </ul>
        );
      }

      function renderOverConversation(): void {
        render(
          <Shell>
            <MessageLog />
            <RightPane
              id="members"
              title="Members"
              width="20rem"
              head="plain"
              surface="sidebar"
              phone="fullscreen"
              onClose={vi.fn()}
            >
              <button type="button">first member control</button>
              <button type="button">second member control</button>
            </RightPane>
          </Shell>
        );
      }

      function focusedInsidePane(): boolean {
        const pane = screen
          .getByRole('button', { name: 'first member control' })
          .closest('[role="dialog"], aside');
        return pane?.contains(document.activeElement) ?? false;
      }

      it('keeps Tab inside the pane, past the message log and the banner', async () => {
        const user = userEvent.setup();
        stubPhoneWidth();
        renderOverConversation();
        openPane('members');

        const stops: boolean[] = [];
        for (let press = 0; press < 8; press += 1) {
          await user.tab();
          stops.push(focusedInsidePane());
        }

        expect(stops).toEqual(Array.from({ length: 8 }, () => true));
      });

      it('keeps Shift+Tab inside the pane, past the message log and the banner', async () => {
        const user = userEvent.setup();
        stubPhoneWidth();
        renderOverConversation();
        openPane('members');

        const stops: boolean[] = [];
        for (let press = 0; press < 8; press += 1) {
          await user.tab({ shift: true });
          stops.push(focusedInsidePane());
        }

        expect(stops).toEqual(Array.from({ length: 8 }, () => true));
      });

      it('hides the banner from assistive technology while the pane is open', () => {
        stubPhoneWidth();
        renderOverConversation();

        openPane('members');

        expect(banner).toHaveAttribute('aria-hidden', 'true');
      });

      it('leaves a toast region announced while the pane is open', () => {
        stubPhoneWidth();
        const toasts = document.createElement('section');
        toasts.setAttribute('aria-live', 'polite');
        document.body.append(toasts);
        renderOverConversation();

        openPane('members');

        expect(toasts.closest('[aria-hidden="true"]')).toBeNull();
        toasts.remove();
      });

      it('writes no inert attribute anywhere', () => {
        stubPhoneWidth();
        renderOverConversation();

        openPane('members');

        expect(document.querySelectorAll('[inert]')).toHaveLength(0);
      });

      it('returns focus to the control that opened it once it closes', async () => {
        const user = userEvent.setup();
        stubPhoneWidth();
        render(
          <Shell>
            <button
              type="button"
              onClick={() => {
                useRightPane.getState().open('members');
              }}
            >
              Open members
            </button>
            <RightPane
              id="members"
              title="Members"
              width="20rem"
              head="plain"
              surface="sidebar"
              phone="fullscreen"
              onClose={vi.fn()}
            >
              body
            </RightPane>
          </Shell>
        );
        await user.click(screen.getByRole('button', { name: 'Open members' }));

        await user.click(screen.getByRole('button', { name: 'Close members' }));

        expect(screen.getByRole('button', { name: 'Open members' })).toHaveFocus();
      });

      it('names the dialog with exactly one heading, the visible head', () => {
        stubPhoneWidth();
        render(
          <Shell>
            <RightPane
              id="members"
              title="Members"
              titleAside="· 5"
              width="20rem"
              head="plain"
              surface="sidebar"
              phone="fullscreen"
              onClose={vi.fn()}
            >
              body
            </RightPane>
          </Shell>
        );

        openPane('members');

        const dialog = screen.getByRole('dialog', { name: 'Members · 5' });
        expect(within(dialog).getAllByRole('heading')).toHaveLength(1);
      });

      it('closes on Escape', async () => {
        const user = userEvent.setup();
        stubPhoneWidth();
        renderOverConversation();
        openPane('members');

        await user.keyboard('{Escape}');

        expect(useRightPane.getState().active).toBeNull();
      });
    });

    it('renders the full-screen form as a modal dialog named for the pane', () => {
      stubPhoneWidth();
      renderPanes();

      openPane('members');

      expect(screen.getByRole('dialog', { name: 'Members' })).toHaveClass('inset-0');
    });

    it('carries the test id given on the full-screen form', () => {
      stubPhoneWidth();
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
            data-testid={TEST_IDS.memberSidebar}
          >
            body
          </RightPane>
        </Shell>
      );

      openPane('members');

      expect(
        within(screen.getByRole('dialog', { name: 'Members' })).getByTestId(TEST_IDS.memberSidebar)
      ).toBeInTheDocument();
    });

    it('leaves the page exposed under the non-modal sheet', () => {
      stubPhoneWidth();
      renderPanes();

      openPane('accessibility');

      expect(banner.closest('[aria-hidden="true"]')).toBeNull();
    });

    it('leaves the page exposed beside a docked pane from 768', () => {
      renderPanes();

      openPane('members');

      expect(banner.closest('[aria-hidden="true"]')).toBeNull();
    });
  });

  describe('returning focus to the opener', () => {
    const originalMatchMedia = globalThis.matchMedia;

    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
    });

    function renderWithOpener(phone: 'fullscreen' | 'sheet'): void {
      render(
        <Shell>
          <button
            type="button"
            onClick={() => {
              useRightPane.getState().open('pane');
            }}
          >
            Open the pane
          </button>
          <RightPane
            id="pane"
            title="Pane"
            width="22rem"
            head="display"
            surface="background"
            phone={phone}
            onClose={vi.fn()}
          >
            <button type="button">inside</button>
          </RightPane>
        </Shell>
      );
    }

    it('returns focus to the opener when Escape closes the docked form', async () => {
      const user = userEvent.setup();
      renderWithOpener('fullscreen');
      await user.click(screen.getByRole('button', { name: 'Open the pane' }));

      await user.keyboard('{Escape}');

      expect(screen.getByRole('button', { name: 'Open the pane' })).toHaveFocus();
    });

    it('returns focus to the opener when the close button closes the docked form', async () => {
      const user = userEvent.setup();
      renderWithOpener('fullscreen');
      await user.click(screen.getByRole('button', { name: 'Open the pane' }));

      await user.click(screen.getByRole('button', { name: 'Close pane' }));

      expect(screen.getByRole('button', { name: 'Open the pane' })).toHaveFocus();
    });

    it('returns focus to the opener when Escape closes the sheet form', async () => {
      const user = userEvent.setup();
      stubPhoneWidth();
      renderWithOpener('sheet');
      await user.click(screen.getByRole('button', { name: 'Open the pane' }));

      await user.keyboard('{Escape}');

      expect(screen.getByRole('button', { name: 'Open the pane' })).toHaveFocus();
    });

    it('returns focus to the opener when the close button closes the sheet form', async () => {
      const user = userEvent.setup();
      stubPhoneWidth();
      renderWithOpener('sheet');
      await user.click(screen.getByRole('button', { name: 'Open the pane' }));

      await user.click(screen.getByRole('button', { name: 'Close pane' }));

      expect(screen.getByRole('button', { name: 'Open the pane' })).toHaveFocus();
    });

    it('leaves focus where the next pane put it when a pane replaces another', async () => {
      const user = userEvent.setup();
      render(
        <Shell>
          <button
            type="button"
            onClick={() => {
              useRightPane.getState().open('first');
            }}
          >
            Open the first
          </button>
          <RightPane
            id="first"
            title="First"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
          <RightPane
            id="second"
            title="Second"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );
      await user.click(screen.getByRole('button', { name: 'Open the first' }));

      openPane('second');
      // A task passes, so a restore that runs late has had its turn.
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });

      expect(screen.getByRole('complementary', { name: 'Second' })).toHaveFocus();
    });
  });

  describe('docked from 768', () => {
    it.each([['20rem', 'md:w-[20rem]'] as const, ['22rem', 'md:w-[22rem]'] as const])(
      'docks at its declared %s width',
      (width, widthClass) => {
        useRightPane.setState({ active: 'pane' });
        render(
          <Shell>
            <RightPane
              id="pane"
              title="Pane"
              width={width}
              head="display"
              surface="background"
              phone="fullscreen"
              onClose={vi.fn()}
            >
              body
            </RightPane>
          </Shell>
        );

        expect(screen.getByRole('complementary', { name: 'Pane' })).toHaveClass(
          widthClass,
          'md:static',
          'md:shrink-0',
          'md:border-l'
        );
      }
    );
  });

  describe('docking only where a thread fits beside it', () => {
    /** Sets the window's width and the root font size the rem units resolve against. */
    function setWindow(width: number, rootPx: number): void {
      const originalWidth = globalThis.innerWidth;
      Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: width });
      document.documentElement.style.fontSize = `${String(rootPx)}px`;
      onTestFinished(() => {
        Object.defineProperty(globalThis, 'innerWidth', {
          configurable: true,
          value: originalWidth,
        });
        document.documentElement.style.fontSize = '';
      });
    }

    function renderPane(phone: 'fullscreen' | 'sheet'): void {
      useRightPane.setState({ active: 'pane' });
      render(
        <Shell>
          <RightPane
            id="pane"
            title="Pane"
            width="22rem"
            head="display"
            surface="background"
            phone={phone}
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );
    }

    it('docks at 768 when the pane and a 20rem thread fit', () => {
      setWindow(768, 17);
      renderPane('sheet');

      expect(screen.getByRole('complementary', { name: 'Pane' })).toHaveClass(
        'md:static',
        'md:w-[22rem]'
      );
    });

    it('takes its sheet form at 768 when larger text leaves no room for the thread', () => {
      setWindow(768, 24);
      renderPane('sheet');

      const pane = screen.getByRole('complementary', { name: 'Pane' });
      expect(pane).toHaveClass('fixed', 'h-[62dvh]');
      expect(pane).not.toHaveClass('md:static');
      expect(pane.querySelector('[data-sheet-handle]')).not.toHaveClass('md:hidden');
    });

    it('takes its full-screen form at 768 when larger text leaves no room for the thread', () => {
      setWindow(768, 24);
      renderPane('fullscreen');

      expect(screen.getByRole('dialog', { name: 'Pane' })).toBeInTheDocument();
    });

    describe('as a centred dialog, with a body taller than the window', () => {
      // This DOM lays nothing out, so the cases pin the structure the layout rests on: the
      // dialog takes a definite height, the pane fills it, and only the body scrolls.
      function renderTallPane(): void {
        setWindow(768, 24);
        useRightPane.setState({ active: 'pane' });
        render(
          <Shell>
            <RightPane
              id="pane"
              title="Pane"
              width="20rem"
              head="plain"
              surface="sidebar"
              phone="fullscreen"
              onClose={vi.fn()}
            >
              <div style={{ height: '200vh' }}>tall body</div>
            </RightPane>
          </Shell>
        );
      }

      it('gives the dialog a definite height, so the pane can fill it', () => {
        renderTallPane();

        expect(screen.getByRole('dialog', { name: 'Pane' })).toHaveClass('md:h-dvh');
      });

      it('keeps its head outside the part that scrolls', () => {
        renderTallPane();

        const body = screen.getByText('tall body').parentElement;
        const head = screen.getByRole('heading', { name: 'Pane' }).closest('header');
        expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
        expect(body).not.toContainElement(head);
        expect(head?.parentElement).toHaveClass('flex', 'h-full', 'flex-col');
      });
    });

    it('docks again once the window widens to fit the thread', () => {
      setWindow(768, 24);
      renderPane('sheet');

      act(() => {
        Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1440 });
        globalThis.dispatchEvent(new Event('resize'));
      });

      expect(screen.getByRole('complementary', { name: 'Pane' })).toHaveClass('md:static');
    });

    it('takes its sheet form when the text grows while it is docked', async () => {
      setWindow(768, 17);
      renderPane('sheet');

      act(() => {
        document.documentElement.style.fontSize = '24px';
      });

      await waitFor(() => {
        expect(screen.getByRole('complementary', { name: 'Pane' })).not.toHaveClass('md:static');
      });
    });
  });

  describe('below 768', () => {
    it('rises as a 62dvh bottom sheet', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      expect(screen.getByRole('complementary', { name: 'Accessibility' })).toHaveClass(
        'fixed',
        'inset-x-0',
        'bottom-0',
        'h-[62dvh]',
        'slide-in-from-bottom'
      );
    });

    it('leaves the page behind the sheet usable, drawing no scrim and claiming no modality', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const pane = screen.getByRole('complementary', { name: 'Accessibility' });
      expect(pane).not.toHaveAttribute('aria-modal');
      expect(slot().children).toHaveLength(1);
    });

    it('draws the sheet a handle that hides from 768', () => {
      useRightPane.setState({ active: 'accessibility' });
      render(
        <Shell>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            head="display"
            surface="background"
            phone="sheet"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const pane = screen.getByRole('complementary', { name: 'Accessibility' });
      expect(pane.querySelector('[data-sheet-handle]')).toHaveClass('md:hidden');
    });

    it('draws no handle on a full-screen pane', () => {
      useRightPane.setState({ active: 'members' });
      render(
        <Shell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            head="plain"
            surface="sidebar"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            body
          </RightPane>
        </Shell>
      );

      const pane = screen.getByRole('complementary', { name: 'Members' });
      expect(pane.querySelector('[data-sheet-handle]')).toBeNull();
    });
  });
});

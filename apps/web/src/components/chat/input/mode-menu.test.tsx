import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, onTestFinished, vi } from 'vitest';
import { MOBILE_BREAKPOINT, TEST_IDS } from '@hushbox/shared';
import { ModeMenu } from './mode-menu';
import type { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access';
import type { ChatModality } from '@hushbox/shared';

type PremiumAccess = ReturnType<typeof usePayerPremiumAccess>;

const PREMIUM: PremiumAccess = { status: 'known', canAccessPremium: true };
const FREE_TIER: PremiumAccess = { status: 'known', canAccessPremium: false };
const AWAITING: PremiumAccess = { status: 'awaiting' };
const UNAVAILABLE: PremiumAccess = { status: 'unavailable' };

const originalMatchMedia = globalThis.matchMedia;

/** A window one pixel under the desktop band, so the menu presents as a sheet. */
function installPhoneViewport(): void {
  const phoneQuery = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === phoneQuery,
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      };
      // The band and pointer hooks read only `matches` and the listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

interface HarnessProps {
  activeModality?: ChatModality;
  onSelect?: (modality: ChatModality) => void;
  isAuthenticated?: boolean;
  premiumAccess?: PremiumAccess;
  audioEnabled?: boolean;
  extraRows?: React.ReactNode;
}

function renderMenu({
  activeModality = 'text',
  onSelect = vi.fn(),
  isAuthenticated = true,
  premiumAccess = PREMIUM,
  audioEnabled = false,
  extraRows,
}: HarnessProps = {}): void {
  render(
    <ModeMenu
      activeModality={activeModality}
      onSelect={onSelect}
      isAuthenticated={isAuthenticated}
      premiumAccess={premiumAccess}
      audioEnabled={audioEnabled}
      extraRows={extraRows}
    />
  );
}

/** The composer's own mode state, so a choice lands the way the composer lands it. */
function StatefulMenu({ initial }: Readonly<{ initial: ChatModality }>): React.JSX.Element {
  const [modality, setModality] = React.useState<ChatModality>(initial);
  return (
    <ModeMenu
      activeModality={modality}
      onSelect={setModality}
      isAuthenticated
      premiumAccess={PREMIUM}
      audioEnabled={false}
    />
  );
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Change mode' });
}

async function openMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(trigger());
  await screen.findByRole('menu');
  return user;
}

interface StubBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The root font is 16px here, so 0.5rem is 8px.
const VIEWPORT: StubBox = { left: 0, top: 0, width: 1024, height: 768 };
const PLUS: StubBox = { left: 110, top: 300, width: 34, height: 34 };
const COMPOSER: StubBox = { left: 100, top: 200, width: 600, height: 142 };
const MENU: StubBox = { left: 0, top: 0, width: 192, height: 110 };

/** Gives the "+", the composer and the open menu the boxes a laid-out page would. */
function stubBoxes(): void {
  const toRect = ({ left, top, width, height }: StubBox): DOMRect =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  const isMenuBox = (element: HTMLElement): boolean =>
    'radixPopperContentWrapper' in element.dataset;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ): DOMRect {
      if (this.dataset['testid'] === TEST_IDS.modeMenuButton) return toRect(PLUS);
      if (this.dataset['testid'] === 'composer-box') return toRect(COMPOSER);
      if (isMenuBox(this)) return toRect(MENU);
      if (this === document.documentElement || this === document.body) return toRect(VIEWPORT);
      return toRect({ left: 0, top: 0, width: 0, height: 0 });
    }),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return this === document.documentElement ? VIEWPORT.width : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return this === document.documentElement ? VIEWPORT.height : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return isMenuBox(this) ? MENU.width : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return isMenuBox(this) ? MENU.height : 0;
    }),
  ];
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore();
  });
}

/** Where the positioning wrapper placed the open menu, as its translate's x and y. */
async function placedAt(): Promise<{ x: number; y: number }> {
  const menu = await screen.findByRole('menu');
  const wrapper = menu.closest<HTMLElement>('[data-radix-popper-content-wrapper]');
  let placed: { x: number; y: number } | undefined;
  await waitFor(() => {
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(wrapper?.style.transform ?? '');
    expect(match).not.toBeNull();
    placed = { x: Number(match?.[1]), y: Number(match?.[2]) };
  });
  if (placed === undefined) throw new Error('the menu was never placed');
  return placed;
}

function item(name: string): HTMLElement {
  return screen.getByRole('menuitemradio', { name });
}

describe('ModeMenu', () => {
  describe('the trigger', () => {
    it('is named "Change mode"', () => {
      renderMenu();

      expect(trigger()).toBeInTheDocument();
    });

    it('carries the mode menu button test id', () => {
      renderMenu();

      expect(trigger()).toHaveAttribute('data-testid', TEST_IDS.modeMenuButton);
    });

    it('announces that it opens a menu', () => {
      renderMenu();

      expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('reports itself expanded while the menu is open', async () => {
      renderMenu();

      await openMenu();

      // The open menu hides the rest of the page from the accessibility tree.
      expect(screen.getByTestId(TEST_IDS.modeMenuButton)).toHaveAttribute('aria-expanded', 'true');
    });

    it('reports itself collapsed while the menu is closed', () => {
      renderMenu();

      expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('hands its caller the "+" through the caller\'s ref', () => {
    const triggerRef = React.createRef<HTMLButtonElement>();
    render(
      <ModeMenu
        activeModality="text"
        onSelect={vi.fn()}
        isAuthenticated
        premiumAccess={PREMIUM}
        audioEnabled={false}
        triggerRef={triggerRef}
      />
    );

    expect(triggerRef.current).toBe(trigger());
  });

  describe('its items', () => {
    it('offers Text, Image and Video as radio items while audio is off', async () => {
      renderMenu();

      await openMenu();

      expect(
        screen.getAllByRole('menuitemradio').map((option) => option.textContent.trim())
      ).toEqual(['Text', 'Image', 'Video']);
    });

    it('offers Audio last when its flag is on', async () => {
      renderMenu({ audioEnabled: true });

      await openMenu();

      expect(
        screen.getAllByRole('menuitemradio').map((option) => option.textContent.trim())
      ).toEqual(['Text', 'Image', 'Video', 'Audio']);
    });

    it('checks the current mode', async () => {
      renderMenu({ activeModality: 'image' });

      await openMenu();

      expect(item('Image')).toHaveAttribute('aria-checked', 'true');
    });

    it('leaves the other modes unchecked', async () => {
      renderMenu({ activeModality: 'image' });

      await openMenu();

      expect(item('Text')).toHaveAttribute('aria-checked', 'false');
    });

    it('draws each item with its mode icon', async () => {
      renderMenu();

      await openMenu();

      expect(item('Video').querySelector('svg.lucide-video')).not.toBeNull();
    });

    it('marks Text with the type icon', async () => {
      renderMenu();

      await openMenu();

      expect(item('Text').querySelector('svg.lucide-type')).not.toBeNull();
    });

    it('renders the rows it is handed after the modes', async () => {
      renderMenu({ extraRows: <div role="menuitem">Search</div> });

      await openMenu();

      expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Search' })).toBe(
        screen.getAllByRole('menuitem').at(-1)
      );
    });
  });

  describe('choosing a mode', () => {
    it('reports the chosen mode', async () => {
      const onSelect = vi.fn();
      renderMenu({ onSelect });
      const user = await openMenu();

      await user.click(item('Video'));

      expect(onSelect).toHaveBeenCalledWith('video');
    });

    it('closes the menu', async () => {
      renderMenu();
      const user = await openMenu();

      await user.click(item('Video'));

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('returns focus to the "+" trigger', async () => {
      render(<StatefulMenu initial="text" />);
      const user = await openMenu();

      await user.click(item('Image'));

      await waitFor(() => {
        expect(trigger()).toHaveFocus();
      });
    });

    it('returns focus to the "+" trigger after a keyboard choice', async () => {
      render(<StatefulMenu initial="text" />);
      const user = userEvent.setup();
      trigger().focus();
      await user.keyboard('{Enter}');
      await screen.findByRole('menu');

      await user.keyboard('{ArrowDown}{Enter}');

      await waitFor(() => {
        expect(trigger()).toHaveFocus();
      });
    });
  });

  describe('a mode the payer may not enter', () => {
    it.each([
      ['Image', 'Sign up to unlock image generation'],
      ['Video', 'Sign up to unlock video generation'],
    ])('tells a visitor to sign up for %s', async (name, reason) => {
      renderMenu({ isAuthenticated: false });

      await openMenu();

      expect(item(name)).toHaveAccessibleDescription(reason);
    });

    it('tells a visitor to sign up for Audio when its flag is on', async () => {
      renderMenu({ isAuthenticated: false, audioEnabled: true });

      await openMenu();

      expect(item('Audio')).toHaveAccessibleDescription('Sign up to unlock audio generation');
    });

    it('tells a visitor in another mode to sign up for Text', async () => {
      renderMenu({ isAuthenticated: false, activeModality: 'image' });

      await openMenu();

      expect(item('Text')).toHaveAccessibleDescription('Sign up to unlock text generation');
    });

    it("tells a visitor to sign up whatever the payer's premium read says", async () => {
      renderMenu({ isAuthenticated: false, premiumAccess: FREE_TIER });

      await openMenu();

      expect(item('Image')).toHaveAccessibleDescription('Sign up to unlock image generation');
    });

    it.each([
      ['Image', 'Add credit to unlock image generation'],
      ['Video', 'Add credit to unlock video generation'],
    ])(
      'tells a signed-in payer without premium reach to add credit for %s',
      async (name, reason) => {
        renderMenu({ premiumAccess: FREE_TIER });

        await openMenu();

        expect(item(name)).toHaveAccessibleDescription(reason);
      }
    );

    it('tells a signed-in payer without premium reach to add credit for Audio', async () => {
      renderMenu({ premiumAccess: FREE_TIER, audioEnabled: true });

      await openMenu();

      expect(item('Audio')).toHaveAccessibleDescription('Add credit to unlock audio generation');
    });

    it.each([
      ['in flight', AWAITING],
      ['exhausted', UNAVAILABLE],
    ])('says the balance is unknown while the premium read is %s', async (_state, access) => {
      renderMenu({ premiumAccess: access });

      await openMenu();

      expect(item('Image')).toHaveAccessibleDescription(
        'Image generation unavailable while your balance is unknown'
      );
    });

    it('says the video balance is unknown while the premium read is in flight', async () => {
      renderMenu({ premiumAccess: AWAITING });

      await openMenu();

      expect(item('Video')).toHaveAccessibleDescription(
        'Video generation unavailable while your balance is unknown'
      );
    });

    it('never tells a signed-in payer without premium reach to sign up', async () => {
      renderMenu({ premiumAccess: FREE_TIER, audioEnabled: true });

      await openMenu();

      expect(screen.queryByText(/sign up/i)).not.toBeInTheDocument();
    });

    it('marks the locked mode disabled', async () => {
      renderMenu({ premiumAccess: FREE_TIER });

      await openMenu();

      expect(item('Image')).toHaveAttribute('aria-disabled', 'true');
    });

    it('draws a lock on the locked mode', async () => {
      renderMenu({ premiumAccess: FREE_TIER });

      await openMenu();

      expect(item('Image').querySelector('svg.lucide-lock')).not.toBeNull();
    });

    it("sets the lock in the check's cell, the last in the row", async () => {
      renderMenu({ premiumAccess: FREE_TIER });

      await openMenu();

      const lock = item('Image').querySelector('svg.lucide-lock');
      expect(item('Image').lastElementChild).toContainElement(lock as HTMLElement | null);
    });

    it('keeps Text open to a signed-in payer without premium reach', async () => {
      renderMenu({ premiumAccess: FREE_TIER, activeModality: 'image' });

      await openMenu();

      expect(item('Text')).not.toHaveAttribute('aria-disabled');
    });

    it('draws no lock on a mode the payer may enter', async () => {
      renderMenu({ premiumAccess: FREE_TIER });

      await openMenu();

      expect(item('Text').querySelector('svg.lucide-lock')).toBeNull();
    });

    it('locks nothing for a payer who reaches premium', async () => {
      renderMenu({ premiumAccess: PREMIUM, audioEnabled: true });

      await openMenu();

      expect(
        screen
          .getAllByRole('menuitemradio')
          .filter((option) => option.hasAttribute('aria-disabled'))
      ).toEqual([]);
    });

    it('never locks the mode the composer is already in', async () => {
      renderMenu({ premiumAccess: AWAITING, activeModality: 'image' });

      await openMenu();

      expect(item('Image')).not.toHaveAttribute('aria-disabled');
    });

    it('cannot be chosen', async () => {
      const onSelect = vi.fn();
      renderMenu({ premiumAccess: FREE_TIER, onSelect });
      const user = await openMenu();

      await user.click(item('Image'));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('cannot be chosen from the keyboard', async () => {
      const onSelect = vi.fn();
      renderMenu({ isAuthenticated: false, onSelect });
      const user = await openMenu();
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(item('Image')).toHaveFocus();

      await user.keyboard('{Enter}');

      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('from 768px', () => {
    it('opens anchored below the "+"', async () => {
      renderMenu();

      await openMenu();

      expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'bottom');
    });

    it('lines the menu up with the start of the "+"', async () => {
      renderMenu();

      await openMenu();

      expect(screen.getByRole('menu')).toHaveAttribute('data-align', 'start');
    });

    it('opens at least 12rem wide', async () => {
      renderMenu();

      await openMenu();

      expect(screen.getByRole('menu')).toHaveClass('min-w-48');
    });

    it("opens 0.5rem below the element it is anchored to, at that element's left edge", async () => {
      stubBoxes();
      const anchor = document.createElement('div');
      anchor.dataset['testid'] = 'composer-box';
      document.body.append(anchor);
      render(
        <ModeMenu
          activeModality="text"
          onSelect={vi.fn()}
          isAuthenticated
          premiumAccess={PREMIUM}
          audioEnabled={false}
          anchor={{ current: anchor }}
        />
      );

      await openMenu();

      expect(await placedAt()).toEqual({ x: COMPOSER.left, y: COMPOSER.top + COMPOSER.height + 8 });
      anchor.remove();
    });

    it('opens no sheet', async () => {
      renderMenu();

      await openMenu();

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('below 768px', () => {
    it('opens a sheet titled "Change mode"', async () => {
      installPhoneViewport();
      renderMenu();

      await openMenu();

      expect(screen.getByRole('dialog', { name: 'Change mode' })).toHaveTextContent('Change mode');
    });

    it('keeps the modes as radio items in the sheet', async () => {
      installPhoneViewport();
      renderMenu({ activeModality: 'video' });

      await openMenu();

      expect(item('Video')).toHaveAttribute('aria-checked', 'true');
    });

    it('reports the mode chosen in the sheet', async () => {
      installPhoneViewport();
      const onSelect = vi.fn();
      renderMenu({ onSelect });
      await openMenu();

      fireEvent.click(item('Image'));

      expect(onSelect).toHaveBeenCalledWith('image');
    });

    it('keeps the locked reason in the sheet', async () => {
      installPhoneViewport();
      renderMenu({ premiumAccess: FREE_TIER });

      await openMenu();

      expect(item('Video')).toHaveAccessibleDescription('Add credit to unlock video generation');
    });

    it('refuses a locked mode in the sheet', async () => {
      installPhoneViewport();
      const onSelect = vi.fn();
      renderMenu({ premiumAccess: FREE_TIER, onSelect });
      await openMenu();

      fireEvent.click(item('Image'));

      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('the mode chip', () => {
    it.each([
      ['image', 'Mode: image'],
      ['video', 'Mode: video'],
      ['audio', 'Mode: audio'],
    ] as const)('sits pressed beside "+" in %s mode', (modality, name) => {
      renderMenu({ activeModality: modality, audioEnabled: true });

      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows the mode by name', () => {
      renderMenu({ activeModality: 'image' });

      expect(screen.getByRole('button', { name: 'Mode: image' })).toHaveTextContent('Image');
    });

    it('draws the mode icon', () => {
      renderMenu({ activeModality: 'video' });

      expect(
        screen.getByRole('button', { name: 'Mode: video' }).querySelector('svg.lucide-video')
      ).not.toBeNull();
    });

    it('follows the "+"', () => {
      renderMenu({ activeModality: 'image' });

      const chip = screen.getByRole('button', { name: 'Mode: image' });
      expect(trigger().compareDocumentPosition(chip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('is absent in text mode', () => {
      renderMenu({ activeModality: 'text' });

      expect(screen.queryByRole('button', { name: /^Mode:/ })).not.toBeInTheDocument();
    });

    it('returns the composer to text when pressed', async () => {
      const onSelect = vi.fn();
      renderMenu({ activeModality: 'image', onSelect });

      await userEvent.setup().click(screen.getByRole('button', { name: 'Mode: image' }));

      expect(onSelect).toHaveBeenCalledWith('text');
    });

    it('hands focus to the "+" once pressed', async () => {
      render(<StatefulMenu initial="image" />);

      await userEvent.setup().click(screen.getByRole('button', { name: 'Mode: image' }));

      expect(trigger()).toHaveFocus();
    });
  });
});

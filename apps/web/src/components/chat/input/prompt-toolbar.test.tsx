import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, onTestFinished, vi } from 'vitest';
import { MOBILE_BREAKPOINT } from '@hushbox/shared';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import { ModeMenu } from './mode-menu';
import { ComposerNarrowRows, type ChatSearchProps } from './prompt-toolbar';
import type { useReasoningEffort as realUseReasoningEffort } from '@/hooks/chat/use-reasoning-effort';

type EffortState = ReturnType<typeof realUseReasoningEffort>;

const { effortState } = vi.hoisted(() => ({
  effortState: {
    current: {
      preferred: 'auto',
      effective: 'medium',
      models: [],
      setSelection: (): void => undefined,
    } as EffortState,
  },
}));

vi.mock('@/hooks/chat/use-reasoning-effort', () => ({
  useReasoningEffort: (): EffortState => effortState.current,
}));

const originalMatchMedia = globalThis.matchMedia;

/** A window one pixel under the desktop band, so the menus present as sheets. */
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

beforeEach(() => {
  effortState.current = {
    preferred: 'medium',
    effective: 'medium',
    models: [],
    setSelection: (): void => undefined,
  };
  useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
});

// The root font is 16px here, so the 20rem floor is 320px.
const NARROW_PX = 319;
const WIDE_PX = 320;

/** A composer element whose box is `width` pixels wide. */
function composerOf(width: number): React.RefObject<HTMLElement | null> {
  const element = document.createElement('div');
  document.body.append(element);
  const spy = vi
    .spyOn(element, 'getBoundingClientRect')
    .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width, height: 120 }));
  onTestFinished(() => {
    spy.mockRestore();
    element.remove();
  });
  return { current: element };
}

function makeSearch(overrides: Partial<ChatSearchProps> = {}): ChatSearchProps {
  return {
    webSearchEnabled: false,
    canUseWebSearch: true,
    onToggleWebSearch: vi.fn(),
    ...overrides,
  };
}

interface RenderOptions {
  width?: number;
  /** The composer's search toggle; `null` for a composer that offers none. */
  search?: ChatSearchProps | null;
  onOpenEffort?: () => void;
}

function renderRows({
  width = NARROW_PX,
  search: givenSearch = makeSearch(),
  onOpenEffort = vi.fn(),
}: RenderOptions = {}): void {
  const search = givenSearch ?? undefined;
  const composer = composerOf(width);
  render(
    <ModeMenu
      activeModality="text"
      onSelect={vi.fn()}
      isAuthenticated
      premiumAccess={{ status: 'known', canAccessPremium: true }}
      audioEnabled={false}
      extraRows={
        <ComposerNarrowRows composer={composer} search={search} onOpenEffort={onOpenEffort} />
      }
    />
  );
}

async function openPlusMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Change mode' }));
  await screen.findByRole('menu');
  return user;
}

function searchRow(): HTMLElement {
  return screen.getByRole('menuitemcheckbox', { name: 'Search' });
}

function effortRow(): HTMLElement {
  return screen.getByRole('menuitem', { name: /^Effort/u });
}

describe('ComposerNarrowRows', () => {
  describe('on a composer under 20rem', () => {
    it('adds a Search row to the menu', async () => {
      renderRows();
      await openPlusMenu();
      expect(searchRow()).toBeInTheDocument();
    });

    it('shows search off as an unchecked row', async () => {
      renderRows();
      await openPlusMenu();
      expect(searchRow()).toHaveAttribute('aria-checked', 'false');
    });

    it('shows search on as a checked row', async () => {
      renderRows({ search: makeSearch({ webSearchEnabled: true }) });
      await openPlusMenu();
      expect(searchRow()).toHaveAttribute('aria-checked', 'true');
    });

    it('toggles search from the row', async () => {
      const onToggleWebSearch = vi.fn();
      renderRows({ search: makeSearch({ onToggleWebSearch }) });
      const user = await openPlusMenu();
      await user.click(searchRow());
      expect(onToggleWebSearch).toHaveBeenCalledOnce();
    });

    it("gives a visitor today's sign-up reason on the Search row", async () => {
      renderRows({ search: makeSearch({ canUseWebSearch: false }) });
      await openPlusMenu();
      expect(searchRow()).toHaveAccessibleDescription('Sign up to access internet search');
    });

    it("refuses a visitor's press on the Search row", async () => {
      const onToggleWebSearch = vi.fn();
      renderRows({ search: makeSearch({ canUseWebSearch: false, onToggleWebSearch }) });
      const user = await openPlusMenu();
      await user.click(searchRow());
      expect(onToggleWebSearch).not.toHaveBeenCalled();
    });

    it('marks the Search row disabled for a visitor', async () => {
      renderRows({ search: makeSearch({ canUseWebSearch: false }) });
      await openPlusMenu();
      expect(searchRow()).toHaveAttribute('aria-disabled', 'true');
    });

    it('adds an Effort row named with the current word', async () => {
      renderRows();
      await openPlusMenu();
      expect(effortRow()).toHaveAccessibleName('Effort: Mid');
    });

    it('shows the current word on the Effort row', async () => {
      renderRows();
      await openPlusMenu();
      expect(
        within(effortRow()).getByText('Mid', { selector: '[aria-hidden="true"]' })
      ).toBeVisible();
    });

    it('opens the effort menu from the Effort row', async () => {
      const onOpenEffort = vi.fn();
      renderRows({ onOpenEffort });
      const user = await openPlusMenu();
      await user.click(effortRow());
      expect(onOpenEffort).toHaveBeenCalledOnce();
    });

    it('closes the + menu as the Effort row opens the effort menu', async () => {
      renderRows();
      const user = await openPlusMenu();
      await user.click(effortRow());
      expect(screen.queryByRole('menu', { name: 'Change mode' })).not.toBeInTheDocument();
    });

    it('draws no Effort row while the turn carries no effort', async () => {
      effortState.current = { ...effortState.current, effective: undefined, models: undefined };
      renderRows();
      await openPlusMenu();
      expect(screen.queryByRole('menuitem', { name: /^Effort/u })).not.toBeInTheDocument();
    });

    it('draws no Search row where the composer offers no search', async () => {
      renderRows({ search: null });
      await openPlusMenu();
      expect(screen.queryByRole('menuitemcheckbox', { name: 'Search' })).not.toBeInTheDocument();
    });

    it('keeps both rows in the phone sheet', async () => {
      installPhoneViewport();
      renderRows();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Change mode' }));
      await screen.findByRole('dialog', { name: 'Change mode' });
      expect(searchRow()).toBeInTheDocument();
      expect(effortRow()).toBeInTheDocument();
    });

    it('opens the effort menu from the Effort row in the phone sheet', async () => {
      installPhoneViewport();
      const onOpenEffort = vi.fn();
      renderRows({ onOpenEffort });
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Change mode' }));
      await screen.findByRole('dialog', { name: 'Change mode' });
      fireEvent.click(effortRow());
      expect(onOpenEffort).toHaveBeenCalledOnce();
    });
  });

  describe('on a composer 20rem or wider', () => {
    it('adds no Search row', async () => {
      renderRows({ width: WIDE_PX });
      await openPlusMenu();
      expect(screen.queryByRole('menuitemcheckbox', { name: 'Search' })).not.toBeInTheDocument();
    });

    it('adds no Effort row', async () => {
      renderRows({ width: WIDE_PX });
      await openPlusMenu();
      expect(screen.queryByRole('menuitem', { name: /^Effort/u })).not.toBeInTheDocument();
    });

    it('keeps only the modes in the menu', async () => {
      renderRows({ width: WIDE_PX });
      await openPlusMenu();
      const menu = screen.getByRole('menu');
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
      expect(within(menu).queryAllByRole('menuitem')).toHaveLength(0);
      expect(within(menu).queryAllByRole('menuitemcheckbox')).toHaveLength(0);
    });
  });

  it('adds no rows before the composer has mounted', async () => {
    render(
      <ModeMenu
        activeModality="text"
        onSelect={vi.fn()}
        isAuthenticated
        premiumAccess={{ status: 'known', canAccessPremium: true }}
        audioEnabled={false}
        extraRows={
          <ComposerNarrowRows
            composer={{ current: null }}
            search={makeSearch()}
            onOpenEffort={vi.fn()}
          />
        }
      />
    );
    await openPlusMenu();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Search' })).not.toBeInTheDocument();
  });

  it("adds the rows once the open menu's composer narrows under 20rem", async () => {
    const watchers = new Map<Element, () => void>();
    class RecordingResizeObserver {
      readonly #notify: () => void;
      constructor(notify: () => void) {
        this.#notify = notify;
      }
      observe(element: Element): void {
        watchers.set(element, this.#notify);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const composer = composerOf(WIDE_PX);
    const element = composer.current;
    if (element === null) throw new Error('the composer is mounted');
    render(
      <ModeMenu
        activeModality="text"
        onSelect={vi.fn()}
        isAuthenticated
        premiumAccess={{ status: 'known', canAccessPremium: true }}
        audioEnabled={false}
        extraRows={
          <ComposerNarrowRows composer={composer} search={makeSearch()} onOpenEffort={vi.fn()} />
        }
      />
    );
    await openPlusMenu();
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: NARROW_PX, height: 120 })
    );

    act(() => {
      watchers.get(element)?.();
    });

    expect(searchRow()).toBeInTheDocument();
  });

  it('stops watching the composer once the menu closes', async () => {
    const watching = new Set<Element>();
    class RecordingResizeObserver {
      readonly #observed: Element[] = [];
      observe(element: Element): void {
        this.#observed.push(element);
        watching.add(element);
      }
      unobserve(): void {}
      disconnect(): void {
        for (const element of this.#observed) watching.delete(element);
      }
    }
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const composer = composerOf(NARROW_PX);
    const element = composer.current;
    if (element === null) throw new Error('the composer is mounted');
    render(
      <ModeMenu
        activeModality="text"
        onSelect={vi.fn()}
        isAuthenticated
        premiumAccess={{ status: 'known', canAccessPremium: true }}
        audioEnabled={false}
        extraRows={
          <ComposerNarrowRows composer={composer} search={makeSearch()} onOpenEffort={vi.fn()} />
        }
      />
    );
    const user = await openPlusMenu();
    expect(watching.has(element)).toBe(true);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(watching.has(element)).toBe(false);
    });
  });

  it('follows the root text size, so larger text narrows the composer in rem', async () => {
    const root = document.documentElement;
    const previous = root.style.fontSize;
    root.style.fontSize = '24px';
    onTestFinished(() => {
      root.style.fontSize = previous;
    });
    renderRows({ width: 400 });
    await openPlusMenu();
    expect(searchRow()).toBeInTheDocument();
  });
});

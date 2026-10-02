import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RightPane, RightPaneHostContext } from '@/components/shared/right-pane';
import { useRightPane } from '@/stores/ui/right-pane';
import { useUIStore } from '@/stores/ui/ui';
import { useExpandSidebar, useSidebarRail } from './use-sidebar-rail';

const originalMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, the band the sidebar draws as a phone drawer. */
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

describe('useSidebarRail', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
    useRightPane.setState({ active: null });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
  });

  it('is off while the saved choice is open and no pane is docked', () => {
    const { result } = renderHook(() => useSidebarRail());

    expect(result.current).toBe(false);
  });

  it('is on while the saved choice is the rail', () => {
    useUIStore.setState({ sidebarOpen: false });

    const { result } = renderHook(() => useSidebarRail());

    expect(result.current).toBe(true);
  });

  it('is on while a pane is docked, whatever the saved choice', () => {
    useRightPane.setState({ active: 'members' });

    const { result } = renderHook(() => useSidebarRail());

    expect(result.current).toBe(true);
  });

  it('turns off again as the pane closes', () => {
    useRightPane.setState({ active: 'members' });
    const { result } = renderHook(() => useSidebarRail());

    act(() => {
      useRightPane.getState().close();
    });

    expect(result.current).toBe(false);
  });

  it('is never on in the phone drawer, even with a pane open and the rail saved', () => {
    stubPhoneWidth();
    useUIStore.setState({ sidebarOpen: false });
    useRightPane.setState({ active: 'members' });

    const { result } = renderHook(() => useSidebarRail());

    expect(result.current).toBe(false);
  });
});

describe('useExpandSidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: false });
    useRightPane.setState({ active: null });
  });

  it('opens the sidebar', () => {
    const { result } = renderHook(() => useExpandSidebar());

    act(() => {
      result.current();
    });

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('closes a docked pane, giving its room back to the sidebar', () => {
    useRightPane.setState({ active: 'members' });
    const { result } = renderHook(() => useExpandSidebar());

    act(() => {
      result.current();
    });

    expect(useRightPane.getState().active).toBeNull();
  });

  it('keeps a saved open sidebar open when it expands over a pane', () => {
    useUIStore.setState({ sidebarOpen: true });
    useRightPane.setState({ active: 'members' });
    const { result } = renderHook(() => useExpandSidebar());

    act(() => {
      result.current();
    });

    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });
});

describe('useSidebarRail beside a shown pane', () => {
  /** Sets the window's width and the root font size the pane's rem widths resolve against. */
  function setWindow(width: number, rootPx: number): void {
    const originalWidth = globalThis.innerWidth;
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: width });
    document.documentElement.style.fontSize = `${String(rootPx)}px`;
    onTestFinished(() => {
      Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: originalWidth });
      document.documentElement.style.fontSize = '';
    });
  }

  /** The shell's slot with one open 22rem pane in it, around the hook under test. */
  function PaneShell({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    const [host, setHost] = React.useState<HTMLElement | null>(null);
    return React.createElement(
      RightPaneHostContext,
      { value: host },
      children,
      React.createElement(RightPane, {
        id: 'pane',
        title: 'Pane',
        width: '22rem',
        surface: 'background',
        head: 'display',
        phone: 'sheet',
        onClose: (): void => undefined,
        children: 'body',
      }),
      React.createElement('div', { ref: setHost })
    );
  }

  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
    useRightPane.setState({ active: 'pane' });
  });

  it('is on beside a pane docked at 768 with default text', () => {
    setWindow(768, 17);

    const { result } = renderHook(() => useSidebarRail(), { wrapper: PaneShell });

    expect(result.current).toBe(true);
  });

  it('is off beside a pane that takes its sheet form at 768 with 141% text', () => {
    setWindow(768, 24);

    const { result } = renderHook(() => useSidebarRail(), { wrapper: PaneShell });

    expect(result.current).toBe(false);
  });
});

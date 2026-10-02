import * as React from 'react';
import { act, renderHook } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { useFormFactor as publishedUseFormFactor } from '@hushbox/ui/platform';

import { TouchDeviceOverrideContext } from '../../hooks/touch-device-override-context';

import { useFormFactor } from './use-form-factor';

interface MediaHarness {
  readonly resize: (width: number) => void;
  readonly setPointer: (pointer: 'fine' | 'coarse') => void;
  readonly liveListenerCount: () => number;
}

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MediaListStub {
  readonly matches: boolean;
  readonly media: string;
  readonly addEventListener: (type: 'change', listener: ChangeListener) => void;
  readonly removeEventListener: (type: 'change', listener: ChangeListener) => void;
}

function matchesQuery(query: string, width: number, pointer: 'fine' | 'coarse'): boolean {
  const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
  if (maxWidth?.[1] !== undefined) return width <= Number(maxWidth[1]);
  if (query === '(pointer: coarse)') return pointer === 'coarse';
  throw new Error(`unexpected media query: ${query}`);
}

function installMedia(initialWidth: number, initialPointer: 'fine' | 'coarse'): MediaHarness {
  let width = initialWidth;
  let pointer = initialPointer;
  const listeners = new Map<string, Set<ChangeListener>>();

  const notify = (): void => {
    for (const [query, set] of listeners) {
      const matches = matchesQuery(query, width, pointer);
      for (const listener of set) {
        // The band and pointer listeners read only `matches`.
        listener({ matches, media: query } as MediaQueryListEvent);
      }
    }
  };

  const matchMedia = (query: string): MediaQueryList => {
    const set = listeners.get(query) ?? new Set<ChangeListener>();
    listeners.set(query, set);
    const list: MediaListStub = {
      matches: matchesQuery(query, width, pointer),
      media: query,
      addEventListener: (_type, listener): void => {
        set.add(listener);
      },
      removeEventListener: (_type, listener): void => {
        set.delete(listener);
      },
    };
    // The hooks under test read only `matches` and the change-listener pair.
    return list as MediaQueryList;
  };

  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });

  return {
    resize: (next): void => {
      width = next;
      notify();
    },
    setPointer: (next): void => {
      pointer = next;
      notify();
    },
    liveListenerCount: (): number => {
      let count = 0;
      for (const set of listeners.values()) count += set.size;
      return count;
    },
  };
}

function overrideWrapper(
  override: boolean
): (props: { readonly children: React.ReactNode }) => React.ReactElement {
  return ({ children }) =>
    React.createElement(TouchDeviceOverrideContext.Provider, { value: override }, children);
}

const originalMatchMedia = globalThis.matchMedia;

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('useFormFactor', () => {
  it('reports the desktop band at 768px', () => {
    installMedia(768, 'fine');

    const { result } = renderHook(() => useFormFactor());

    expect(result.current.band).toBe('desktop');
  });

  it('reports the phone band at 767px', () => {
    installMedia(767, 'fine');

    const { result } = renderHook(() => useFormFactor());

    expect(result.current.band).toBe('phone');
  });

  it('reports a fine pointer when the primary pointer is fine', () => {
    installMedia(1024, 'fine');

    const { result } = renderHook(() => useFormFactor());

    expect(result.current.pointer).toBe('fine');
  });

  it('reports a coarse pointer when the primary pointer is coarse', () => {
    installMedia(1024, 'coarse');

    const { result } = renderHook(() => useFormFactor());

    expect(result.current.pointer).toBe('coarse');
  });

  it('reports a coarse pointer when the touch override is on over a fine pointer', () => {
    installMedia(1024, 'fine');

    const { result } = renderHook(() => useFormFactor(), { wrapper: overrideWrapper(true) });

    expect(result.current.pointer).toBe('coarse');
  });

  it('reports a fine pointer when the touch override is off over a coarse pointer', () => {
    installMedia(1024, 'coarse');

    const { result } = renderHook(() => useFormFactor(), { wrapper: overrideWrapper(false) });

    expect(result.current.pointer).toBe('fine');
  });

  it('moves to the phone band when the window narrows below 768px', () => {
    const media = installMedia(768, 'fine');
    const { result } = renderHook(() => useFormFactor());

    act(() => {
      media.resize(767);
    });

    expect(result.current.band).toBe('phone');
  });

  it('moves to the desktop band when the window widens to 768px', () => {
    const media = installMedia(767, 'fine');
    const { result } = renderHook(() => useFormFactor());

    act(() => {
      media.resize(768);
    });

    expect(result.current.band).toBe('desktop');
  });

  it('follows a pointer query change', () => {
    const media = installMedia(1024, 'fine');
    const { result } = renderHook(() => useFormFactor());

    act(() => {
      media.setPointer('coarse');
    });

    expect(result.current.pointer).toBe('coarse');
  });

  it('removes its media listeners on unmount', () => {
    const media = installMedia(1024, 'fine');
    const { unmount } = renderHook(() => useFormFactor());

    unmount();

    expect(media.liveListenerCount()).toBe(0);
  });

  it('server-renders the desktop band and a fine pointer when there is no window', () => {
    const Probe = (): React.ReactElement => {
      const { band, pointer } = useFormFactor();
      return React.createElement('span', { 'data-band': band, 'data-pointer': pointer });
    };
    const originalWindow: unknown = Reflect.get(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'window');
    try {
      const html = renderToStaticMarkup(React.createElement(Probe));

      expect(html).toBe('<span data-band="desktop" data-pointer="fine"></span>');
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    }
  });

  it('is published at @hushbox/ui/platform', () => {
    expect(publishedUseFormFactor).toBe(useFormFactor);
  });

  it('returns exactly the band and pointer unions', () => {
    expectTypeOf(useFormFactor).returns.toEqualTypeOf<{
      readonly band: 'phone' | 'desktop';
      readonly pointer: 'fine' | 'coarse';
    }>();
  });
});

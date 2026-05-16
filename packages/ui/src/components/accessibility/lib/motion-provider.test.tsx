import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const motionConfigCalls: {
  reducedMotion: 'always' | 'never' | undefined;
  skipAnimations: boolean | undefined;
}[] = [];

vi.mock('framer-motion', () => ({
  MotionConfig: ({
    children,
    reducedMotion,
    skipAnimations,
  }: {
    children: React.ReactNode;
    reducedMotion?: 'always' | 'never';
    skipAnimations?: boolean;
  }) => {
    motionConfigCalls.push({ reducedMotion, skipAnimations });
    return <div data-testid="motion-config-mock">{children}</div>;
  },
}));

const stopAnimationsRef: { current: boolean } = { current: false };

vi.mock('../store', () => ({
  useA11yStore: <T,>(selector: (state: { stopAnimations: boolean }) => T): T =>
    selector({ stopAnimations: stopAnimationsRef.current }),
}));

import { MotionProvider } from './motion-provider';

describe('MotionProvider', () => {
  beforeEach(() => {
    motionConfigCalls.length = 0;
    stopAnimationsRef.current = false;
  });

  it('renders its children', () => {
    render(
      <MotionProvider>
        <span data-testid="child">hello</span>
      </MotionProvider>
    );
    expect(screen.getByTestId('child').textContent).toBe('hello');
  });

  it('wraps children in framer-motion MotionConfig', () => {
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(screen.getByTestId('motion-config-mock')).not.toBeNull();
  });

  it('passes reducedMotion="always" when stopAnimations is true', () => {
    stopAnimationsRef.current = true;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('always');
  });

  it('passes skipAnimations=true when reduced motion is on (Framer\'s reducedMotion only zeros positional keys — opacity/margin etc. still animate without skipAnimations)', () => {
    stopAnimationsRef.current = true;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.skipAnimations).toBe(true);
  });

  it('passes reducedMotion="never" when stopAnimations is false', () => {
    stopAnimationsRef.current = false;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('never');
  });

  it('does not skip animations when neither input is on', () => {
    stopAnimationsRef.current = false;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.skipAnimations).toBe(false);
  });

  it('passes reducedMotion="always" when only the OS prefers-reduced-motion media query matches', () => {
    stopAnimationsRef.current = false;
    const originalMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    try {
      render(
        <MotionProvider>
          <span>x</span>
        </MotionProvider>
      );
      expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('always');
    } finally {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});

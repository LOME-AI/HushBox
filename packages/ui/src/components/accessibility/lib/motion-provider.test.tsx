import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const motionConfigCalls: { reducedMotion: 'always' | 'never' | undefined }[] = [];

vi.mock('framer-motion', () => ({
  MotionConfig: ({
    children,
    reducedMotion,
  }: {
    children: React.ReactNode;
    reducedMotion?: 'always' | 'never';
  }) => {
    motionConfigCalls.push({ reducedMotion });
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

  it('passes reducedMotion="never" when stopAnimations is false', () => {
    stopAnimationsRef.current = false;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('never');
  });
});

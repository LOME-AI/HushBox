import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock framer-motion's MotionConfig as a passthrough that captures props.
// We expose the captured props on a module-level holder so individual tests can
// assert what the wrapper passed.
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

// Mocked store + os-preferences so we can drive each branch independently.
const stopAnimationsRef: { current: 'system' | 'force-on' | 'force-off' } = { current: 'system' };
const osReducedRef: { current: boolean } = { current: false };

vi.mock('../store', () => ({
  useA11yStore: <T,>(
    selector: (state: { stopAnimations: 'system' | 'force-on' | 'force-off' }) => T
  ): T => selector({ stopAnimations: stopAnimationsRef.current }),
}));

vi.mock('../hooks/use-os-preferences', () => ({
  useOsPreferences: (): { reducedMotion: boolean } => ({ reducedMotion: osReducedRef.current }),
}));

// Import AFTER the mocks above so the SUT picks them up.
import { MotionProvider } from './motion-provider';

describe('MotionProvider', () => {
  beforeEach(() => {
    motionConfigCalls.length = 0;
    stopAnimationsRef.current = 'system';
    osReducedRef.current = false;
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

  it('passes reducedMotion="always" when stopAnimations is "force-on"', () => {
    stopAnimationsRef.current = 'force-on';
    osReducedRef.current = false;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('always');
  });

  it('passes reducedMotion="always" when stopAnimations is "force-on" even if OS does NOT prefer reduced motion', () => {
    stopAnimationsRef.current = 'force-on';
    osReducedRef.current = false;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('always');
  });

  it('passes reducedMotion="never" when stopAnimations is "force-off"', () => {
    stopAnimationsRef.current = 'force-off';
    osReducedRef.current = true;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('never');
  });

  it('passes reducedMotion="never" when stopAnimations is "force-off" even if OS DOES prefer reduced motion', () => {
    stopAnimationsRef.current = 'force-off';
    osReducedRef.current = true;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('never');
  });

  it('passes reducedMotion="always" when stopAnimations is "system" AND OS prefers reduced motion', () => {
    stopAnimationsRef.current = 'system';
    osReducedRef.current = true;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('always');
  });

  it('passes reducedMotion="never" when stopAnimations is "system" AND OS does NOT prefer reduced motion', () => {
    stopAnimationsRef.current = 'system';
    osReducedRef.current = false;
    render(
      <MotionProvider>
        <span>x</span>
      </MotionProvider>
    );
    expect(motionConfigCalls.at(-1)?.reducedMotion).toBe('never');
  });
});

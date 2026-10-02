import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { MorphWidth } from './morph-width';
import { MOTION_TRANSITION } from './motion-transition';
import { ResizeObserverDouble } from './motion-doubles.setup';

vi.mock('framer-motion', async () => {
  const { framerMotionDouble } = await import('./motion-doubles.setup');
  return framerMotionDouble;
});

function motionWrapper(): HTMLElement | null {
  return screen.getByTestId('label').closest<HTMLElement>('[data-motion="true"]');
}

describe('MorphWidth', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
    ResizeObserverDouble.instances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverDouble);
  });

  afterEach(() => {
    act(() => {
      useA11yStore.getState().reset();
    });
    vi.unstubAllGlobals();
  });

  it('tweens its width to the measured width of its content', () => {
    render(
      <MorphWidth>
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    act(() => {
      ResizeObserverDouble.instances[0]?.resize('offsetWidth', 120);
    });

    expect(motionWrapper()?.dataset['animate']).toBe(JSON.stringify({ width: 120 }));
  });

  it('starts at its content width without tweening in on mount', () => {
    render(
      <MorphWidth>
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(motionWrapper()?.dataset['initial']).toBe('false');
  });

  it('times the tween by the deliberate motion transition', () => {
    render(
      <MorphWidth>
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(motionWrapper()?.dataset['transition']).toBe(
      JSON.stringify(MOTION_TRANSITION.deliberate)
    );
  });

  it('marks the tweened wrapper as animated', () => {
    render(
      <MorphWidth>
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(motionWrapper()).toHaveAttribute('data-animated', 'true');
  });

  it('puts a given test id on its tweened root', () => {
    render(
      <MorphWidth data-testid="morph">
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(screen.getByTestId('morph')).toBe(motionWrapper());
  });

  it('puts a given test id on its root when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <MorphWidth data-testid="morph">
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(screen.getByTestId('morph')).toBe(
      screen.getByTestId('label').closest('[data-animated="false"]')
    );
  });

  it('renders its content with no tween when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <MorphWidth>
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(motionWrapper()).toBeNull();
    expect(screen.getByTestId('label').closest('[data-animated="false"]')).not.toBeNull();
  });

  it('measures nothing when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <MorphWidth>
        <span data-testid="label">Write</span>
      </MorphWidth>
    );

    expect(ResizeObserverDouble.instances).toHaveLength(0);
  });
});

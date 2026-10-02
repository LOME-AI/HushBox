import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { Collapse } from './collapse';
import { MOTION_TRANSITION } from './motion-transition';
import { ResizeObserverDouble } from './motion-doubles.setup';

vi.mock('framer-motion', async () => {
  const { framerMotionDouble } = await import('./motion-doubles.setup');
  return framerMotionDouble;
});

function motionWrapper(): HTMLElement | null {
  return screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
}

describe('Collapse', () => {
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

  it('reveals open content through a height and opacity tween', () => {
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    const wrapper = motionWrapper();
    expect(wrapper?.dataset['initial']).toBe(JSON.stringify({ height: 0, opacity: 0 }));
    expect(wrapper?.dataset['exit']).toBe(JSON.stringify({ height: 0, opacity: 0 }));
  });

  it('times the tween by the base motion transition', () => {
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(motionWrapper()?.dataset['transition']).toBe(JSON.stringify(MOTION_TRANSITION.base));
  });

  it('marks the tweened wrapper as animated', () => {
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(motionWrapper()).toHaveAttribute('data-animated', 'true');
  });

  it('opens to the measured height of its content', () => {
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    act(() => {
      ResizeObserverDouble.instances[0]?.resize('offsetHeight', 48);
    });

    expect(motionWrapper()?.dataset['animate']).toBe(JSON.stringify({ height: 48, opacity: 1 }));
  });

  it('follows its content to a new height while open', () => {
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );
    act(() => {
      ResizeObserverDouble.instances[0]?.resize('offsetHeight', 48);
    });

    act(() => {
      ResizeObserverDouble.instances[0]?.resize('offsetHeight', 96);
    });

    expect(motionWrapper()?.dataset['animate']).toBe(JSON.stringify({ height: 96, opacity: 1 }));
  });

  it('measures content that opens after mounting closed', () => {
    const { rerender } = render(
      <Collapse open={false}>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    rerender(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(ResizeObserverDouble.instances).toHaveLength(1);
  });

  it('clips only the vertical axis so horizontally overflowing children stay clickable', () => {
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(motionWrapper()).toHaveClass('overflow-y-hidden');
  });

  it('renders nothing while closed', () => {
    render(
      <Collapse open={false}>
        <span data-testid="child">hidden</span>
      </Collapse>
    );

    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('removes its content when it closes', () => {
    const { rerender } = render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    rerender(
      <Collapse open={false}>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('renders open content with no tween when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(motionWrapper()).toBeNull();
    expect(screen.getByTestId('child').parentElement).toHaveAttribute('data-animated', 'false');
  });

  it('measures nothing when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    expect(ResizeObserverDouble.instances).toHaveLength(0);
  });

  it('renders nothing while closed when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <Collapse open={false}>
        <span data-testid="child">hidden</span>
      </Collapse>
    );

    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('stops observing its content when it unmounts', () => {
    const { unmount } = render(
      <Collapse open>
        <span data-testid="child">visible</span>
      </Collapse>
    );

    unmount();

    expect(ResizeObserverDouble.instances[0]?.observed).toHaveLength(0);
  });
});

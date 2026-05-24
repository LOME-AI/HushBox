import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MorphHeight } from './morph-height';

interface MockMotionDivProps extends React.HTMLAttributes<HTMLDivElement> {
  initial?: unknown;
  animate?: unknown;
  transition?: unknown;
}

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const MotionDiv = ReactModule.forwardRef<HTMLDivElement, MockMotionDivProps>(
    ({ children, initial, animate, transition, ...rest }, ref) => (
      <div
        ref={ref}
        data-motion="true"
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-transition={JSON.stringify(transition)}
        {...rest}
      >
        {children}
      </div>
    )
  );
  MotionDiv.displayName = 'MotionDivMock';
  return { motion: { div: MotionDiv } };
});

class ResizeObserverMock {
  static readonly instances: ResizeObserverMock[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed = [];
  }
  trigger(target: Element, height: number): void {
    Object.defineProperty(target, 'offsetHeight', { configurable: true, value: height });
    this.callback(
      [{ target, contentRect: { height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
}

beforeEach(() => {
  ResizeObserverMock.instances.length = 0;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
    ResizeObserverMock;
});

describe('MorphHeight', () => {
  it('renders children', () => {
    render(
      <MorphHeight>
        <div data-testid="child">content</div>
      </MorphHeight>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('wraps content in a motion.div with overflow-y-hidden', () => {
    // Only the vertical axis is clipped: horizontal clipping silently
    // swallows clicks on overflowing children (see comment on
    // morph-height.tsx). Asserting the precise class catches accidental
    // regressions to `overflow-hidden`.
    render(
      <MorphHeight>
        <div data-testid="child">content</div>
      </MorphHeight>
    );
    const wrapper = screen.getByTestId('child').closest('[data-motion="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass('overflow-y-hidden');
  });

  it('uses an easeInOut transition on height with a finite duration', () => {
    render(
      <MorphHeight>
        <div data-testid="child">content</div>
      </MorphHeight>
    );
    const wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    const transition = JSON.parse(wrapper?.dataset['transition'] ?? '{}') as {
      duration?: number;
      ease?: string;
    };
    expect(transition.ease).toBe('easeInOut');
    expect(typeof transition.duration).toBe('number');
    expect(transition.duration).toBeGreaterThan(0);
  });

  it('does not animate from height: 0 (no slam-shut between modality swaps)', () => {
    render(
      <MorphHeight>
        <div data-testid="child">content</div>
      </MorphHeight>
    );
    const wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    const initial = wrapper?.dataset['initial'] ?? '';
    expect(initial).not.toContain('"height":0');
  });

  it('animates outer height to match measured inner content height', () => {
    const { rerender } = render(
      <MorphHeight>
        <div data-testid="child">content</div>
      </MorphHeight>
    );
    const observerInstance = ResizeObserverMock.instances[0];
    expect(observerInstance).toBeDefined();
    const observed = observerInstance?.observed[0];
    expect(observed).toBeDefined();
    if (!observerInstance || !observed) return;

    act(() => {
      observerInstance.trigger(observed, 80);
    });

    let wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    let animate = JSON.parse(wrapper?.dataset['animate'] ?? '{}') as { height?: number };
    expect(animate.height).toBe(80);

    rerender(
      <MorphHeight>
        <div data-testid="child">taller content here</div>
      </MorphHeight>
    );
    act(() => {
      observerInstance.trigger(observed, 140);
    });

    wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    animate = JSON.parse(wrapper?.dataset['animate'] ?? '{}') as { height?: number };
    expect(animate.height).toBe(140);
  });
});

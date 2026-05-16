import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MorphWidth } from './morph-width';

interface MockMotionSpanProps extends React.HTMLAttributes<HTMLSpanElement> {
  initial?: unknown;
  animate?: unknown;
  transition?: unknown;
}

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const MotionSpan = ReactModule.forwardRef<HTMLSpanElement, MockMotionSpanProps>(
    ({ children, initial, animate, transition, ...rest }, ref) => (
      <span
        ref={ref}
        data-motion="true"
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-transition={JSON.stringify(transition)}
        {...rest}
      >
        {children}
      </span>
    )
  );
  MotionSpan.displayName = 'MotionSpanMock';
  return { motion: { span: MotionSpan } };
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
  trigger(target: Element, width: number): void {
    Object.defineProperty(target, 'offsetWidth', { configurable: true, value: width });
    this.callback(
      [{ target, contentRect: { width } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
}

beforeEach(() => {
  ResizeObserverMock.instances.length = 0;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
    ResizeObserverMock;
});

describe('MorphWidth', () => {
  it('renders children', () => {
    render(
      <MorphWidth>
        <span data-testid="child">x</span>
      </MorphWidth>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('wraps content in a motion.span with overflow-hidden', () => {
    render(
      <MorphWidth>
        <span data-testid="child">x</span>
      </MorphWidth>
    );
    const wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.overflow).toBe('hidden');
  });

  it('uses an easeInOut transition with the supplied duration', () => {
    render(
      <MorphWidth duration={0.6}>
        <span data-testid="child">x</span>
      </MorphWidth>
    );
    const wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    const transition = JSON.parse(wrapper?.dataset['transition'] ?? '{}') as {
      duration?: number;
      ease?: string;
    };
    expect(transition.ease).toBe('easeInOut');
    expect(transition.duration).toBe(0.6);
  });

  it('animates outer width to match measured inner content width', () => {
    const { rerender } = render(
      <MorphWidth>
        <span data-testid="child">short</span>
      </MorphWidth>
    );
    const observerInstance = ResizeObserverMock.instances[0];
    expect(observerInstance).toBeDefined();
    const observed = observerInstance?.observed[0];
    expect(observed).toBeDefined();
    if (!observerInstance || !observed) return;

    act(() => {
      observerInstance.trigger(observed, 60);
    });
    let wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    let animate = JSON.parse(wrapper?.dataset['animate'] ?? '{}') as { width?: number };
    expect(animate.width).toBe(60);

    rerender(
      <MorphWidth>
        <span data-testid="child">a much longer label</span>
      </MorphWidth>
    );
    act(() => {
      observerInstance.trigger(observed, 220);
    });
    wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    animate = JSON.parse(wrapper?.dataset['animate'] ?? '{}') as { width?: number };
    expect(animate.width).toBe(220);
  });
});

import * as React from 'react';

interface MotionDoubleProps extends React.HTMLAttributes<HTMLElement> {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
}

function motionDouble(
  tag: 'div' | 'span'
): React.ForwardRefExoticComponent<MotionDoubleProps & React.RefAttributes<HTMLElement>> {
  const Double = React.forwardRef<HTMLElement, MotionDoubleProps>(
    ({ children, initial, animate, exit, transition, ...rest }, ref) =>
      React.createElement(
        tag,
        {
          ref,
          'data-motion': 'true',
          'data-initial': JSON.stringify(initial),
          'data-animate': JSON.stringify(animate),
          'data-exit': JSON.stringify(exit),
          'data-transition': JSON.stringify(transition),
          ...rest,
        },
        children
      )
  );
  Double.displayName = `Motion${tag}Double`;
  return Double;
}

interface AnimatePresenceDoubleProps {
  children?: React.ReactNode;
  initial?: boolean;
}

function AnimatePresenceDouble({
  children,
  initial,
}: Readonly<AnimatePresenceDoubleProps>): React.JSX.Element {
  return <div data-presence-initial={String(initial ?? true)}>{children}</div>;
}

/**
 * Stands in for framer-motion in the motion helpers' tests: each motion element
 * renders its tag with the animation props serialised onto data attributes, and
 * the presence boundary records its `initial` flag, so a test reads what a helper
 * asked framer-motion to do without running an animation loop.
 */
export const framerMotionDouble = {
  AnimatePresence: AnimatePresenceDouble,
  motion: { div: motionDouble('div'), span: motionDouble('span') },
};

/**
 * A ResizeObserver whose resize the test fires by hand: `resize` sets the
 * observed element's offset size and runs the callback, the way a real reflow
 * would reach the helpers that measure their content.
 */
export class ResizeObserverDouble implements ResizeObserver {
  static readonly instances: ResizeObserverDouble[] = [];
  readonly observed: Element[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverDouble.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    this.observed.length = 0;
  }

  disconnect(): void {
    this.observed.length = 0;
  }

  resize(axis: 'offsetWidth' | 'offsetHeight', value: number): void {
    for (const target of this.observed) {
      Object.defineProperty(target, axis, { configurable: true, value });
    }
    this.callback([], this);
  }
}

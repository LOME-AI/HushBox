import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnimatedHeight } from './animated-height';

interface MockMotionDivProps extends React.HTMLAttributes<HTMLDivElement> {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
}

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MotionDiv = React.forwardRef<HTMLDivElement, MockMotionDivProps>(
    ({ children, initial, animate, exit, transition, ...rest }, ref) => (
      <div
        ref={ref}
        data-motion="true"
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-exit={JSON.stringify(exit)}
        data-transition={JSON.stringify(transition)}
        {...rest}
      >
        {children}
      </div>
    )
  );
  MotionDiv.displayName = 'MotionDivMock';
  const AnimatePresence = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <>{children}</>
  );
  AnimatePresence.displayName = 'AnimatePresenceMock';
  return {
    AnimatePresence,
    motion: { div: MotionDiv },
  };
});

describe('AnimatedHeight', () => {
  it('renders children when truthy', () => {
    render(
      <AnimatedHeight>
        <span data-testid="child">visible</span>
      </AnimatedHeight>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('renders nothing when children is null', () => {
    const { container } = render(<AnimatedHeight>{null}</AnimatedHeight>);

    expect(container.querySelector('[data-testid="child"]')).toBeNull();
  });

  it('renders nothing when children is false', () => {
    const { container } = render(<AnimatedHeight>{false}</AnimatedHeight>);

    expect(container.querySelector('[data-testid="child"]')).toBeNull();
  });

  it('wraps children in a motion.div with overflow-hidden', () => {
    render(
      <AnimatedHeight>
        <span data-testid="child">visible</span>
      </AnimatedHeight>
    );

    const motionDiv = screen.getByTestId('child').closest('[data-motion="true"]');
    expect(motionDiv).not.toBeNull();
    expect(motionDiv).toHaveClass('overflow-hidden');
  });

  it('uses the expected initial / animate / exit / transition props', () => {
    render(
      <AnimatedHeight>
        <span data-testid="child">visible</span>
      </AnimatedHeight>
    );

    const motionDiv = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    expect(motionDiv).not.toBeNull();
    expect(motionDiv?.dataset['initial']).toBe(JSON.stringify({ height: 0, opacity: 0 }));
    expect(motionDiv?.dataset['animate']).toBe(JSON.stringify({ height: 'auto', opacity: 1 }));
    expect(motionDiv?.dataset['exit']).toBe(JSON.stringify({ height: 0, opacity: 0 }));
    expect(motionDiv?.dataset['transition']).toBe(
      JSON.stringify({ duration: 0.2, ease: 'easeInOut' })
    );
  });
});

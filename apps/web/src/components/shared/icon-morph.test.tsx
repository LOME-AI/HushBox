import type * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Code, FileText, Lightbulb, type LucideIcon } from 'lucide-react';
import { IconMorph } from './icon-morph';

const useReducedMotionMock = vi.fn<() => boolean>();

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: (): boolean => useReducedMotionMock(),
  };
});

interface MockMotionProps extends React.HTMLAttributes<HTMLSpanElement> {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
}

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const MotionSpan = ReactModule.forwardRef<HTMLSpanElement, MockMotionProps>(
    ({ children, initial, animate, exit, transition, ...rest }, ref) => (
      <span
        ref={ref}
        data-motion="true"
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-exit={JSON.stringify(exit)}
        data-transition={JSON.stringify(transition)}
        {...rest}
      >
        {children}
      </span>
    )
  );
  MotionSpan.displayName = 'MotionSpanMock';
  const AnimatePresence = ({
    children,
  }: {
    children: React.ReactNode;
    mode?: string;
    initial?: boolean;
  }): React.JSX.Element => <>{children}</>;
  return {
    AnimatePresence,
    motion: { span: MotionSpan },
  };
});

beforeEach(() => {
  useReducedMotionMock.mockReset();
  useReducedMotionMock.mockReturnValue(false);
});

describe('IconMorph', () => {
  it('renders the supplied icon', () => {
    render(<IconMorph icon={Code} iconKey="code" data-testid="icon-morph" />);
    const wrapper = screen.getByTestId('icon-morph');
    expect(wrapper.querySelector('svg')).not.toBeNull();
  });

  it('renders a different icon when the icon prop changes', () => {
    const { rerender, container } = render(
      <IconMorph icon={Code} iconKey="code" data-testid="icon-morph" />
    );
    const initialSvg = container.querySelector('svg');
    expect(initialSvg).not.toBeNull();

    rerender(<IconMorph icon={FileText} iconKey="explain" data-testid="icon-morph" />);
    const afterSvg = container.querySelector('svg');
    expect(afterSvg).not.toBeNull();
  });

  describe('with motion enabled', () => {
    it('wraps the icon in a motion span with cross-fade props', () => {
      render(<IconMorph icon={Code} iconKey="code" data-testid="icon-morph" />);
      const wrapper = screen.getByTestId('icon-morph');
      const motion = wrapper.querySelector<HTMLElement>('[data-motion="true"]');
      expect(motion).not.toBeNull();
      const initial = JSON.parse(motion?.dataset['initial'] ?? '{}') as { opacity?: number };
      const animate = JSON.parse(motion?.dataset['animate'] ?? '{}') as { opacity?: number };
      const exit = JSON.parse(motion?.dataset['exit'] ?? '{}') as { opacity?: number };
      expect(initial.opacity).toBe(0);
      expect(animate.opacity).toBe(1);
      expect(exit.opacity).toBe(0);
    });

    it('defaults the transition duration to 1 second', () => {
      render(<IconMorph icon={Code} iconKey="code" data-testid="icon-morph" />);
      const motion = screen
        .getByTestId('icon-morph')
        .querySelector<HTMLElement>('[data-motion="true"]');
      const transition = JSON.parse(motion?.dataset['transition'] ?? '{}') as {
        duration?: number;
      };
      expect(transition.duration).toBe(1);
    });

    it('allows the duration to be overridden via prop', () => {
      render(<IconMorph icon={Code} iconKey="code" data-testid="icon-morph" duration={0.4} />);
      const motion = screen
        .getByTestId('icon-morph')
        .querySelector<HTMLElement>('[data-motion="true"]');
      const transition = JSON.parse(motion?.dataset['transition'] ?? '{}') as {
        duration?: number;
      };
      expect(transition.duration).toBe(0.4);
    });

    it('reserves a fixed-size icon slot so layout does not jump', () => {
      render(
        <IconMorph icon={Code} iconKey="code" data-testid="icon-morph" sizeClassName="h-5 w-5" />
      );
      const wrapper = screen.getByTestId('icon-morph');
      expect(wrapper).toHaveClass('h-5');
      expect(wrapper).toHaveClass('w-5');
    });

    it('applies size classes to the rendered icon', () => {
      const SpyIcon: LucideIcon = vi.fn((props: React.SVGProps<SVGSVGElement>) => (
        <svg data-testid="spy-icon" {...props} />
      )) as unknown as LucideIcon;
      render(<IconMorph icon={SpyIcon} iconKey="spy" sizeClassName="h-6 w-6" />);
      const svg = screen.getByTestId('spy-icon');
      expect(svg.getAttribute('class') ?? '').toContain('h-6');
      expect(svg.getAttribute('class') ?? '').toContain('w-6');
    });
  });

  describe('with reduced motion enabled', () => {
    beforeEach(() => {
      useReducedMotionMock.mockReturnValue(true);
    });

    it('does not render a motion wrapper', () => {
      render(<IconMorph icon={Lightbulb} iconKey="brainstorm" data-testid="icon-morph" />);
      const wrapper = screen.getByTestId('icon-morph');
      expect(wrapper.querySelector('[data-motion="true"]')).toBeNull();
    });

    it('still renders the icon', () => {
      const { container } = render(
        <IconMorph icon={Lightbulb} iconKey="brainstorm" data-testid="icon-morph" />
      );
      expect(container.querySelector('svg')).not.toBeNull();
    });
  });
});

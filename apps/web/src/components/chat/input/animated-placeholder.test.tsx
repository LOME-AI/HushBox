import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AnimatedPlaceholder } from '@/components/chat/input/animated-placeholder';

const reducedMotionRef = { current: false };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

describe('AnimatedPlaceholder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotionRef.current = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes a stable testid the parent can hide-on-input against', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    expect(screen.getByTestId('animated-placeholder')).toBeInTheDocument();
  });

  it('renders a TypingAnimation child carrying the given text', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    const animation = screen.getByTestId('typing-animation');
    expect(animation).toBeInTheDocument();
    expect(animation).toHaveTextContent('Ask me anything...');
  });

  it('settles to the full text on first mount (skipInitialTyping)', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    expect(screen.getByTestId('typed-text').textContent).toBe('Ask me anything...');
  });

  it('does not render a blinking caret at idle (loop is off)', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('typing-cursor')).not.toBeInTheDocument();
  });

  it('marks the wrapper aria-hidden so it is not double-announced beside the textarea aria-label', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    expect(screen.getByTestId('animated-placeholder')).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not block clicks to the textarea behind it', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    expect(screen.getByTestId('animated-placeholder')).toHaveClass('pointer-events-none');
  });

  it('is positioned absolutely so it overlays the empty textarea', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    expect(screen.getByTestId('animated-placeholder')).toHaveClass('absolute');
  });

  it('uses muted-foreground color to match the native placeholder', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." />);
    expect(screen.getByTestId('animated-placeholder')).toHaveClass('text-muted-foreground');
  });

  it('locks to a single line so mid-animation transitions never wrap', () => {
    render(<AnimatedPlaceholder text="Describe the image you want..." />);
    expect(screen.getByTestId('animated-placeholder')).toHaveClass('whitespace-nowrap');
  });

  it('merges a custom className onto the wrapper', () => {
    render(<AnimatedPlaceholder text="Ask me anything..." className="custom-offset" />);
    expect(screen.getByTestId('animated-placeholder')).toHaveClass('custom-offset');
  });

  it('delete-then-types when text prop changes (modality switch)', () => {
    const before = 'Ask me anything...';
    const after = 'Describe the image you want...';
    const { rerender } = render(<AnimatedPlaceholder text={before} />);
    expect(screen.getByTestId('typed-text').textContent).toBe(before);

    rerender(<AnimatedPlaceholder text={after} />);

    let remainingDeletes = before.length;
    while (remainingDeletes > 0) {
      act(() => {
        vi.advanceTimersByTime(45);
      });
      remainingDeletes -= 1;
    }
    expect(screen.getByTestId('typed-text').textContent).toBe('');

    let remainingTypes = after.length;
    while (remainingTypes > 0) {
      act(() => {
        vi.advanceTimersByTime(75);
      });
      remainingTypes -= 1;
    }
    expect(screen.getByTestId('typed-text').textContent).toBe(after);
  });
});

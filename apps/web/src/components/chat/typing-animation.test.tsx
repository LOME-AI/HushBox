import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TypingAnimation } from './typing-animation';

describe('TypingAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the component', () => {
    render(<TypingAnimation text="Hello" />);
    expect(screen.getByTestId('typing-animation')).toBeInTheDocument();
  });

  it('renders full text invisibly as layout spacer', () => {
    render(<TypingAnimation text="Hello World" />);
    const container = screen.getByTestId('typing-animation');
    // Invisible spacer contains full text to reserve layout space
    const spacer = container.querySelector('[aria-hidden="true"]');
    expect(spacer).toBeInTheDocument();
    expect(spacer).toHaveTextContent('Hello World');
    expect(spacer).toHaveClass('invisible');
  });

  it('displays cursor', () => {
    render(<TypingAnimation text="Hello" />);
    expect(screen.getByTestId('typing-cursor')).toBeInTheDocument();
  });

  it('progressively types out the text', () => {
    render(<TypingAnimation text="Hi" typingSpeed={75} />);

    // Initially empty
    expect(screen.getByTestId('typed-text').textContent).toBe('');

    // After first character
    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.getByTestId('typed-text').textContent).toBe('H');

    // After second character
    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.getByTestId('typed-text').textContent).toBe('Hi');
  });

  it('hides cursor when complete and loop is false', () => {
    render(<TypingAnimation text="Hi" typingSpeed={75} loop={false} />);

    // Type 'H'
    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.getByTestId('typing-cursor')).toBeInTheDocument();

    // Type 'i' — cursor disappears immediately, no intermediate frame
    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.queryByTestId('typing-cursor')).not.toBeInTheDocument();
  });

  it('keeps cursor visible when loop is true', () => {
    render(<TypingAnimation text="Hi" typingSpeed={75} loop={true} />);

    // Advance past typing
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Cursor should still be visible
    expect(screen.getByTestId('typing-cursor')).toBeInTheDocument();
  });

  it('respects custom className', () => {
    render(<TypingAnimation text="Hi" className="custom-class" />);
    expect(screen.getByTestId('typing-animation')).toHaveClass('custom-class');
  });

  it('calls onComplete when typing finishes', () => {
    const onComplete = vi.fn();
    render(<TypingAnimation text="Hi" typingSpeed={75} loop={false} onComplete={onComplete} />);

    // Type out "Hi"
    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

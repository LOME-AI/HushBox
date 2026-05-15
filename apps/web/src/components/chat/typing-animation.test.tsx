import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TypingAnimation } from './typing-animation';

const reducedMotionRef = { current: false };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

describe('TypingAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotionRef.current = false;
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

    expect(screen.getByTestId('typed-text').textContent).toBe('');

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.getByTestId('typed-text').textContent).toBe('H');

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.getByTestId('typed-text').textContent).toBe('Hi');
  });

  it('hides cursor when complete and loop is false', () => {
    render(<TypingAnimation text="Hi" typingSpeed={75} loop={false} />);

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.getByTestId('typing-cursor')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(screen.queryByTestId('typing-cursor')).not.toBeInTheDocument();
  });

  it('keeps cursor visible when loop is true', () => {
    render(<TypingAnimation text="Hi" typingSpeed={75} loop={true} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.getByTestId('typing-cursor')).toBeInTheDocument();
  });

  it('respects custom className', () => {
    render(<TypingAnimation text="Hi" className="custom-class" />);
    expect(screen.getByTestId('typing-animation')).toHaveClass('custom-class');
  });

  it('calls onComplete when typing finishes', () => {
    const onComplete = vi.fn();
    render(<TypingAnimation text="Hi" typingSpeed={75} loop={false} onComplete={onComplete} />);

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(onComplete).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(75);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  describe('delete-then-retype state machine', () => {
    it('deletes existing text at deletionSpeed then types new text at typingSpeed', () => {
      const { rerender } = render(
        <TypingAnimation text="hello" typingSpeed={75} deletionSpeed={45} />
      );

      for (let index = 0; index < 5; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('hello');

      rerender(<TypingAnimation text="world" typingSpeed={75} deletionSpeed={45} />);

      act(() => {
        vi.advanceTimersByTime(45);
      });
      expect(screen.getByTestId('typed-text').textContent).toBe('hell');

      for (let index = 0; index < 4; index++) {
        act(() => {
          vi.advanceTimersByTime(45);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('');

      act(() => {
        vi.advanceTimersByTime(75);
      });
      expect(screen.getByTestId('typed-text').textContent).toBe('w');

      for (let index = 0; index < 4; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('world');
    });

    it('only deletes when new text is empty string', () => {
      const { rerender } = render(
        <TypingAnimation text="hello" typingSpeed={75} deletionSpeed={45} />
      );

      for (let index = 0; index < 5; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('hello');

      rerender(<TypingAnimation text="" typingSpeed={75} deletionSpeed={45} />);

      for (let index = 0; index < 5; index++) {
        act(() => {
          vi.advanceTimersByTime(45);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('');

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('typed-text').textContent).toBe('');
    });

    it('only types when starting from empty (no deletion)', () => {
      const { rerender } = render(<TypingAnimation text="" typingSpeed={75} deletionSpeed={45} />);

      expect(screen.getByTestId('typed-text').textContent).toBe('');

      rerender(<TypingAnimation text="world" typingSpeed={75} deletionSpeed={45} />);

      act(() => {
        vi.advanceTimersByTime(75);
      });
      expect(screen.getByTestId('typed-text').textContent).toBe('w');

      for (let index = 0; index < 4; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('world');
    });

    it('handles rapid double change: most recent text wins, no orphan timers', () => {
      const { rerender } = render(
        <TypingAnimation text="hello" typingSpeed={75} deletionSpeed={45} />
      );

      for (let index = 0; index < 5; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('hello');

      rerender(<TypingAnimation text="world" typingSpeed={75} deletionSpeed={45} />);
      act(() => {
        vi.advanceTimersByTime(45);
      });
      expect(screen.getByTestId('typed-text').textContent).toBe('hell');

      rerender(<TypingAnimation text="foo" typingSpeed={75} deletionSpeed={45} />);

      for (let index = 0; index < 4; index++) {
        act(() => {
          vi.advanceTimersByTime(45);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('');

      for (let index = 0; index < 3; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(screen.getByTestId('typed-text').textContent).toBe('foo');

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('typed-text').textContent).toBe('foo');
    });

    it('snaps instantly to new text when useReducedMotion is true', () => {
      reducedMotionRef.current = true;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { rerender } = render(
        <TypingAnimation text="hello" typingSpeed={75} deletionSpeed={45} />
      );

      expect(screen.getByTestId('typed-text').textContent).toBe('hello');
      const callsBeforeChange = setTimeoutSpy.mock.calls.length;

      rerender(<TypingAnimation text="world" typingSpeed={75} deletionSpeed={45} />);

      expect(screen.getByTestId('typed-text').textContent).toBe('world');
      expect(setTimeoutSpy.mock.calls.length).toBe(callsBeforeChange);

      setTimeoutSpy.mockRestore();
    });

    it('fires onDeleteComplete when deletion finishes', () => {
      const onDeleteComplete = vi.fn();
      const { rerender } = render(
        <TypingAnimation
          text="hello"
          typingSpeed={75}
          deletionSpeed={45}
          onDeleteComplete={onDeleteComplete}
        />
      );

      for (let index = 0; index < 5; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(onDeleteComplete).not.toHaveBeenCalled();

      rerender(
        <TypingAnimation
          text="world"
          typingSpeed={75}
          deletionSpeed={45}
          onDeleteComplete={onDeleteComplete}
        />
      );

      for (let index = 0; index < 4; index++) {
        act(() => {
          vi.advanceTimersByTime(45);
        });
      }
      expect(onDeleteComplete).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(45);
      });
      expect(onDeleteComplete).toHaveBeenCalledTimes(1);
    });

    it('fires onStateChange when transitioning between states', () => {
      const onStateChange = vi.fn();
      const { rerender } = render(
        <TypingAnimation
          text="hi"
          typingSpeed={75}
          deletionSpeed={45}
          loop={false}
          onStateChange={onStateChange}
        />
      );

      expect(onStateChange).toHaveBeenCalledWith('typing');

      for (let index = 0; index < 2; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(onStateChange).toHaveBeenCalledWith('idle');

      onStateChange.mockClear();

      rerender(
        <TypingAnimation
          text="bye"
          typingSpeed={75}
          deletionSpeed={45}
          loop={false}
          onStateChange={onStateChange}
        />
      );

      expect(onStateChange).toHaveBeenCalledWith('deleting');

      for (let index = 0; index < 2; index++) {
        act(() => {
          vi.advanceTimersByTime(45);
        });
      }
      expect(onStateChange).toHaveBeenCalledWith('typing');

      for (let index = 0; index < 3; index++) {
        act(() => {
          vi.advanceTimersByTime(75);
        });
      }
      expect(onStateChange).toHaveBeenCalledWith('idle');
    });
  });
});

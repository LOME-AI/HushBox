import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StreamingMessage, calculateDelay } from './streaming-message';

describe('StreamingMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('displays content progressively with typing effect', () => {
    render(<StreamingMessage content="Hello" isStreaming />);

    // Initially starts empty
    expect(screen.getByTestId('streaming-message')).toBeInTheDocument();

    // Advance timers to complete typing
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('shows all content immediately when streaming stops', () => {
    const { rerender } = render(<StreamingMessage content="Hello, world!" isStreaming />);

    // Streaming stops - should show all content immediately
    rerender(<StreamingMessage content="Hello, world!" isStreaming={false} />);

    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('shows blinking cursor indicator when streaming', () => {
    render(<StreamingMessage content="Test" isStreaming />);

    const indicator = screen.getByTestId('streaming-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveClass('animate-blink');
  });

  it('hides cursor indicator when not streaming', () => {
    render(<StreamingMessage content="Complete response" isStreaming={false} />);

    expect(screen.queryByTestId('streaming-indicator')).not.toBeInTheDocument();
  });

  it('renders with no bubble styling (transparent background)', () => {
    render(<StreamingMessage content="Test" isStreaming={false} />);

    const container = screen.getByTestId('streaming-message');
    expect(container).toHaveClass('text-foreground');
    // Should not have any bg-* class for transparent appearance
    expect(container.className).not.toMatch(/bg-/);
  });

  it('applies symmetric margins for AI messages', () => {
    render(<StreamingMessage content="Test" isStreaming={false} />);

    const container = screen.getByTestId('streaming-message-container');
    expect(container).toHaveClass('px-[2%]');
  });

  it('applies custom className', () => {
    render(<StreamingMessage content="Test" className="custom-class" isStreaming={false} />);

    expect(screen.getByTestId('streaming-message-container')).toHaveClass('custom-class');
  });

  it('renders empty content gracefully with cursor', () => {
    render(<StreamingMessage content="" isStreaming />);

    expect(screen.getByTestId('streaming-message')).toBeInTheDocument();
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
  });

  it('renders multi-line content', () => {
    render(<StreamingMessage content={`Line 1\nLine 2`} isStreaming={false} />);

    // Content is rendered via MarkdownRenderer which handles newlines
    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
    expect(screen.getByText(/Line 1/)).toBeInTheDocument();
  });

  it('cursor indicator has correct aria-label for accessibility', () => {
    render(<StreamingMessage content="Test" isStreaming />);

    const indicator = screen.getByTestId('streaming-indicator');
    expect(indicator).toHaveAttribute('aria-label', 'Generating response');
  });

  describe('buffer-aware typing', () => {
    it('waits when buffer is empty but still streaming', () => {
      render(<StreamingMessage content="" isStreaming />);

      // Even with no content, should keep cursor visible while streaming
      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();

      // Advance timers - should poll waiting for content
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Still shows cursor, waiting for content
      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();
    });

    it('types faster when buffer is larger', () => {
      // With large buffer (20 chars), typing should be fast
      render(<StreamingMessage content="12345678901234567890" isStreaming />);

      // After just 300ms with 20-char buffer, should have typed most chars
      // At buffer=20, base delay ~10ms, so 20 chars in ~200-300ms
      act(() => {
        vi.advanceTimersByTime(300);
      });

      const message = screen.getByTestId('streaming-message');
      // Should have typed at least 10 characters
      expect(message.textContent.length).toBeGreaterThanOrEqual(10);
    });

    it('continues polling when streaming with empty buffer', () => {
      const { rerender } = render(<StreamingMessage content="A" isStreaming />);

      // Type the single char
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByText('A')).toBeInTheDocument();

      // Still streaming but buffer empty - should keep cursor and keep polling
      expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument();

      // New content arrives
      rerender(<StreamingMessage content="AB" isStreaming />);

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByText('AB')).toBeInTheDocument();
    });
  });
});

describe('calculateDelay', () => {
  it('returns poll delay when buffer is zero', () => {
    const delay = calculateDelay('a', 0);
    // Should return 50ms poll delay when no buffer
    expect(delay).toBe(50);
  });

  it('returns smaller delay for larger buffer (linear scaling)', () => {
    // Seed Math.random for deterministic test
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const smallBufferDelay = calculateDelay('a', 2);
    const largeBufferDelay = calculateDelay('a', 10);

    // Larger buffer should result in smaller delay
    expect(largeBufferDelay).toBeLessThan(smallBufferDelay);

    vi.restoreAllMocks();
  });

  it('adds delay for sentence-ending punctuation', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const normalDelay = calculateDelay('a', 5);
    const periodDelay = calculateDelay('.', 5);
    const questionDelay = calculateDelay('?', 5);
    const exclamationDelay = calculateDelay('!', 5);

    // Punctuation should add 80-150ms (at 0.5 random = 115ms)
    expect(periodDelay).toBeGreaterThan(normalDelay + 50);
    expect(questionDelay).toBeGreaterThan(normalDelay + 50);
    expect(exclamationDelay).toBeGreaterThan(normalDelay + 50);

    vi.restoreAllMocks();
  });

  it('adds delay for clause punctuation', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const normalDelay = calculateDelay('a', 5);
    const commaDelay = calculateDelay(',', 5);
    const semicolonDelay = calculateDelay(';', 5);
    const colonDelay = calculateDelay(':', 5);

    // Clause punctuation should add 20-50ms (at 0.5 random = 35ms)
    expect(commaDelay).toBeGreaterThan(normalDelay + 10);
    expect(semicolonDelay).toBeGreaterThan(normalDelay + 10);
    expect(colonDelay).toBeGreaterThan(normalDelay + 10);

    vi.restoreAllMocks();
  });

  it('adds delay for word boundaries (spaces)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const normalDelay = calculateDelay('a', 5);
    const spaceDelay = calculateDelay(' ', 5);

    // Space should add 30-80ms (at 0.5 random = 55ms)
    expect(spaceDelay).toBeGreaterThan(normalDelay + 20);

    vi.restoreAllMocks();
  });

  it('has minimum delay of 5ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // Even with very large buffer, delay should not go below 5ms
    const delay = calculateDelay('a', 1000);
    expect(delay).toBeGreaterThanOrEqual(5);

    vi.restoreAllMocks();
  });

  it('applies random variation to delay', () => {
    // Test that different random values produce different delays
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const lowRandomDelay = calculateDelay('a', 5);

    vi.spyOn(Math, 'random').mockReturnValue(1);
    const highRandomDelay = calculateDelay('a', 5);

    // Delays should differ due to random variation
    expect(lowRandomDelay).not.toBe(highRandomDelay);

    vi.restoreAllMocks();
  });
});

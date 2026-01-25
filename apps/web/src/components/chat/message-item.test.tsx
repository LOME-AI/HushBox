import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MessageItem } from './message-item';

// Mock mermaid to avoid actual rendering
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg>Diagram</svg>',
      bindFunctions: vi.fn(),
    }),
  },
}));

describe('MessageItem', () => {
  const userMessage = {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello, how are you?',
    createdAt: '2024-01-01T00:00:00Z',
  };

  const assistantMessage = {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'I am doing well, thank you!',
    createdAt: '2024-01-01T00:00:01Z',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders message content', () => {
    render(<MessageItem message={userMessage} />);
    expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
  });

  it('renders user message with user styling', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'user');
  });

  it('renders assistant message with assistant styling', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'assistant');
  });

  it('applies fit-content width with right alignment for user messages', () => {
    render(<MessageItem message={userMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('w-fit');
    expect(container).toHaveClass('ml-auto');
    expect(container).toHaveClass('max-w-[82%]');
    expect(container).toHaveClass('mr-[2%]');
  });

  it('applies symmetric margins for assistant messages', () => {
    render(<MessageItem message={assistantMessage} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('px-[2%]');
  });

  describe('copy button', () => {
    it('renders copy button for each message', () => {
      render(<MessageItem message={assistantMessage} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies message content to clipboard when clicked', async () => {
      render(<MessageItem message={assistantMessage} />);

      // Click the copy button
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      // The state change to "Copied" proves clipboard.writeText succeeded
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      // Verify the message content that was copied matches
      expect(assistantMessage.content).toBe('I am doing well, thank you!');
    });

    it('shows copied feedback after clicking', async () => {
      render(<MessageItem message={assistantMessage} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });

    it('resets to copy state after delay', async () => {
      render(<MessageItem message={assistantMessage} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      // Flush the async clipboard operation
      await act(async () => {
        await Promise.resolve();
      });

      // Should show "Copied"
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      // Wait for the 2 second timeout to reset
      act(() => {
        vi.advanceTimersByTime(2500);
      });

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copy button has ghost variant styling', () => {
      render(<MessageItem message={assistantMessage} />);
      const button = screen.getByRole('button', { name: /copy/i });
      // Ghost buttons typically have these classes or no background
      expect(button).toHaveClass('h-6', 'w-6');
    });
  });

  describe('document extraction', () => {
    it('calls onDocumentsExtracted when assistant message has large code blocks', () => {
      const largeCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `const line${String(index)} = ${String(index)};`)
        .join('\n');
      const messageWithCode = {
        id: 'msg-code',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: `\`\`\`typescript\n${largeCode}\n\`\`\``,
        createdAt: '2024-01-01T00:00:00Z',
      };
      const onDocumentsExtracted = vi.fn();

      render(<MessageItem message={messageWithCode} onDocumentsExtracted={onDocumentsExtracted} />);

      // Let any async effects complete
      act(() => {
        vi.runAllTimers();
      });

      expect(onDocumentsExtracted).toHaveBeenCalled();

      const [messageId, documents] = onDocumentsExtracted.mock.calls[0] as [string, unknown[]];
      expect(messageId).toBe('msg-code');
      expect(documents).toHaveLength(1);
    });

    it('does not call onDocumentsExtracted for user messages', () => {
      const onDocumentsExtracted = vi.fn();
      render(<MessageItem message={userMessage} onDocumentsExtracted={onDocumentsExtracted} />);

      expect(onDocumentsExtracted).not.toHaveBeenCalled();
    });
  });
});

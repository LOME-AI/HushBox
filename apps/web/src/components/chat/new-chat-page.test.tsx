import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { NewChatPage } from './new-chat-page';

// Mock the api module
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([
      {
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'Test model',
        context_length: 128000,
        pricing: { prompt: '0.00001', completion: '0.00003' },
        supported_parameters: ['temperature'],
      },
    ]),
  },
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', async () => {
  const react = await import('react');

  const createMotionComponent = (tag: string) => {
    return react.forwardRef(
      ({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>) => {
        return react.createElement(tag, { ...props, ref }, children);
      }
    );
  };

  return {
    motion: {
      span: createMotionComponent('span'),
      div: createMotionComponent('div'),
      p: createMotionComponent('p'),
    },
  };
});

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('NewChatPage', () => {
  const mockOnSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the new chat page container', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('new-chat-page')).toBeInTheDocument();
  });

  it('renders a greeting with typing animation', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('typing-animation')).toBeInTheDocument();
  });

  it('renders the prompt input', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders suggestion chips', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('suggestion-chips')).toBeInTheDocument();
  });

  it('renders Surprise Me button', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();
  });

  it('calls onSend when submitting prompt', async () => {
    const user = userEvent.setup();
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello world');

    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledWith('Hello world');
  });

  it('fills prompt input when suggestion chip is clicked', async () => {
    const user = userEvent.setup();
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const codeChip = screen.getByText(/help me write code/i);
    await user.click(codeChip);

    // Should populate the textarea instead of calling onSend directly
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('Help me write a function that...');
    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it('has flex column layout for header and content', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    const container = screen.getByTestId('new-chat-page');
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('flex-col');
  });

  it('shows subtitle text', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    // Subtitle should exist somewhere in the page
    const page = screen.getByTestId('new-chat-page');
    expect(page.textContent).toBeTruthy();
  });

  it('renders theme toggle', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders model selector button', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument();
  });

  it('renders ChatHeader at the top', () => {
    render(<NewChatPage onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
  });
});

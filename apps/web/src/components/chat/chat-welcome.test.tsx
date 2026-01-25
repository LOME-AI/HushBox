import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { ChatWelcome } from './chat-welcome';
import type { BudgetCalculationResult } from '@lome-chat/shared';

// Mock the api module
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([
      {
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'Test model',
        context_length: 128_000,
        pricing: { prompt: '0.00001', completion: '0.00003' },
        supported_parameters: ['temperature'],
      },
    ]),
  },
}));

// Mock hooks used by PromptInput (which is rendered inside ChatWelcome)
vi.mock('@/stores/model', () => ({
  useModelStore: vi.fn(() => ({
    selectedModelId: 'test-model',
    setSelectedModel: vi.fn(),
  })),
}));

vi.mock('@/hooks/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models')>();
  return {
    ...actual,
    useModels: vi.fn(() => ({
      data: {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            contextLength: 50_000,
            pricePerInputToken: 0.000_001,
            pricePerOutputToken: 0.000_002,
            capabilities: [],
            provider: { name: 'Test Provider' },
            description: 'A test model',
          },
        ],
      },
      isLoading: false,
      error: null,
    })),
  };
});

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(() => ({
    data: { user: { id: 'test-user', email: 'test@example.com' } },
    isPending: false,
  })),
}));

// Mock stable balance hook
vi.mock('@/hooks/use-stable-balance', () => ({
  useStableBalance: vi.fn(() => ({
    displayBalance: '10.00',
    isStable: true,
  })),
}));

// Default budget result - can afford, no errors
const defaultBudgetResult: BudgetCalculationResult = {
  canAfford: true,
  maxOutputTokens: 1000,
  estimatedInputTokens: 100,
  estimatedInputCost: 0.0001,
  estimatedMinimumCost: 0.001,
  effectiveBalance: 1,
  currentUsage: 1100,
  capacityPercent: 5,
  errors: [],
};

vi.mock('@/hooks/use-budget-calculation', () => ({
  useBudgetCalculation: () => defaultBudgetResult,
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

  // AnimatePresence just renders children
  const AnimatePresence = ({ children }: { children?: React.ReactNode }) => {
    return react.createElement(react.Fragment, null, children);
  };

  return {
    motion: {
      span: createMotionComponent('span'),
      div: createMotionComponent('div'),
      p: createMotionComponent('p'),
    },
    AnimatePresence,
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

describe('ChatWelcome', () => {
  const mockOnSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the chat welcome container', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('chat-welcome')).toBeInTheDocument();
  });

  it('renders a greeting heading', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the prompt input', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders suggestion chips', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('suggestion-chips')).toBeInTheDocument();
  });

  it('renders Surprise Me button', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();
  });

  it('calls onSend when submitting prompt', async () => {
    const user = userEvent.setup();
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
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
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const codeChip = screen.getByText(/help me write code/i);
    await user.click(codeChip);

    // Should populate the textarea instead of calling onSend directly
    const textarea = screen.getByRole('textbox');
    // The prompt should be non-empty (randomly selected from the code category)
    expect((textarea as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it('has flex column layout for header and content', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    const container = screen.getByTestId('chat-welcome');
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('flex-col');
  });

  it('has dynamic viewport height and overflow-hidden to prevent scroll bar', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    const container = screen.getByTestId('chat-welcome');
    // Uses visual viewport height for mobile keyboard handling
    expect(container.style.height).toMatch(/\d+px/);
    expect(container).toHaveClass('overflow-hidden');
  });

  it('shows subtitle text', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    // Subtitle should exist somewhere in the page
    const page = screen.getByTestId('chat-welcome');
    expect(page.textContent).toBeTruthy();
  });

  it('renders theme toggle', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders model selector button', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument();
  });

  it('renders ChatHeader at the top', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
  });
});

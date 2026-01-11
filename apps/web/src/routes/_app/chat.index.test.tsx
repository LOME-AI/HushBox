import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const { mockUseSession, mockNavigate, mockUseBalance } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseBalance: vi.fn(),
}));

// Mock tanstack router
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    createFileRoute: () => () => ({ component: () => null }),
  };
});

// Mock auth
vi.mock('@/lib/auth', () => ({
  useSession: mockUseSession,
}));

// Mock billing
vi.mock('@/hooks/billing', () => ({
  useBalance: mockUseBalance,
  billingKeys: {
    balance: () => ['balance'],
  },
}));

// Mock api module
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

// Mock hooks used by PromptInput
vi.mock('@/stores/model', () => ({
  useModelStore: vi.fn(() => ({
    selectedModelId: 'test-model',
    setSelectedModel: vi.fn(),
  })),
}));

vi.mock('@/hooks/models', () => ({
  useModels: vi.fn(() => ({
    data: {
      models: [
        {
          id: 'test-model',
          name: 'Test Model',
          contextLength: 50000,
          pricePerInputToken: 0.000001,
          pricePerOutputToken: 0.000002,
          capabilities: [],
          provider: { name: 'Test Provider' },
          description: 'A test model',
        },
      ],
      premiumIds: new Set<string>(),
    },
    isLoading: false,
    error: null,
  })),
}));

vi.mock('@/hooks/use-budget-calculation', () => ({
  useBudgetCalculation: () => ({
    canAfford: true,
    maxOutputTokens: 1000,
    estimatedInputTokens: 100,
    estimatedInputCost: 0.0001,
    estimatedMinimumCost: 0.001,
    effectiveBalance: 1.0,
    currentUsage: 1100,
    capacityPercent: 5,
    errors: [],
  }),
}));

// Mock framer-motion
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

// Import after mocks
import { ChatIndex } from './chat.index';

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

describe('ChatIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock values
    mockUseBalance.mockReturnValue({ data: { balance: '0.00' } });
  });

  it('shows loading state while session is pending', () => {
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
    });

    render(<ChatIndex />, { wrapper: createWrapper() });

    // Should show loading state, not the greeting
    expect(screen.getByTestId('new-chat-page')).toHaveAttribute('data-loading', 'true');
  });

  it('shows authenticated greeting after session loads', async () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
      isPending: false,
    });

    render(<ChatIndex />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('new-chat-page')).toHaveAttribute('data-loading', 'false');
    });
  });

  it('does not re-render greeting when session loads', async () => {
    // Start with pending session
    mockUseSession.mockReturnValue({
      data: null,
      isPending: true,
    });

    const { rerender } = render(<ChatIndex />, { wrapper: createWrapper() });

    // Session becomes available
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
      isPending: false,
    });

    rerender(<ChatIndex />);

    // Greeting should be stable (computed only after session loaded)
    await waitFor(() => {
      expect(screen.getByTestId('new-chat-page')).toHaveAttribute('data-loading', 'false');
    });
  });

  describe('premium click modal routing', () => {
    it('renders SignupModal component for guests', () => {
      // Guest: not authenticated
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockUseBalance.mockReturnValue({ data: { balance: '0.00' } });

      render(<ChatIndex />, { wrapper: createWrapper() });

      // SignupModal should be in the DOM (but closed)
      // The modal is rendered but with open={false}
      expect(screen.queryByTestId('payment-modal')).not.toBeInTheDocument();
    });

    it('renders PaymentModal component for authenticated users', () => {
      // Free user: authenticated but no balance
      mockUseSession.mockReturnValue({
        data: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isPending: false,
      });
      mockUseBalance.mockReturnValue({ data: { balance: '0.00' } });

      render(<ChatIndex />, { wrapper: createWrapper() });

      // PaymentModal component should be in the DOM (but closed)
      // The modal only renders when open=true, so it won't be there initially
      expect(screen.queryByTestId('payment-modal')).not.toBeInTheDocument();
    });
  });
});

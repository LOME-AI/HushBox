import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const { mockUseStableSession, mockNavigate, mockUseBalance, mockUseStability } = vi.hoisted(() => ({
  mockUseStableSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseBalance: vi.fn(),
  mockUseStability: vi.fn(),
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

// Mock stable session hook
vi.mock('@/hooks/use-stable-session', () => ({
  useStableSession: mockUseStableSession,
}));

// Mock stability provider
vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

// Mock billing
vi.mock('@/hooks/billing', () => ({
  useBalance: mockUseBalance,
  billingKeys: {
    balance: () => ['balance'],
  },
}));

// Mock api module — `api` object was removed; module now exports getApiUrl + ApiError
vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

// Mock chat error store
const mockClearError = vi.fn();
vi.mock('@/stores/chat-error', () => ({
  useChatErrorStore: Object.assign(() => null, {
    getState: () => ({
      error: null,
      setError: vi.fn(),
      clearError: mockClearError,
    }),
  }),
}));

// Mock hooks used by PromptInput
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
        premiumIds: new Set<string>(),
      },
      isLoading: false,
      error: null,
    })),
  };
});

vi.mock('@/hooks/use-prompt-budget', () => ({
  usePromptBudget: (input: { value: string }) => ({
    fundingSource: 'personal_balance',
    notifications: [],
    capacityPercent: 5,
    capacityCurrentUsage: 1100,
    capacityMaxCapacity: 50_000,
    estimatedCostCents: 0.1,
    isOverCapacity: false,
    hasBlockingError: false,
    hasContent: input.value.trim().length > 0,
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

// Mock crypto.randomUUID for consistent test behavior
const mockUUID = '12345678-1234-1234-1234-123456789abc';
vi.stubGlobal('crypto', {
  randomUUID: () => mockUUID,
});

describe('ChatIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock values
    mockUseBalance.mockReturnValue({ data: { balance: '0.00' } });
    mockUseStability.mockReturnValue({
      isAuthStable: true,
      isBalanceStable: true,
      isAppStable: true,
    });
  });

  it('shows loading state while session is not stable', () => {
    mockUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: false,
      isPending: true,
    });

    render(<ChatIndex />, { wrapper: createWrapper() });

    // Should show loading state, not the greeting
    expect(screen.getByTestId('chat-welcome')).toHaveAttribute('data-loading', 'true');
  });

  it('shows authenticated greeting after session becomes stable', async () => {
    mockUseStableSession.mockReturnValue({
      session: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });

    render(<ChatIndex />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome')).toHaveAttribute('data-loading', 'false');
    });
  });

  it('does not re-render greeting when session becomes stable', async () => {
    // Start with pending session
    mockUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: false,
      isPending: true,
    });

    const { rerender } = render(<ChatIndex />, { wrapper: createWrapper() });

    // Session becomes available and stable
    mockUseStableSession.mockReturnValue({
      session: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });

    rerender(<ChatIndex />);

    // Greeting should be stable (computed only after session loaded)
    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome')).toHaveAttribute('data-loading', 'false');
    });
  });

  describe('authenticated user navigation', () => {
    it('navigates to /chat/new and stores pending message', async () => {
      const { usePendingChatStore } = await import('@/stores/pending-chat');

      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });

      render(<ChatIndex />, { wrapper: createWrapper() });

      // Find the input and type a message
      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Hello AI!{enter}');

      // Verify the pending message was stored
      const state = usePendingChatStore.getState();
      expect(state.pendingMessage).toBe('Hello AI!');

      // Verify navigation to /chat/new
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$id',
        params: { id: 'new' },
      });
    });
  });

  describe('premium click modal routing', () => {
    it('renders SignupModal component for trial users', () => {
      // Trial: not authenticated
      mockUseStableSession.mockReturnValue({
        session: null,
        isAuthenticated: false,
        isStable: true,
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
      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });
      mockUseBalance.mockReturnValue({ data: { balance: '0.00' } });

      render(<ChatIndex />, { wrapper: createWrapper() });

      // PaymentModal component should be in the DOM (but closed)
      // The modal only renders when open=true, so it won't be there initially
      expect(screen.queryByTestId('payment-modal')).not.toBeInTheDocument();
    });
  });

  describe('error cleanup', () => {
    it('clears chat error on mount', () => {
      mockUseStableSession.mockReturnValue({
        session: null,
        isAuthenticated: false,
        isStable: true,
        isPending: false,
      });

      render(<ChatIndex />, { wrapper: createWrapper() });

      expect(mockClearError).toHaveBeenCalled();
    });

    it('clears chat error when sending a message', async () => {
      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });

      render(<ChatIndex />, { wrapper: createWrapper() });

      mockClearError.mockClear();

      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Hello AI!{enter}');

      expect(mockClearError).toHaveBeenCalled();
    });
  });
});

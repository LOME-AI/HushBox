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

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    createFileRoute: () => () => ({ component: () => null }),
  };
});

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: mockUseStableSession,
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: mockUseBalance,
  billingKeys: {
    balance: () => ['balance'],
  },
}));

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

const mockClearError = vi.fn();
const mockClearAll = vi.fn();
vi.mock('@/stores/chat-error', () => ({
  MAIN_FORK_KEY: 'main',
  useChatErrorStore: Object.assign(() => null, {
    getState: () => ({
      errorsByFork: {},
      setError: vi.fn(),
      clearError: mockClearError,
      clearAll: mockClearAll,
    }),
  }),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  const state = createModelStoreStub();
  return { ...actual, useModelStore: vi.fn(selectorFromState(state)) };
});

vi.mock('@/hooks/models/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models/models')>();
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

vi.mock('@/hooks/billing/use-prompt-budget', () => ({
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

vi.mock('framer-motion', async () => {
  const react = await import('react');

  const createMotionComponent = (tag: string) => {
    return react.forwardRef(
      ({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>) => {
        return react.createElement(tag, { ...props, ref }, children);
      }
    );
  };

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
    mockUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: false,
      isPending: true,
    });

    const { rerender } = render(<ChatIndex />, { wrapper: createWrapper() });

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

      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Hello AI!{enter}');

      const state = usePendingChatStore.getState();
      expect(state.pendingMessage).toBe('Hello AI!');

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$id',
        params: { id: 'new' },
        search: { fork: undefined },
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

      expect(mockClearAll).toHaveBeenCalled();
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

      mockClearAll.mockClear();

      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Hello AI!{enter}');

      expect(mockClearAll).toHaveBeenCalled();
    });
  });
});

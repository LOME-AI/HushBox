import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
const mockConversationId = vi.fn().mockReturnValue('conv-123');

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    useParams: () => ({ conversationId: mockConversationId() }),
    useSearch: () => ({}),
  }),
  useNavigate: () => mockNavigate,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate-redirect">{to}</div>,
}));

const mockUseConversation = vi.fn();
const mockUseMessages = vi.fn();
const mockUseSendMessage = vi.fn();
const mockUseChatStream = vi.fn();
const mockUseCreateConversation = vi.fn();

vi.mock('@/hooks/chat', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  useConversation: () => mockUseConversation(),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  useMessages: () => mockUseMessages(),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  useSendMessage: () => mockUseSendMessage(),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  useChatStream: () => mockUseChatStream(),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  useCreateConversation: () => mockUseCreateConversation(),
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
}));

vi.mock('@/stores/pending-chat', () => ({
  usePendingChatStore: () => null, // No pending message in these tests
}));

vi.mock('@lome-chat/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lome-chat/shared')>();
  return {
    ...actual,
    generateChatTitle: (content: string) => `Title: ${content.slice(0, 20)}`,
  };
});

vi.mock('@/hooks/billing', () => ({
  billingKeys: {
    balance: () => ['balance'],
  },
}));

vi.mock('@/lib/auth', () => ({
  useSession: () => ({ data: { user: { id: 'test-user-id' } } }),
}));

vi.mock('@/hooks/use-tier-info', () => ({
  useTierInfo: () => ({ canAccessPremium: true }),
}));

vi.mock('@/stores/model', () => ({
  useModelStore: () => ({
    selectedModelId: 'test-model',
    selectedModelName: 'Test Model',
    setSelectedModel: vi.fn(),
  }),
}));

vi.mock('@/hooks/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models')>();
  return {
    ...actual,
    useModels: () => ({
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
    }),
  };
});

vi.mock('@/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => 800,
}));

vi.mock('@/hooks/use-keyboard-offset', () => ({
  useKeyboardOffset: () => ({ bottom: 0, isKeyboardVisible: false }),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/hooks/use-auto-scroll', () => ({
  useAutoScroll: () => ({
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    isAutoScrollEnabledRef: { current: true },
  }),
}));

vi.mock('@/hooks/use-interaction-tracker', () => ({
  useInteractionTracker: () => ({
    hasInteractedRef: { current: false },
    resetOnSubmit: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-premium-model-click', () => ({
  usePremiumModelClick: () => vi.fn(),
}));

vi.mock('@/stores/ui-modals', () => ({
  useUIModalsStore: () => ({
    signupModalOpen: false,
    paymentModalOpen: false,
    premiumModelName: null,
    setSignupModalOpen: vi.fn(),
    setPaymentModalOpen: vi.fn(),
  }),
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

// Must import after mocks
import { ChatConversation } from './chat.$conversationId';

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

describe('ChatConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversationId.mockReturnValue('conv-123');
    mockUseSendMessage.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseChatStream.mockReturnValue({ isStreaming: false, startStream: vi.fn() });
    mockUseCreateConversation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  });

  describe('loading state with cached data', () => {
    it('shows title in loading state when conversation data is cached', () => {
      mockUseConversation.mockReturnValue({
        data: { id: 'conv-123', title: 'Cached Chat Title' },
        isLoading: true,
      });
      mockUseMessages.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      render(<ChatConversation />, { wrapper: createWrapper() });

      const titleElement = screen.getByTestId('chat-title');
      expect(titleElement).toHaveTextContent('Cached Chat Title');
    });

    it('shows loading message while data loads', () => {
      mockUseConversation.mockReturnValue({
        data: undefined,
        isLoading: true,
      });
      mockUseMessages.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      render(<ChatConversation />, { wrapper: createWrapper() });

      expect(screen.getByText('Loading conversation...')).toBeInTheDocument();
    });
  });

  describe('loaded state', () => {
    it('shows title when conversation loads', () => {
      mockUseConversation.mockReturnValue({
        data: { id: 'conv-123', title: 'My Chat' },
        isLoading: false,
      });
      mockUseMessages.mockReturnValue({
        data: [{ id: 'msg-1', conversationId: 'conv-123', role: 'user', content: 'Hello' }],
        isLoading: false,
      });

      render(<ChatConversation />, { wrapper: createWrapper() });

      const titleElement = screen.getByTestId('chat-title');
      expect(titleElement).toHaveTextContent('My Chat');
    });

    it('redirects to /chat when conversation not found', () => {
      mockUseConversation.mockReturnValue({
        data: null,
        isLoading: false,
      });
      mockUseMessages.mockReturnValue({
        data: [],
        isLoading: false,
      });

      render(<ChatConversation />, { wrapper: createWrapper() });

      expect(screen.getByTestId('navigate-redirect')).toHaveTextContent('/chat');
    });
  });
});

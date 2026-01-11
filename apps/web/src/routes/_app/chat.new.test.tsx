import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { usePendingChatStore } from '@/stores/pending-chat';

// Mock router
const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => mockNavigate,
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate-redirect">{to}</div>,
}));

// Mock hooks
const mockMutateAsync = vi.fn();
const mockCreateConversation = {
  mutate: vi.fn(),
  mutateAsync: mockMutateAsync,
  isPending: false,
};

const mockStartStream = vi.fn().mockResolvedValue({
  assistantMessageId: 'assistant-msg-123',
  content: 'Mock response content',
});

vi.mock('@/hooks/chat', () => ({
  useCreateConversation: () => mockCreateConversation,
  useChatStream: () => ({
    isStreaming: false,
    startStream: mockStartStream,
  }),
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
}));

vi.mock('@/hooks/models', () => ({
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
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/stores/model', () => ({
  useModelStore: () => ({
    selectedModelId: 'test-model',
    selectedModelName: 'Test Model',
    setSelectedModel: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => 800,
}));

vi.mock('@/hooks/billing', () => ({
  useBalance: () => ({ data: { balance: '0.00' } }),
  billingKeys: {
    balance: () => ['balance'],
  },
}));

vi.mock('@/lib/auth', () => ({
  useSession: () => ({ data: { user: { id: 'test-user-id' } } }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
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

// Import after mocks
import { ChatNew } from './chat.new';

describe('ChatNew', () => {
  beforeEach(() => {
    // Reset all mocks including implementations
    vi.resetAllMocks();
    // Restore default mocks
    mockStartStream.mockResolvedValue({
      assistantMessageId: 'assistant-msg-123',
      content: 'Mock response content',
    });
    // Default: mutateAsync resolves with a conversation (tests can override)
    mockMutateAsync.mockResolvedValue({ conversation: { id: 'default-conv-id' } });
    // Reset store to initial state
    usePendingChatStore.setState({ pendingMessage: null });
  });

  describe('without pending message', () => {
    it('redirects to /chat when no pending message in store', () => {
      render(<ChatNew />);

      expect(screen.getByTestId('navigate-redirect')).toHaveTextContent('/chat');
    });
  });

  describe('with pending message', () => {
    beforeEach(() => {
      usePendingChatStore.setState({ pendingMessage: 'Hello, this is my first message' });
    });

    it('displays the pending message immediately', () => {
      render(<ChatNew />);

      expect(screen.getByText('Hello, this is my first message')).toBeInTheDocument();
    });

    it('fires createConversation mutation on mount', async () => {
      render(<ChatNew />);

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledWith({
          firstMessage: { content: 'Hello, this is my first message' },
        });
      });
    });

    it('navigates to conversation URL after streaming completes', async () => {
      mockMutateAsync.mockResolvedValue({ conversation: { id: 'real-conv-123' } });

      render(<ChatNew />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/chat/$conversationId',
          params: { conversationId: 'real-conv-123' },
          replace: true,
        });
      });
    });

    it('clears pending message from store on success', async () => {
      mockMutateAsync.mockResolvedValue({ conversation: { id: 'real-conv-123' } });

      render(<ChatNew />);

      await waitFor(() => {
        expect(usePendingChatStore.getState().pendingMessage).toBeNull();
      });
    });

    it('starts streaming after conversation is created', async () => {
      mockMutateAsync.mockResolvedValue({ conversation: { id: 'real-conv-123' } });

      render(<ChatNew />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          { conversationId: 'real-conv-123', model: 'test-model' },
          expect.any(Object)
        );
      });
    });

    it('shows chat header with model selector', () => {
      render(<ChatNew />);

      // ChatHeader is rendered
      expect(screen.getByRole('banner')).toBeInTheDocument();
    });

    it('shows prompt input disabled during creation', () => {
      mockCreateConversation.isPending = true;

      render(<ChatNew />);

      const textarea = screen.getByPlaceholderText('Type a message...');
      expect(textarea).toBeDisabled();

      mockCreateConversation.isPending = false;
    });
  });

  describe('error handling', () => {
    it('navigates back to /chat on creation error', async () => {
      usePendingChatStore.setState({ pendingMessage: 'Test message' });

      mockMutateAsync.mockRejectedValue(new Error('Failed to create'));

      render(<ChatNew />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('preserves pending message in store on error for recovery', async () => {
      usePendingChatStore.setState({ pendingMessage: 'Test message' });

      mockMutateAsync.mockRejectedValue(new Error('Failed to create'));

      render(<ChatNew />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalled();
      });

      // Message should still be in store for recovery
      expect(usePendingChatStore.getState().pendingMessage).toBe('Test message');
    });
  });
});

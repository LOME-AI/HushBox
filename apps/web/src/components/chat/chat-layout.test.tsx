import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatLayout } from './chat-layout';
import type { Message } from '@/lib/api';
import type { Document } from '@/lib/document-parser';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-visual-viewport-height', () => ({
  useVisualViewportHeight: () => 800,
}));

vi.mock('@/hooks/use-keyboard-offset', () => ({
  useKeyboardOffset: () => ({ bottom: 0, isKeyboardVisible: false }),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/hooks/use-scroll-behavior', () => ({
  useScrollBehavior: () => ({
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    bottomPadding: 800,
    isAutoScrollEnabled: true,
  }),
}));

vi.mock('@/hooks/use-premium-model-click', () => ({
  usePremiumModelClick: () => vi.fn(),
}));

vi.mock('@/hooks/use-tier-info', () => ({
  useTierInfo: () => ({ canAccessPremium: true }),
}));

vi.mock('@/hooks/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

vi.mock('@/stores/model', () => ({
  useModelStore: () => ({
    selectedModelId: 'gpt-4',
    selectedModelName: 'GPT-4',
    setSelectedModel: vi.fn(),
  }),
}));

vi.mock('@/stores/ui-modals', () => ({
  useUIModalsStore: () => ({
    signupModalOpen: false,
    signupModalVariant: undefined,
    paymentModalOpen: false,
    premiumModelName: undefined,
    setSignupModalOpen: vi.fn(),
    setPaymentModalOpen: vi.fn(),
  }),
}));

vi.mock('@/components/chat/chat-header', () => ({
  ChatHeader: ({ title }: { title?: string }) => <div data-testid="chat-header">{title}</div>,
}));

vi.mock('@/components/chat/message-list', () => ({
  MessageList: ({ messages }: { messages: Message[] }) => (
    <div data-testid="message-list">{messages.length} messages</div>
  ),
}));

vi.mock('@/components/chat/prompt-input', () => ({
  PromptInput: React.forwardRef(function MockPromptInput(
    {
      value,
      onChange,
      onSubmit,
      disabled,
    }: {
      value: string;
      onChange: (v: string) => void;
      onSubmit: () => void;
      disabled: boolean;
    },
    ref: React.ForwardedRef<{ focus: () => void }>
  ) {
    React.useImperativeHandle(ref, () => ({ focus: vi.fn() }), []);
    return (
      <input
        data-testid="prompt-input"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
        disabled={disabled}
      />
    );
  }),
}));

vi.mock('@/components/document-panel/document-panel', () => ({
  DocumentPanel: ({ documents }: { documents: Document[] }) => (
    <div data-testid="document-panel">{documents.length} docs</div>
  ),
}));

vi.mock('@/components/auth/signup-modal', () => ({
  SignupModal: () => <div data-testid="signup-modal" />,
}));

vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: () => <div data-testid="payment-modal" />,
}));

describe('ChatLayout', () => {
  const defaultProps = {
    messages: [] as Message[],
    streamingMessageId: null,
    onDocumentsExtracted: vi.fn(),
    inputValue: '',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    inputDisabled: false,
    isProcessing: false,
    historyCharacters: 0,
    documents: [] as Document[],
    isAuthenticated: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the chat header', () => {
    render(<ChatLayout {...defaultProps} title="Test Chat" />);

    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('renders message list when messages exist', () => {
    const messages: Message[] = [
      { id: '1', conversationId: 'conv-1', role: 'user', content: 'Hi', createdAt: '' },
    ];

    render(<ChatLayout {...defaultProps} messages={messages} />);

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByText('1 messages')).toBeInTheDocument();
  });

  it('hides message list when no messages', () => {
    render(<ChatLayout {...defaultProps} messages={[]} />);

    expect(screen.queryByTestId('message-list')).not.toBeInTheDocument();
  });

  it('renders document panel', () => {
    const documents: Document[] = [
      { id: 'doc-1', type: 'code', content: 'Test', title: 'Doc', lineCount: 1 },
    ];

    render(<ChatLayout {...defaultProps} documents={documents} />);

    expect(screen.getByTestId('document-panel')).toBeInTheDocument();
    expect(screen.getByText('1 docs')).toBeInTheDocument();
  });

  it('renders prompt input', () => {
    render(<ChatLayout {...defaultProps} inputValue="Hello" />);

    const input = screen.getByTestId('prompt-input');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('Hello');
  });

  it('calls onInputChange when typing', async () => {
    const onInputChange = vi.fn();
    const user = userEvent.setup();

    render(<ChatLayout {...defaultProps} onInputChange={onInputChange} />);

    await user.type(screen.getByTestId('prompt-input'), 'a');

    expect(onInputChange).toHaveBeenCalledWith('a');
  });

  it('calls onSubmit when pressing Enter', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();

    render(<ChatLayout {...defaultProps} onSubmit={onSubmit} />);

    await user.type(screen.getByTestId('prompt-input'), '{Enter}');

    expect(onSubmit).toHaveBeenCalled();
  });

  it('disables input when inputDisabled is true', () => {
    render(<ChatLayout {...defaultProps} inputDisabled={true} />);

    expect(screen.getByTestId('prompt-input')).toBeDisabled();
  });

  it('renders rate limit message when provided', () => {
    render(<ChatLayout {...defaultProps} rateLimitMessage={true} />);

    expect(screen.getByText(/You've used all 5 free messages today/)).toBeInTheDocument();
    expect(screen.getByText('Sign up')).toBeInTheDocument();
  });

  it('renders modals', () => {
    render(<ChatLayout {...defaultProps} />);

    expect(screen.getByTestId('signup-modal')).toBeInTheDocument();
    expect(screen.getByTestId('payment-modal')).toBeInTheDocument();
  });
});

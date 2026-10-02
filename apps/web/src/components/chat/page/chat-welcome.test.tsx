import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { LAYOUT } from '@hushbox/shared/design-tokens';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { PageShell } from '@/components/shared/page-shell';
import { ChatWelcome } from '@/components/chat/page/chat-welcome';
import { useDecryptedConversations } from '@/hooks/chat/chat';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import type { ConversationListItem, Model } from '@hushbox/shared';
import type { FormFactor } from '@hushbox/ui/platform';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';

// Controllable form factor for the auto-focus effect (desktop band, fine pointer only).
const formFactorRef: { current: FormFactor } = { current: { band: 'desktop', pointer: 'fine' } };

vi.mock('@hushbox/ui/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui/platform')>();
  return { ...actual, useFormFactor: (): FormFactor => formFactorRef.current };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    // The welcome renders with no RouterProvider, which the real Link needs.
    Link: ({
      children,
      to,
      params: _params,
      search: _search,
      ...rest
    }: Readonly<{
      children: React.ReactNode;
      to: string;
      params?: unknown;
      search?: unknown;
    }>): React.JSX.Element => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
});

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(),
}));

vi.mock('@/hooks/billing/use-turn-options', () => ({
  useTurnOptions: () => ({ isPending: false, options: undefined }),
  usePickerOptions: () => ({
    isPending: false,
    affordable: undefined,
    smartSlotAvailability: undefined,
  }),
}));
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: 'light', triggerTransition: vi.fn() }),
}));

vi.mock('@/lib/api/api', () => ({
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

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    getSecureRandomElement: <T,>(array: readonly T[]): T => array[0] as T,
  };
});

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

function resetModelStoreStub(): void {
  modelStoreStubRef.current = createModelStoreStub();
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

vi.mock('@/hooks/models/use-resolve-default-model', () => ({
  useResolveDefaultModel: () => {
    /* no-op in tests */
  },
}));

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
            provider: 'Test Provider',
            modality: 'text',
            description: 'A test model',
            supportedParameters: [],
            pricing: { inputPerToken: '1000', outputPerToken: '2000' },
          },
        ] satisfies Model[],
      },
      isLoading: false,
      error: null,
    })),
  };
});

vi.mock('@/lib/auth/auth', () => ({
  useSession: vi.fn(() => ({
    data: { user: { id: 'test-user', email: 'test@example.com' } },
    isPending: false,
  })),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: vi.fn(() => ({
    displayBalance: '10000000000',
    isStable: true,
  })),
}));

// Mock usePromptBudget directly — PromptInput's only budget dependency.
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: (input: { value: string }): PromptBudgetResult => ({
    fundingSource: 'personal_balance',
    payerSwitch: undefined,
    notifications: [],
    notices: [],
    capacityPercent: 5,
    capacityBand: 'room_to_spare',
    capacityCurrentUsage: 1100,
    capacityMaxCapacity: 50_000,
    estimatedCostNanoUsd: 1_000_000n,
    isOverCapacity: false,
    hasBlockingError: false,
    hasPersistentBlockingError: false,
    sendRefusal: undefined,
    isBillingLoading: false,
    isAffordabilitySettled: true,
    effortDimension: undefined,
    maxOutputTokens: 100_000,
    estimatedInputTokens: 100,
    mediaOptions: undefined,
    hasContent: input.value.trim().length > 0,
  }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({ isStable: true }),
}));

const mockUseTrialRemaining = vi.fn<
  (input: { enabled: boolean; runInFlight: boolean }) => {
    remaining: number | undefined;
    allowanceUntouched: boolean;
  }
>(() => ({ remaining: undefined, allowanceUntouched: true }));

vi.mock('@/hooks/chat/use-trial-remaining', () => ({
  useTrialRemaining: (input: {
    enabled: boolean;
    runInFlight: boolean;
  }): { remaining: number | undefined; allowanceUntouched: boolean } =>
    mockUseTrialRemaining(input),
}));

vi.mock('@/components/shared/stable-content', () => ({
  StableContent: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock('@/components/chat/media/modality-config-panel', () => ({
  ImageAspectRatioControl: () => null,
  VideoAspectRatioControl: () => null,
  VideoResolutionControl: () => null,
  VideoDurationControl: () => null,
  AudioFormatControl: () => null,
  AudioDurationControl: () => null,
  MediaCostLine: () => null,
  MediaFundingNotice: () => null,
}));

vi.mock('framer-motion', async () => {
  const react = await import('react');

  const createMotionComponent = (
    tag: string
  ): React.ForwardRefExoticComponent<
    { children?: React.ReactNode } & React.RefAttributes<HTMLElement>
  > => {
    return react.forwardRef(
      ({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>) => {
        return react.createElement(tag, { ...props, ref }, children);
      }
    );
  };

  const AnimatePresence = ({
    children,
  }: {
    children?: React.ReactNode;
  }): React.ReactElement<React.FragmentProps, React.FunctionComponent<React.FragmentProps>> => {
    return react.createElement(react.Fragment, null, children);
  };

  return {
    motion: {
      span: createMotionComponent('span'),
      div: createMotionComponent('div'),
      p: createMotionComponent('p'),
    },
    AnimatePresence,
    useReducedMotion: () => false,
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
    // The header fills the page shell's slots, which the app layout draws.
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(PageShell, null, children)
    );
  };
}

const mockUseDecryptedConversations = vi.mocked(useDecryptedConversations);

const RECENT_CONVERSATION: ConversationListItem = {
  id: 'conv-recent',
  title: 'Lease renewal letter',
  currentEpoch: 1,
  titleEpochNumber: 1,
  nextSequence: 1,
  createdAt: new Date(TEST_DAY_START - DAY_MS).toISOString(),
  updatedAt: new Date(TEST_DAY_START).toISOString(),
  accepted: true,
  invitedByUsername: null,
  privilege: 'owner',
  muted: false,
  pinned: false,
  lastReadSeq: 0,
  memberCount: 1,
};

/** Each element is after the one before it in the document. */
function expectInDocumentOrder(elements: readonly HTMLElement[]): void {
  for (const [index, element] of elements.entries()) {
    if (index === 0) continue;
    const previous = elements[index - 1];
    expect(previous?.compareDocumentPosition(element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  }
}

describe('ChatWelcome', () => {
  const mockOnSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub();
    formFactorRef.current = { band: 'desktop', pointer: 'fine' };
    mockUseDecryptedConversations.mockReturnValue({
      data: [RECENT_CONVERSATION],
      isLoading: false,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
  });

  describe('the new chat stack', () => {
    it("stacks an account's blocks: greeting, model, composer, Continue, suggestions, storage line", () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      expectInDocumentOrder([
        screen.getByRole('heading', { level: 1 }),
        screen.getByTestId(TEST_IDS.modelInfo),
        screen.getByRole('textbox'),
        screen.getByTestId(TEST_IDS.continueList),
        screen.getByTestId(TEST_IDS.suggestionChips),
        screen.getByTestId(TEST_IDS.storageLine),
      ]);
    });

    it("stacks a visitor's blocks: greeting, model, composer, suggestions, storage line", () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
        wrapper: createWrapper(),
      });

      expectInDocumentOrder([
        screen.getByRole('heading', { level: 1 }),
        screen.getByTestId(TEST_IDS.modelInfo),
        screen.getByRole('textbox'),
        screen.getByTestId(TEST_IDS.suggestionChips),
        screen.getByTestId(TEST_IDS.storageLine),
      ]);
    });

    it('shows a visitor no Continue list, even over a cached conversation list', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
        wrapper: createWrapper(),
      });

      expect(screen.queryByTestId(TEST_IDS.continueList)).not.toBeInTheDocument();
    });

    it("reads out the composer's model under the greeting", () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      expect(screen.getByTestId(TEST_IDS.modelInfo)).toHaveTextContent('Test Model');
    });

    it('sets the stack in the chat column', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      const column = screen
        .getByTestId(TEST_IDS.storageLine)
        .closest<HTMLElement>('[style*="max-width"]');
      expect(column?.style.maxWidth).toBe(LAYOUT.measureChat);
    });

    it('shows no title in the header', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      expect(screen.queryByTestId(TEST_IDS.chatTitle)).not.toBeInTheDocument();
    });

    it('lets a greeting word wider than the column break rather than overflow it', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      expect(screen.getByRole('heading', { level: 1 }).closest('.wrap-anywhere')).not.toBeNull();
    });

    it('sets the greeting in the chat greeting role', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-chat-greeting');
    });
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

  it('marks the greeting block as a reading surface so it renders in the serif', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    // The greeting (title + subtitle) is editorial display copy; data-reading on
    // its container flips the whole block to the serif, not just the h1.
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toHaveAttribute('data-reading');
  });

  it('renders the prompt input', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('keeps the composer at the 2-line start (no rows override)', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '2');
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

    expect(mockOnSend).toHaveBeenCalledWith('Hello world', expect.any(String));
  });

  it('fills prompt input when suggestion chip is clicked', async () => {
    const user = userEvent.setup();
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const codeChip = screen.getByRole('button', { name: /help me write code/i });
    await user.click(codeChip);

    const textarea = screen.getByRole('textbox');
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
    const page = screen.getByTestId('chat-welcome');
    expect(page.textContent).toBeTruthy();
  });

  it('renders theme toggle', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('seats the model chip straight in the composer model slot', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('model-selector-button').parentElement).toHaveAttribute(
      'data-slot',
      'composer-model'
    );
  });

  it('keeps the model picker out of the header', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(
      within(screen.getByTestId('chat-header')).queryByTestId('model-selector-button')
    ).not.toBeInTheDocument();
  });

  it('renders ChatHeader at the top', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
  });

  it('tells an account its chats are saved encrypted', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByTestId(TEST_IDS.storageLine)).toHaveTextContent(
      'Saved encrypted with a key only your devices hold.'
    );
  });

  it('offers a visitor encrypted storage on sign-up', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByTestId(TEST_IDS.storageLine)).toHaveTextContent(
      'Sign up for encrypted storage'
    );
  });

  it('renders search toggle button for authenticated users', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getAllByRole('button', { name: /internet search/i }).length).toBeGreaterThan(0);
  });

  it('renders search toggle button for unauthenticated users', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getAllByRole('button', { name: /internet search/i }).length).toBeGreaterThan(0);
  });

  it('draws no bar of the selected models when several are selected', () => {
    modelStoreStubRef.current.selections.text = [
      { id: 'model-1', name: 'Model One' },
      { id: 'model-2', name: 'Model Two' },
    ];

    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByTestId('selected-models-bar')).not.toBeInTheDocument();
  });

  it('uses the standard subtitle when active modality is image', () => {
    modelStoreStubRef.current.activeModality = 'image';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByText('What should we create?')).not.toBeInTheDocument();
    expect(screen.getByText('One interface. Every feature.')).toBeInTheDocument();
  });

  it('uses the standard subtitle when active modality is video', () => {
    modelStoreStubRef.current.activeModality = 'video';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByText('What scene should we make?')).not.toBeInTheDocument();
    expect(screen.getByText('One interface. Every feature.')).toBeInTheDocument();
  });

  it('uses the standard subtitle when active modality is audio', () => {
    modelStoreStubRef.current.activeModality = 'audio';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByText('What should we listen to?')).not.toBeInTheDocument();
    expect(screen.getByText('One interface. Every feature.')).toBeInTheDocument();
  });

  it('renders text-modality inspiration label by default', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('Need inspiration? Try these:')).toBeInTheDocument();
  });

  it('renders generic inspiration label when active modality is image', () => {
    modelStoreStubRef.current.activeModality = 'image';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('Need inspiration? Try these:')).toBeInTheDocument();
  });

  describe('prompt input auto-focus', () => {
    it('focuses the prompt input on a warm mount that is ready immediately', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />, {
        wrapper: createWrapper(),
      });

      expect(screen.getByRole('textbox')).toHaveFocus();
    });

    it('focuses the prompt input after the loading-to-ready transition', () => {
      const { rerender } = render(
        <ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={true} />,
        { wrapper: createWrapper() }
      );

      rerender(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />);

      expect(screen.getByRole('textbox')).toHaveFocus();
    });

    it('does not focus the prompt input in the phone band', () => {
      formFactorRef.current = { band: 'phone', pointer: 'fine' };

      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />, {
        wrapper: createWrapper(),
      });

      expect(screen.getByRole('textbox')).not.toHaveFocus();
    });

    it('does not focus the prompt input on a coarse pointer in the desktop band', () => {
      formFactorRef.current = { band: 'desktop', pointer: 'coarse' };

      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />, {
        wrapper: createWrapper(),
      });

      expect(screen.getByRole('textbox')).not.toHaveFocus();
    });

    it('focuses the prompt input at most once and does not steal focus on later re-renders', () => {
      const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');

      const { rerender } = render(
        <ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />,
        { wrapper: createWrapper() }
      );

      expect(focusSpy).toHaveBeenCalledTimes(1);

      rerender(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />);

      expect(focusSpy).toHaveBeenCalledTimes(1);

      focusSpy.mockRestore();
    });
  });

  describe('the free-preview count', () => {
    it('is read for the welcome composer of a visitor with no account', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
        wrapper: createWrapper(),
      });

      expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: true, runInFlight: false });
    });

    it('is not read for the welcome composer of a signed-in user', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated />, { wrapper: createWrapper() });

      expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: false, runInFlight: false });
    });
  });
});

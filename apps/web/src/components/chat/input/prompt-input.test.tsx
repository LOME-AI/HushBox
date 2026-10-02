// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { noticeText, TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { renderWithProviders } from '@/test-utils/render';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

// Break the import chain that requires VITE_API_URL at module load time.
// Without these mocks, frontendEnvSchema.parse() runs in src/lib/api/api.ts and
// throws ZodError, preventing every test in this file from loading.
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

vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(
    (): UseModelsStub => ({
      data: { models: [], premiumIds: new Set<string>() },
    })
  ),
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const { mockUseTrialRemaining } = vi.hoisted(() => ({
  mockUseTrialRemaining: vi.fn<
    (input: { enabled: boolean; runInFlight: boolean }) => {
      remaining: number | undefined;
      allowanceUntouched: boolean;
    }
  >(() => ({ remaining: undefined, allowanceUntouched: true })),
}));
vi.mock('@/hooks/chat/use-trial-remaining', () => ({
  useTrialRemaining: (input: {
    enabled: boolean;
    runInFlight: boolean;
  }): { remaining: number | undefined; allowanceUntouched: boolean } =>
    mockUseTrialRemaining(input),
}));

type PayerPremiumAccess = ReturnType<
  typeof import('@/hooks/models/use-payer-premium-access').usePayerPremiumAccess
>;
const PREMIUM_REACHED: PayerPremiumAccess = { status: 'known', canAccessPremium: true };
const PREMIUM_OUT_OF_REACH: PayerPremiumAccess = { status: 'known', canAccessPremium: false };

const { mockUsePayerPremiumAccess } = vi.hoisted(() => ({
  mockUsePayerPremiumAccess: vi.fn<(conversationId: string | null) => PayerPremiumAccess>(() => ({
    status: 'known',
    canAccessPremium: true,
  })),
}));
vi.mock('@/hooks/models/use-payer-premium-access', () => ({
  usePayerPremiumAccess: mockUsePayerPremiumAccess,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetModelStoreStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
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

const useReducedMotionMock = vi.fn<() => boolean>();
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: (): boolean => useReducedMotionMock(),
  };
});

import { PromptInput } from '@/components/chat/input/prompt-input';
import {
  PREDICTION_DEBOUNCE_MS,
  suggestionRowId,
} from '@/components/chat/input/use-prompt-prediction';
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { ChatSearchProps, PromptInputRef } from '@/components/chat/input/prompt-input';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';
import type { PromptPredictor } from '@/lib/prediction/predictor';

// Mock usePromptBudget directly — PromptInput's only budget dependency
const mockUsePromptBudget = vi.fn();

vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: (...args: unknown[]) => mockUsePromptBudget(...args),
}));

const defaultStabilityState = {
  isAuthStable: true,
  isBalanceStable: true,
  isAppStable: true,
};
const mockUseStability = vi.fn(() => defaultStabilityState);

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => mockUseStability(),
  StabilityProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/shared/stable-content', () => ({
  StableContent: ({ isStable, children }: { isStable: boolean; children: React.ReactNode }) =>
    isStable ? children : null,
}));

const defaultBudget: PromptBudgetResult = {
  fundingSource: 'personal_balance',
  payerSwitch: undefined,
  effortDimension: undefined,
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
  hasContent: true,
  maxOutputTokens: 100_000,
  estimatedInputTokens: 100,
  mediaOptions: undefined,
};

/**
 * Build a `searchProps` fixture for PromptInput tests. Defaults:
 * webSearchEnabled=false, onToggleWebSearch=vi.fn(). Override any field as needed.
 */
function makeSearchProps(overrides: Partial<ChatSearchProps> = {}): ChatSearchProps {
  return {
    webSearchEnabled: false,
    canUseWebSearch: true,
    onToggleWebSearch: vi.fn(),
    ...overrides,
  };
}

describe('PromptInput', () => {
  const mockOnChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
      ...defaultBudget,
      hasContent: input.value.trim().length > 0,
    }));
    mockUseStability.mockReturnValue(defaultStabilityState);
    useReducedMotionMock.mockReturnValue(false);
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'auto' });
    resetModelStoreStub();
    mockUsePayerPremiumAccess.mockReturnValue(PREMIUM_REACHED);
    mockUseModels.mockReturnValue({
      data: { models: [], premiumIds: new Set<string>() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearLinkGuestAuth();
    useA11yStore.getState().reset();
  });

  it('renders a textarea', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  describe('the composer frame', () => {
    function slot(name: string): HTMLElement {
      const element = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
      if (element === null) throw new Error(`no [data-slot="${name}"] rendered`);
      return element;
    }

    function renderTextComposer(
      overrides: Partial<React.ComponentProps<typeof PromptInput>> = {}
    ): void {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
          searchProps={makeSearchProps()}
          {...overrides}
        />
      );
    }

    it('declares the composer container on the composer', () => {
      renderTextComposer();

      expect(slot('composer')).toHaveClass('@container/composer');
    });

    it('holds the text field inside the composer container', () => {
      renderTextComposer();

      expect(slot('composer')).toContainElement(slot('composer-field'));
      expect(slot('composer-field')).toContainElement(screen.getByRole('textbox'));
    });

    it('draws the field with a 12px radius, the control border and the page background', () => {
      renderTextComposer();

      expect(slot('composer-field')).toHaveClass(
        'rounded-xl',
        'border',
        'border-border-control',
        'bg-background'
      );
    });

    it('keeps the Signal Red border while the pointer rests on a focused field', () => {
      renderTextComposer();

      // The hover border is scoped to an unfocused field, so it can never outrank
      // the focus border whatever order the stylesheet emits the two in.
      const classes = slot('composer-field').className.split(/\s+/u);
      expect(classes).toContain('not-focus-within:hover:border-foreground-muted');
      expect(classes).not.toContain('hover:border-foreground-muted');
    });

    it('rings the field in Signal Red, 2px wide and 2px out, while focus is inside it', () => {
      renderTextComposer();

      expect(slot('composer-field')).toHaveClass(
        'focus-within:border-brand-red',
        'focus-within:outline-2',
        'focus-within:outline-offset-2',
        'focus-within:outline-brand-red'
      );
    });

    it('marks a disabled composer so its field takes the neutral fill', () => {
      renderTextComposer({ disabled: true });

      expect(slot('composer-field')).toHaveAttribute('data-disabled');
    });

    it('leaves an enabled composer unmarked', () => {
      renderTextComposer();

      expect(slot('composer-field')).not.toHaveAttribute('data-disabled');
    });

    it('sits the control bar inside the field, after the text', () => {
      renderTextComposer();

      const bar = slot('composer-bar');
      expect(slot('composer-field')).toContainElement(bar);
      expect(
        screen.getByRole('textbox').compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('puts the mode menu in the mode slot', () => {
      renderTextComposer();

      expect(slot('composer-mode')).toContainElement(
        screen.getByRole('button', { name: 'Change mode' })
      );
    });

    it('seats the mode chip straight in the mode slot, where the group spaces it from the "+"', () => {
      renderTextComposer({ activeModality: 'image', searchProps: undefined });

      expect(screen.getByRole('button', { name: 'Mode: image' }).parentElement).toBe(
        slot('composer-mode')
      );
    });

    it('seats the ratio chip in the mode slot in image mode', () => {
      renderTextComposer({ activeModality: 'image', searchProps: undefined });

      expect(slot('composer-mode')).toContainElement(
        screen.getByRole('button', { name: 'Aspect ratio: 1:1' })
      );
    });

    it.each(['text', 'video'] as const)('draws no ratio chip in %s mode', (mode) => {
      renderTextComposer({ activeModality: mode, searchProps: undefined });

      expect(screen.queryByRole('button', { name: /^Aspect ratio:/ })).not.toBeInTheDocument();
    });

    it('hands the ratio popover the verdict the payer can afford', () => {
      const unaffordable = {
        sendable: true,
        all: [],
        turnDimensions: [
          {
            dimensionId: 'aspectRatio',
            options: [
              {
                optionId: '16:9',
                label: '16:9',
                availability: { available: false, reason: 'insufficient_funds' },
              },
            ],
          },
        ],
      } satisfies NonNullable<PromptBudgetResult['mediaOptions']>['affordable'];
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        mediaOptions: { affordable: unaffordable, admissible: unaffordable },
      });
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'fictional/image',
              name: 'Image',
              provider: 'Fictional',
              description: 'Image generation model.',
              modality: 'image',
              contextLength: 0,
              supportedParameters: [],
              supportedAspectRatios: ['1:1', '16:9'],
              pricing: { perImage: '40000000' },
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      resetModelStoreStub({
        activeModality: 'image',
        selections: {
          text: [],
          image: [{ id: 'fictional/image', name: 'Image' }],
          audio: [],
          video: [],
        },
      });
      renderTextComposer({ activeModality: 'image', searchProps: undefined });

      fireEvent.click(screen.getByRole('button', { name: 'Aspect ratio: 1:1' }));

      expect(
        within(screen.getByRole('dialog', { name: 'Aspect ratio' })).getByRole('button', {
          name: '16:9',
        })
      ).toHaveAttribute('aria-disabled', 'true');
    });

    it('puts the search toggle in the Search slot', () => {
      renderTextComposer();

      expect(slot('composer-search')).toContainElement(
        screen.getByRole('button', { name: /turn on internet search/i })
      );
    });

    it('keeps the group AI toggle beside the mode controls', () => {
      renderTextComposer({ isGroupChat: true, onSubmitUserOnly: vi.fn() });

      expect(slot('composer-mode')).toContainElement(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
    });

    it('puts Send last in the right group', () => {
      renderTextComposer();

      expect(slot('composer-right').lastElementChild).toBe(screen.getByTestId(TEST_IDS.sendButton));
    });

    it('keeps the queue-full hint beside Send', () => {
      renderTextComposer({ isProcessing: true, onQueue: vi.fn(), queueFull: true, queueCount: 3 });

      expect(slot('composer-right')).toContainElement(screen.getByTestId(TEST_IDS.queueFullHint));
    });

    it('leaves the model chip and estimate slots empty when no model control is given', () => {
      renderTextComposer();

      expect(slot('composer-model')).toBeEmptyDOMElement();
      expect(slot('composer-estimate')).toBeEmptyDOMElement();
    });

    it('seats the model control straight in the model slot', () => {
      renderTextComposer({ modelControl: <button type="button">Model: GPT-5</button> });

      expect(screen.getByRole('button', { name: 'Model: GPT-5' }).parentElement).toBe(
        slot('composer-model')
      );
    });

    it('draws nothing above the field', () => {
      renderTextComposer();

      expect(slot('composer-above-field')).toBeEmptyDOMElement();
    });

    it('hides the empty top-edge and above-field slots from layout', () => {
      renderTextComposer();

      expect(slot('composer-top-edge')).toHaveClass('empty:hidden');
      expect(slot('composer-above-field')).toHaveClass('empty:hidden');
    });

    it('seats the context gauge on the top edge in text mode', () => {
      renderTextComposer();

      expect(slot('composer-top-edge')).toContainElement(
        screen.getByRole('meter', { name: 'Context used' })
      );
    });

    it('keeps the context gauge out of the field', () => {
      renderTextComposer();

      expect(slot('composer-field')).not.toContainElement(screen.getByTestId(TEST_IDS.capacityBar));
    });

    it('hands the gauge the context used and the window it fills', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityCurrentUsage: 12_500,
        capacityMaxCapacity: 50_000,
      });
      renderTextComposer();

      expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute(
        'aria-valuenow',
        '25'
      );
    });

    it("hands the gauge the budget's band rather than one of its own", () => {
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, capacityBand: 'nearly_full' });
      renderTextComposer();

      expect(screen.getByRole('meter', { name: 'Context used' })).toHaveAttribute(
        'data-band',
        'full'
      );
    });

    it('treats a composer with no mode chosen as text mode', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(slot('composer-top-edge')).toContainElement(screen.getByTestId(TEST_IDS.capacityBar));
    });

    it.each(['image', 'video'] as const)('draws nothing on the top edge in %s mode', (mode) => {
      renderTextComposer({ activeModality: mode, searchProps: undefined });

      expect(slot('composer-top-edge')).toBeEmptyDOMElement();
    });

    it('seats the gauge on the top edge when audio is chosen but not offered', () => {
      renderTextComposer({ activeModality: 'audio', audioModalityEnabled: false });

      expect(slot('composer-top-edge')).toContainElement(screen.getByTestId(TEST_IDS.capacityBar));
    });

    it('draws nothing on the top edge in audio mode when audio is offered', () => {
      renderTextComposer({ activeModality: 'audio', audioModalityEnabled: true });

      expect(slot('composer-top-edge')).toBeEmptyDOMElement();
    });

    it('starts the text below the gauge when audio is chosen but not offered', () => {
      renderTextComposer({ activeModality: 'audio', audioModalityEnabled: false });

      expect(slot('composer-text')).toHaveClass('mt-2');
    });

    it("starts the text's scroll area below the gauge", () => {
      renderTextComposer();

      expect(slot('composer-text')).toContainElement(screen.getByRole('textbox'));
      expect(slot('composer-text')).toHaveClass('mt-2');
    });

    it("pays the gauge's margin back from the text box's minimum height", () => {
      renderTextComposer();

      // The inline declaration reads back with its constant terms folded.
      expect(screen.getByRole('textbox').style.minHeight).toBe('calc(3.5rem)');
    });

    it("pays the margin back from a caller's own minimum height", () => {
      renderTextComposer({ minHeight: '56px' });

      expect(screen.getByRole('textbox').style.minHeight).toBe('calc(56px - 0.5rem)');
    });

    it('keeps the text box two lines tall by default while the gauge is seated', () => {
      renderTextComposer();

      expect(slot('composer-top-edge')).toContainElement(screen.getByTestId(TEST_IDS.capacityBar));
      expect(screen.getByRole('textbox')).toHaveAttribute('rows', '2');
    });

    it('keeps the full minimum height when no gauge is drawn', () => {
      renderTextComposer({ activeModality: 'image', searchProps: undefined });

      expect(screen.getByRole('textbox').style.minHeight).toBe('4rem');
    });

    it('leaves the text where it was when no gauge is drawn', () => {
      renderTextComposer({ activeModality: 'image', searchProps: undefined });

      expect(slot('composer-text')).toContainElement(screen.getByRole('textbox'));
      expect(slot('composer-text')).not.toHaveClass('mt-2');
    });

    it('keeps a line for the estimate above the field, inside the composer container', () => {
      renderTextComposer();

      const line = slot('composer-estimate-above');
      expect(slot('composer')).toContainElement(line);
      expect(
        line.compareDocumentPosition(slot('composer-field')) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('shows the estimate line only on a composer under 34rem that holds an estimate', () => {
      renderTextComposer();

      expect(slot('composer-estimate-above')).toHaveClass(
        'hidden',
        '@max-composer-compact/composer:not-empty:flex'
      );
    });

    it('sets the estimate line to the right, clear of the field below it', () => {
      renderTextComposer();

      expect(slot('composer-estimate-above')).toHaveClass('justify-end', 'px-1', 'pb-1');
    });

    it('seats the top edge on the field border at the right', () => {
      renderTextComposer();

      expect(slot('composer-top-edge')).toHaveClass(
        'absolute',
        'top-0',
        'right-3',
        '-translate-y-1/2'
      );
    });

    it('draws Send as the filled Signal Red button', () => {
      renderTextComposer();

      expect(screen.getByTestId(TEST_IDS.sendButton)).toHaveAttribute('data-variant', 'default');
    });

    it('draws Send as a 2.25rem square that grows to 2.75rem on a coarse pointer', () => {
      renderTextComposer();

      expect(screen.getByTestId(TEST_IDS.sendButton)).toHaveClass(
        'size-9',
        'pointer-coarse:size-11'
      );
    });

    it('draws an arrow on Send', () => {
      renderTextComposer();

      expect(
        screen.getByTestId(TEST_IDS.sendButton).querySelector('.lucide-arrow-up')
      ).toBeInTheDocument();
    });

    it('names the textarea by its placeholder, not "Message"', () => {
      renderTextComposer({ placeholder: 'Type a message...' });

      expect(screen.getByRole('textbox', { name: 'Type a message...' })).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    });

    it('keeps the literal ids the mobile flows read', () => {
      renderTextComposer();

      expect(screen.getByRole('textbox')).toHaveAttribute('id', 'prompt-input');
      expect(screen.getByTestId(TEST_IDS.sendButton)).toHaveAttribute('id', 'send-button');
    });

    it('stacks the notices below the composer container, not inside it', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          { id: 'context_near_capacity', type: 'warning', message: 'Sample notice.' },
        ],
      });
      renderTextComposer();

      const notices = screen.getByTestId('budget-messages');
      expect(slot('composer')).not.toContainElement(notices);
      expect(
        slot('composer').compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });

  describe('animated placeholder overlay', () => {
    it('renders the AnimatedPlaceholder with the given placeholder text when value is empty', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      const overlay = screen.getByTestId('animated-placeholder');
      expect(overlay).toBeInTheDocument();
      expect(overlay).toHaveTextContent('Ask me anything...');
    });

    it('does not render the AnimatedPlaceholder while the textarea has content (no-op when typing)', () => {
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      expect(screen.queryByTestId('animated-placeholder')).not.toBeInTheDocument();
    });

    it('does not set a native placeholder attribute (the overlay drives the visual)', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea.getAttribute('placeholder') ?? '').toBe('');
    });

    it('keeps aria-label on the textarea so the placeholder is still the accessible name', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Ask me anything...');
    });

    it('updates the overlay text when the placeholder prop changes (modality switch)', () => {
      const { rerender } = renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      expect(screen.getByTestId('animated-placeholder')).toHaveTextContent('Ask me anything...');

      rerender(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Describe the image you want..."
        />
      );
      expect(screen.getByTestId('animated-placeholder')).toHaveTextContent(
        'Describe the image you want...'
      );
    });
  });

  it('displays the current value', () => {
    renderWithProviders(
      <PromptInput value="Hello world" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
  });

  it('calls onChange when typing', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Test');
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('calls onSubmit when Enter is pressed without Shift', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('does not call onSubmit when Shift+Enter is pressed (allows newline)', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('does not call onSubmit on the Enter that confirms an input-method conversion', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('does not queue on the Enter that confirms an input-method conversion', () => {
    const onQueue = vi.fn();
    renderWithProviders(
      <PromptInput
        value="Test message"
        onChange={mockOnChange}
        onSubmit={mockOnSubmit}
        onQueue={onQueue}
        isProcessing
      />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true });
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('has send button', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('send button calls onSubmit when clicked', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithProviders(
      <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('send button is disabled when value is empty', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('capacity bar', () => {
    it('displays capacity bar', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });

    it('shows capacity percentage', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 25,
        capacityCurrentUsage: 12_500,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('meter', { name: 'Context used' })).toHaveTextContent('25%');
    });

    it('send button is disabled when over capacity', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 105,
        isOverCapacity: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('send button is disabled when billing is denied', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          { id: 'insufficient_funds', type: 'error', message: 'Sample blocking notice.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('textarea remains enabled even when over capacity', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 105,
        isOverCapacity: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });
  });

  describe('budget messages', () => {
    it('displays budget notifications when present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          { id: 'insufficient_funds', type: 'error', message: 'Sample blocking notice.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('budget-messages')).toBeInTheDocument();
      expect(screen.getByText('Sample blocking notice.')).toBeInTheDocument();
    });

    it('does not show budget messages when no notifications', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
    });

    it('shows warning messages', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'context_near_capacity',
            type: 'warning',
            message: 'Sample warning notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText('Sample warning notice.')).toBeInTheDocument();
    });

    it('shows info messages', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_preview_pays',
            type: 'info',
            message: 'Sample info notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText('Sample info notice.')).toBeInTheDocument();
    });

    it('hides budget messages while app is not stable (balance loading)', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_preview_pays',
            type: 'info',
            message: 'Sample info notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
      expect(screen.queryByText('Sample info notice.')).not.toBeInTheDocument();
    });

    it('hides budget messages while app is not stable (session loading)', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_preview_pays',
            type: 'info',
            message: 'Sample info notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
      expect(screen.queryByText('Sample info notice.')).not.toBeInTheDocument();
    });
  });

  describe('the free-preview count', () => {
    it('is read for a composer that spends the free preview', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
        />
      );
      expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: true, runInFlight: false });
    });

    it('is not read for a composer that spends a wallet', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
        />
      );
      expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: false, runInFlight: false });
    });

    it('re-reads after the run the composer is streaming', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          isProcessing
        />
      );
      expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: true, runInFlight: true });
    });

    // The shared-link composer reaches PromptInput with `isAuthenticated={false}`
    // too, because a link guest holds no session. Its messages are the owner's
    // spend, never the free preview, so the count has nothing to say there.
    it('is not read for an anonymous guest in a conversation opened from a shared link', () => {
      setLinkGuestAuth('link-guest-public-key');

      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
        />
      );

      expect(mockUseTrialRemaining).toHaveBeenCalledWith({ enabled: false, runInFlight: false });
    });
  });

  describe('self-contained budget calculation', () => {
    it('accepts historyCharacters prop for budget calculation', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          historyCharacters={5000}
        />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });
  });

  describe('custom height props', () => {
    it('applies custom minHeight when provided', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="image"
          minHeight="56px"
        />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ minHeight: '56px' });
    });

    it('applies custom maxHeight when provided', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} maxHeight="112px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ maxHeight: '112px' });
    });

    it('starts at a two-line default minHeight (founder-ruled sizing)', () => {
      // 2 lines × 1.5rem line-height (text-base) + 1rem vertical padding.
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="image"
        />
      );
      const textarea = screen.getByRole('textbox');
      // Read off the inline declaration: getComputedStyle resolves a relative
      // length to an absolute one, so toHaveStyle cannot assert a rem value.
      expect(textarea.style.minHeight).toBe('4rem');
      expect(textarea).toHaveAttribute('rows', '2');
    });

    it('caps growth at a seven-line default maxHeight (founder-ruled sizing)', () => {
      // 7 lines × 1.5rem line-height (text-base) + 1rem vertical padding.
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea.style.maxHeight).toBe('11.5rem');
    });

    it('auto-grows with content and scrolls internally beyond the cap', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      // The ui Textarea grows via a same-cell CSS grid sizing replica, not
      // field-sizing-content (Firefox doesn't honor that property);
      // overflow-y-auto takes over once max-height stops the growth.
      expect(textarea.className).toContain('[grid-area:1/1]');
      expect(textarea.className).toContain('overflow-y-auto');
    });

    it('flows an arbitrary minHeight value through to the applied style', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="image"
          minHeight="999px"
        />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ minHeight: '999px' });
    });

    it('flows an arbitrary maxHeight value through to the applied style', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} maxHeight="80vh" />
      );
      const textarea = screen.getByRole('textbox');
      // Read off the inline declaration: getComputedStyle resolves a relative
      // length to an absolute one, so toHaveStyle cannot assert a viewport unit.
      expect(textarea.style.maxHeight).toBe('80vh');
    });

    it('does not emit runtime-interpolated arbitrary Tailwind height classes', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          minHeight="56px"
          maxHeight="112px"
        />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea.className).not.toMatch(/min-h-\[/);
      expect(textarea.className).not.toMatch(/max-h-\[/);
    });
  });

  describe('processing mode', () => {
    it('disables the send button during processing when no queue handler is provided', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      const button = screen.getByRole('button', { name: /cannot queue/i });
      expect(button).toBeDisabled();
    });

    it('never renders the stop/square icon during processing; keeps the send arrow', () => {
      const { container } = renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      const button = screen.getByTestId('send-button');
      expect(button.querySelector('.lucide-square')).toBeNull();
      expect(container.querySelector('.lucide-square')).toBeNull();
      expect(button.querySelector('.lucide-arrow-up')).toBeInTheDocument();
    });

    it('renders the send arrow (never a stop icon) when idle', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const button = screen.getByTestId('send-button');
      expect(button.querySelector('.lucide-square')).toBeNull();
      expect(button.querySelector('.lucide-arrow-up')).toBeInTheDocument();
    });

    it('keeps textarea enabled during processing for type-ahead', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });

    it('shows send icon when not processing and can submit', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const button = screen.getByRole('button', { name: /send/i });
      expect(button).not.toBeDisabled();
    });
  });

  describe('queue while streaming', () => {
    it('click enqueues the trimmed text and clears the input, not calling onSubmit', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="  hello  "
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      const button = screen.getByTestId('send-button');
      expect(button).not.toBeDisabled();
      fireEvent.click(button);
      expect(onQueue).toHaveBeenCalledWith('hello');
      expect(mockOnChange).toHaveBeenCalledWith('');
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('announces that it queues while a reply is streaming', () => {
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={vi.fn()}
        />
      );
      const button = screen.getByTestId(TEST_IDS.sendButton);
      expect(button).not.toBeDisabled();
      expect(button).toHaveAccessibleName('Queue');
    });

    it('announces that queueing is blocked, not that sending is, when the queue is full', () => {
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={vi.fn()}
          queueFull
          queueCount={5}
        />
      );
      const button = screen.getByTestId(TEST_IDS.sendButton);
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleName('Cannot queue');
    });

    it('Enter enqueues the trimmed text and clears the input, not calling onSubmit', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="  hello  "
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(onQueue).toHaveBeenCalledWith('hello');
      expect(mockOnChange).toHaveBeenCalledWith('');
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('disables the button and shows a queue-full hint when the queue is full', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
          queueFull
          queueCount={5}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      const hint = screen.getByTestId('queue-full-hint');
      expect(hint).toHaveTextContent('Queue full (5)');
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('disables the queue button for whitespace-only input during streaming', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="   "
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('does not render the queue-full hint when the queue is not full', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.queryByTestId('queue-full-hint')).not.toBeInTheDocument();
    });

    it('does not queue a message the send gate refuses for money', () => {
      const onQueue = vi.fn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        hasPersistentBlockingError: true,
      });
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      fireEvent.click(screen.getByTestId('send-button'));
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('does not queue a message that overflows the model context', () => {
      const onQueue = vi.fn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isOverCapacity: true,
        hasBlockingError: true,
        hasPersistentBlockingError: true,
      });
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    // The queue exists for the window in which a reply is already in flight. A
    // block that ends when that reply ends must therefore leave the queue open —
    // closing it there removes the affordance in its only window.
    it('queues a message while a block that ends on its own holds the send', () => {
      const onQueue = vi.fn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        hasPersistentBlockingError: false,
        sendRefusal: 'funds_held_by_run',
      });
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeEnabled();
      fireEvent.click(screen.getByTestId('send-button'));
      expect(onQueue).toHaveBeenCalledWith('hello');
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not queue a message while a block that outlasts the reply holds the send', () => {
      const onQueue = vi.fn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        hasPersistentBlockingError: true,
        sendRefusal: 'prompt_too_long',
      });
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      fireEvent.click(screen.getByTestId('send-button'));
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('does not queue from a composer the caller may not send from', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          disabled
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      fireEvent.click(screen.getByTestId('send-button'));
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('sends normally (not queue) when idle even if onQueue is supplied', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onQueue={onQueue}
        />
      );
      fireEvent.click(screen.getByTestId('send-button'));
      expect(mockOnSubmit).toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
    });
  });

  describe('ref and focus', () => {
    it('exposes focus method via ref', () => {
      const ref = React.createRef<PromptInputRef>();
      renderWithProviders(
        <PromptInput ref={ref} value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(ref.current).not.toBeNull();
      expectExposes(ref.current ?? {}, 'focus');
    });

    it('focuses textarea when focus() is called', () => {
      const ref = React.createRef<PromptInputRef>();
      renderWithProviders(
        <PromptInput ref={ref} value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);

      ref.current?.focus();

      expect(document.activeElement).toBe(textarea);
    });

    it('does not auto-focus when initially enabled (not a transition)', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled={false} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });

    it('does not auto-focus when transitioning from enabled to disabled', () => {
      const { rerender } = renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled={false} />
      );

      const textarea = screen.getByRole('textbox');

      rerender(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />);

      expect(textarea).toBeDisabled();
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('autoFocus prop', () => {
    it('applies autoFocus to textarea when autoFocus is true', async () => {
      renderWithProviders(
        // eslint-disable-next-line jsx-a11y/no-autofocus -- test exercises autoFocus prop behavior
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} autoFocus />
      );

      const textarea = screen.getByRole('textbox');
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(textarea);
      });
    });

    it('does not autoFocus textarea when autoFocus is false', () => {
      renderWithProviders(
        // eslint-disable-next-line jsx-a11y/no-autofocus -- test exercises autoFocus prop behavior
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} autoFocus={false} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });

    it('does not autoFocus textarea when autoFocus is not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('AI toggle', () => {
    it('does not show AI toggle when isGroupChat is not set', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(
        screen.queryByRole('button', { name: 'AI replies to this message' })
      ).not.toBeInTheDocument();
    });

    it('shows AI toggle when isGroupChat is true', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      expect(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      ).toBeInTheDocument();
    });

    it('defaults to AI ON', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      expect(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      ).toBeInTheDocument();
    });

    it('toggles to AI OFF when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      const toggle = screen.getByRole('button', {
        name: 'AI replies to this message',
        pressed: true,
      });
      await user.click(toggle);
      expect(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: false })
      ).toBeInTheDocument();
    });

    it('toggles back to AI ON on second click', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      const toggle = screen.getByRole('button', {
        name: 'AI replies to this message',
        pressed: true,
      });
      await user.click(toggle);
      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: false })
      );
      expect(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      ).toBeInTheDocument();
    });

    it('calls onSubmitUserOnly instead of onSubmit when AI is off', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('calls onSubmit when AI is on (default)', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockOnSubmit).toHaveBeenCalled();
      expect(mockSubmitUserOnly).not.toHaveBeenCalled();
    });

    it('calls onSubmitUserOnly on Enter key when AI is off', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });
  describe('the AI-off send in a group, which spends nothing', () => {
    const emptyWallet: Partial<PromptBudgetResult> = {
      fundingSource: 'denied',
      hasBlockingError: true,
      hasPersistentBlockingError: true,
      notifications: [
        { id: 'insufficient_funds', type: 'error', message: 'Sample blocking notice.' },
      ],
    };

    it('sends with an empty wallet, the post costing nothing and the API asking for no balance', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...emptyWallet });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toBeEnabled();
      await user.click(send);
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('posts on Enter with an empty wallet', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...emptyWallet });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('leaves the same empty wallet blocking the send while the AI is on', () => {
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...emptyWallet });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={vi.fn()}
          isGroupChat
        />
      );

      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
    });

    it('stays blocked for a read-only member, whose post the API refuses on privilege', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        hasPersistentBlockingError: true,
        notifications: [
          { id: 'conversation_read_only', type: 'info', message: 'Sample read-only notice.' },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          currentUserPrivilege="read"
          isGroupChat
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).not.toHaveBeenCalled();
    });

    it('refuses an empty composer, which the API answers 400', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, hasContent: false });
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).not.toHaveBeenCalled();
    });

    it('refuses a composer its caller has closed', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
          disabled
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).not.toHaveBeenCalled();
    });

    it('never says it is checking a balance this send does not spend', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={vi.fn()}
          isGroupChat
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toHaveAttribute('aria-busy', 'false');
      expect(send).toHaveAccessibleName('Send');
      expect(send.querySelector('.animate-spin')).toBeNull();
    });
  });

  describe('onTypingChange', () => {
    it('calls onTypingChange with true on first input change', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'H' } });
      expect(mockOnTypingChange).toHaveBeenCalledWith(true);
    });

    it('calls onTypingChange with false on submit', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('throttles onTypingChange calls within 3s window', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: 'H' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(1);

      fireEvent.change(textarea, { target: { value: 'He' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(3000);
      fireEvent.change(textarea, { target: { value: 'Hel' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(2);
    });

    it('calls onTypingChange with false when value becomes empty', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value="H"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: '' } });
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('calls onTypingChange with false on unmount', () => {
      const mockOnTypingChange = vi.fn();
      const { unmount } = renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );

      mockOnTypingChange.mockClear();
      unmount();
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('does not error when onTypingChange is not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(() => {
        fireEvent.change(textarea, { target: { value: 'H' } });
      }).not.toThrow();
    });
  });

  describe('search toggle', () => {
    it('does not show search toggle by default', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });

    it('shows enabled search toggle when model supports search and user is authenticated', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps()}
        />
      );
      expect(screen.getByRole('button', { name: /turn on internet search/i })).toBeInTheDocument();
    });

    it('shows search on state when webSearchEnabled is true', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );
      expect(screen.getByRole('button', { name: /turn off internet search/i })).toBeInTheDocument();
    });

    it('renders the off state unpressed', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps()}
        />
      );
      const button = screen.getByRole('button', { name: /turn on internet search/i });
      expect(button).toHaveAttribute('aria-pressed', 'false');
    });

    it('renders the on state pressed', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );
      const button = screen.getByRole('button', { name: /turn off internet search/i });
      expect(button).toHaveAttribute('aria-pressed', 'true');
    });

    it('calls onToggleWebSearch when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockToggle = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ onToggleWebSearch: mockToggle })}
        />
      );
      await user.click(screen.getByRole('button', { name: /turn on internet search/i }));
      expect(mockToggle).toHaveBeenCalled();
    });

    it('shows disabled search toggle for unauthenticated users', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          searchProps={makeSearchProps({ canUseWebSearch: false })}
        />
      );
      const wrapper = screen.getByRole('button', { name: /internet search unavailable/i });
      expect(wrapper).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not render the search toggle when activeModality is image (searchProps undefined)', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
        />
      );
      // Structural guard: chat-layout omits searchProps in image mode, so the
      // toggle should not be rendered at all (not just disabled).
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });

    it('does not render the search toggle when activeModality is video (searchProps undefined)', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="video"
        />
      );
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });
  });

  describe('toggle button tooltips', () => {
    it('makes the disabled search chip its own tooltip trigger', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          searchProps={makeSearchProps({ canUseWebSearch: false })}
        />
      );

      // An aria-disabled chip keeps its focus and events, so no wrapper stands in for it.
      const chip = screen.getByRole('button', { name: /internet search unavailable/i });
      expect(chip.tagName).toBe('BUTTON');
      expect(chip).toHaveAttribute('data-slot', 'tooltip-trigger');
    });

    it('makes the enabled search chip its own tooltip trigger', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );

      const button = screen.getByRole('button', { name: /turn off internet search/i });
      expect(button).toHaveAttribute('data-slot', 'tooltip-trigger');
    });

    it('shows tooltip content when hovering search toggle', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );

      const button = screen.getByRole('button', { name: /turn off internet search/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Turn off internet search');
    });

    it('shows tooltip content when hovering AI toggle', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );

      const button = screen.getByRole('button', {
        name: 'AI replies to this message',
        pressed: true,
      });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Turn off AI replies');
    });

    it('updates search toggle tooltip text after state change', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      function SearchToggleHarness(): React.JSX.Element {
        const [searchOn, setSearchOn] = React.useState(false);
        return (
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            isAuthenticated
            searchProps={makeSearchProps({
              webSearchEnabled: searchOn,
              onToggleWebSearch: () => {
                setSearchOn((previous) => !previous);
              },
            })}
          />
        );
      }

      renderWithProviders(<SearchToggleHarness />);

      const button = screen.getByRole('button', { name: /turn on internet search/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Turn on internet search');

      await user.click(button);

      expect(screen.getByRole('button', { name: /turn off internet search/i })).toBeInTheDocument();
      const updatedTooltip = screen.getByRole('tooltip');
      expect(updatedTooltip).toHaveTextContent('Turn off internet search');
    });
  });

  describe('edit mode', () => {
    it('shows editing indicator when isEditing is true', () => {
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      expect(screen.getByText(/editing/i)).toBeInTheDocument();
    });

    it('does not show editing indicator when isEditing is false', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByText(/editing/i)).not.toBeInTheDocument();
    });

    it('shows cancel button in edit mode', () => {
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('calls onCancelEdit when cancel button is clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const onCancelEdit = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={onCancelEdit}
        />
      );
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancelEdit).toHaveBeenCalledTimes(1);
    });

    it('does not show cancel button when not editing', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('privilege and conversationId forwarding to usePromptBudget', () => {
    it('passes currentUserPrivilege to usePromptBudget even without conversationId', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'conversation_read_only',
            type: 'info',
            message: 'Sample read-only notice.',
          },
        ],
      });

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          currentUserPrivilege: 'read',
        })
      );
    });

    it('passes both conversationId and currentUserPrivilege to usePromptBudget', () => {
      mockUsePromptBudget.mockReturnValue(defaultBudget);

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          conversationId="conv-123"
          currentUserPrivilege="write"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
          currentUserPrivilege: 'write',
        })
      );
    });

    it('passes conversationId without currentUserPrivilege to usePromptBudget', () => {
      mockUsePromptBudget.mockReturnValue(defaultBudget);

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          conversationId="conv-123"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
        })
      );
      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.not.objectContaining({
          currentUserPrivilege: expect.anything(),
        })
      );
    });
  });

  describe('read-only privilege', () => {
    it('send button is disabled when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'conversation_read_only',
            type: 'info',
            message: 'Sample read-only notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('read-only notification renders when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'conversation_read_only',
            type: 'info',
            message: 'Sample read-only notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      expect(screen.getByText('Sample read-only notice.')).toBeInTheDocument();
    });

    it('Enter key does not submit when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'conversation_read_only',
            type: 'info',
            message: 'Sample read-only notice.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('blocking errors', () => {
    it('send button is disabled when blocking error present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        notifications: [
          {
            id: 'prompt_too_long',
            type: 'error',
            message: 'Message exceeds model capacity.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('Enter key does not submit when blocking error present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        notifications: [
          {
            id: 'prompt_too_long',
            type: 'error',
            message: 'Message exceeds model capacity.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('the mode menu', () => {
    function renderModeComposer(
      overrides: Partial<React.ComponentProps<typeof PromptInput>> = {}
    ): void {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
          {...overrides}
        />
      );
    }

    async function openModeMenu(): Promise<ReturnType<typeof userEvent.setup>> {
      vi.useRealTimers();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Change mode' }));
      await screen.findByRole('menu');
      return user;
    }

    it('offers no mode control while it is unknown whether the user is signed in', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: 'Change mode' })).not.toBeInTheDocument();
    });

    it('offers no mode control without a mode to show', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          onSelectModality={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: 'Change mode' })).not.toBeInTheDocument();
    });

    it('offers no mode control without a handler for the choice', () => {
      renderModeComposer({ onSelectModality: undefined });

      expect(screen.queryByRole('button', { name: 'Change mode' })).not.toBeInTheDocument();
    });

    it('offers the "+" to a visitor, with the other modes locked behind sign-up', async () => {
      renderModeComposer({ isAuthenticated: false });

      await openModeMenu();

      expect(screen.getByRole('menuitemradio', { name: 'Image' })).toHaveAccessibleDescription(
        'Sign up to unlock image generation'
      );
    });

    it('checks the mode the composer is in', async () => {
      renderModeComposer({ activeModality: 'video' });

      await openModeMenu();

      expect(screen.getByRole('menuitemradio', { name: 'Video' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
    });

    it('hands the chosen mode to the caller', async () => {
      const handleSelect = vi.fn();
      renderModeComposer({ onSelectModality: handleSelect });
      const user = await openModeMenu();

      await user.click(screen.getByRole('menuitemradio', { name: 'Video' }));

      expect(handleSelect).toHaveBeenCalledWith('video');
    });

    it('shows the pressed mode chip in image mode', () => {
      renderModeComposer({ activeModality: 'image' });

      expect(screen.getByRole('button', { name: 'Mode: image' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('offers no Audio while the composer withholds it, tracking the shipped flag', async () => {
      renderModeComposer();

      await openModeMenu();

      expect(screen.queryByRole('menuitemradio', { name: 'Audio' })).not.toBeInTheDocument();
    });

    it('offers Audio when the caller offers that mode', async () => {
      renderModeComposer({ audioModalityEnabled: true });

      await openModeMenu();

      expect(screen.getByRole('menuitemradio', { name: 'Audio' })).toBeInTheDocument();
    });

    it('reads premium reach for the conversation whose payer funds the turn', () => {
      renderModeComposer({ conversationId: 'conv-owner-funded' });

      expect(mockUsePayerPremiumAccess).toHaveBeenCalledWith('conv-owner-funded');
    });

    it('reads premium reach for no conversation when the composer has none', () => {
      renderModeComposer();

      expect(mockUsePayerPremiumAccess).toHaveBeenCalledWith(null);
    });

    it("locks the media modes by the payer's premium reach", async () => {
      mockUsePayerPremiumAccess.mockReturnValue(PREMIUM_OUT_OF_REACH);
      renderModeComposer();

      await openModeMenu();

      expect(screen.getByRole('menuitemradio', { name: 'Image' })).toHaveAccessibleDescription(
        'Add credit to unlock image generation'
      );
    });

    it("opens the mode menu 0.5rem below the composer's field, at its left edge", async () => {
      // The root font is 16px here, so 0.5rem is 8px.
      const field = { left: 100, top: 200, width: 600, height: 142 };
      const plus = { left: 110, top: 300, width: 34, height: 34 };
      const menuBox = { left: 0, top: 0, width: 192, height: 110 };
      const viewport = { left: 0, top: 0, width: 1024, height: 768 };
      const toRect = (box: typeof field): DOMRect =>
        DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
      const isMenuBox = (element: HTMLElement): boolean =>
        'radixPopperContentWrapper' in element.dataset;
      const spies = [
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
          this: HTMLElement
        ): DOMRect {
          if (this.dataset['slot'] === 'composer-field') return toRect(field);
          if (this.dataset['testid'] === TEST_IDS.modeMenuButton) return toRect(plus);
          if (isMenuBox(this)) return toRect(menuBox);
          if (this === document.documentElement || this === document.body) {
            return toRect(viewport);
          }
          return toRect({ left: 0, top: 0, width: 0, height: 0 });
        }),
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
          this: HTMLElement
        ): number {
          return this === document.documentElement ? viewport.width : 0;
        }),
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
          this: HTMLElement
        ): number {
          return this === document.documentElement ? viewport.height : 0;
        }),
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
          this: HTMLElement
        ): number {
          return isMenuBox(this) ? menuBox.width : 0;
        }),
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
          this: HTMLElement
        ): number {
          return isMenuBox(this) ? menuBox.height : 0;
        }),
      ];
      try {
        renderModeComposer();

        await openModeMenu();

        const wrapper = screen
          .getByRole('menu')
          .closest<HTMLElement>('[data-radix-popper-content-wrapper]');
        await waitFor(() => {
          expect(wrapper?.style.transform).toBe(
            `translate(${String(field.left)}px, ${String(field.top + field.height + 8)}px)`
          );
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('places the "+" before the search toggle in text mode', () => {
      renderModeComposer({ searchProps: makeSearchProps() });

      const search = screen.getByRole('button', { name: /turn on internet search/i });
      const changeMode = screen.getByRole('button', { name: 'Change mode' });
      expect(
        changeMode.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });

  describe('bottom row layouts per modality', () => {
    it('renders text modality with capacity bar and no modality config controls above textarea', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
      // No aspect ratio chips in text mode.
      expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    });

    it('renders image modality with the ratio chip, the estimate and no capacity bar', () => {
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/imagen-4',
              name: 'Imagen 4',
              provider: 'Google',
              description: 'Image generation model.',
              modality: 'image',
              contextLength: 0,
              supportedParameters: [],
              supportedAspectRatios: ['1:1', '16:9'],
              pricing: { perImage: '40000000', dearestPerImage: '40000000' },
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: 'Aspect ratio: 1:1' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '16:9' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('capacity-bar')).not.toBeInTheDocument();
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('renders video modality with duration in row 1 and aspect ratio + resolution in row 2', () => {
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/veo-3.1',
              name: 'Veo 3.1',
              provider: 'Google',
              description: 'Video generation model.',
              modality: 'video',
              contextLength: 0,
              supportedParameters: [],
              supportedAspectRatios: ['16:9', '9:16'],
              pricing: {
                perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
                dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
              },
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="video"
          onSelectModality={vi.fn()}
        />
      );
      // Row 1: duration slider + cost
      expect(screen.getByRole('slider', { name: /video duration/i })).toBeInTheDocument();
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
      // Row 2: aspect ratio + resolution
      expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /720p/i })).toBeInTheDocument();
      // No capacity bar in video mode.
      expect(screen.queryByTestId('capacity-bar')).not.toBeInTheDocument();
    });

    it('renders the audio bottom-row when the caller offers the audio modality', () => {
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
        selections: {
          text: [],
          image: [],
          audio: [{ id: 'openai/tts-1', name: 'TTS-1' }],
          video: [],
        },
      });
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'openai/tts-1',
              name: 'TTS 1',
              provider: 'OpenAI',
              description: 'Audio generation model.',
              modality: 'audio',
              contextLength: 0,
              supportedParameters: [],
              pricing: {},
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="audio"
          onSelectModality={vi.fn()}
          audioModalityEnabled
        />
      );
      expect(screen.getByRole('button', { name: 'mp3' })).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: /audio max duration/i })).toBeInTheDocument();
    });

    it('does not render audio controls when the caller withholds the audio modality', () => {
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="audio"
          onSelectModality={vi.fn()}
          audioModalityEnabled={false}
        />
      );
      expect(screen.queryByRole('button', { name: 'mp3' })).not.toBeInTheDocument();
      expect(screen.queryByRole('slider', { name: /audio max duration/i })).not.toBeInTheDocument();
    });
  });

  describe('toolbar spacing', () => {
    it('keeps the inner toolbar gap at gap-1', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
          isGroupChat
        />
      );
      const aiButton = screen.getByRole('button', {
        name: 'AI replies to this message',
        pressed: true,
      });
      // Walk up to find the toolbar container (the one that holds modality
      // icons, search, AI). It must use gap-1 to keep icons visually tight.
      let element: HTMLElement | null = aiButton.parentElement;
      let toolbar: HTMLElement | null = null;
      while (element) {
        if (element.className.includes('gap-1') && !element.className.includes('gap-1.5')) {
          toolbar = element;
          break;
        }
        element = element.parentElement;
      }
      expect(toolbar).not.toBeNull();
    });
  });

  describe('modality switch animation', () => {
    it('wraps bottom-row content in a height-animation wrapper', () => {
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="audio"
          onSelectModality={vi.fn()}
          audioModalityEnabled
        />
      );
      const audioFormat = screen.getByRole('button', { name: 'mp3' });
      // AnimatedHeight always renders the wrapper now — MotionConfig at the
      // root collapses the animation to instant under reduced motion.
      const motionWrapper = audioFormat.closest('.overflow-y-hidden');
      expect(motionWrapper).not.toBeNull();
    });
  });

  describe('edit banner animation', () => {
    it('renders the edit banner inside the height-animation wrapper', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      const banner = screen.getByText(/editing/i);
      // Edit banner uses AnimatedHeight (`overflow-hidden`), not MorphHeight
      // (`overflow-y-hidden`); the bottom-row test checks MorphHeight.
      const motionWrapper = banner.closest('.overflow-hidden');
      expect(motionWrapper).not.toBeNull();
    });

    it('marks the edit banner wrapper as animated', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );

      const banner = screen.getByText(/editing/i);
      expect(banner.closest('.overflow-hidden')).toHaveAttribute('data-animated', 'true');
    });

    it('marks the edit banner wrapper as unanimated when motion is reduced', () => {
      useA11yStore.getState().update({ stopAnimations: true });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );

      const banner = screen.getByText(/editing/i);
      expect(banner.closest('.overflow-hidden')).toHaveAttribute('data-animated', 'false');
    });
  });

  describe('submit guards and disabled tooltips', () => {
    it('keeps the send button disabled when there is content but the input is disabled', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />
      );

      expect(screen.getByTestId('send-button')).toBeDisabled();
    });

    it('opens and closes the tooltip on focus and blur of a disabled search toggle', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ canUseWebSearch: false })}
        />
      );

      const wrapper = screen.getByRole('button', { name: 'Internet search unavailable' });

      fireEvent.focus(wrapper);
      fireEvent.blur(wrapper);

      expect(wrapper).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not submit on Enter when the input cannot submit', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not submit when funding is denied even if the send button is clicked', () => {
      mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
        ...defaultBudget,
        fundingSource: 'denied',
        hasContent: input.value.trim().length > 0,
      }));

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      fireEvent.click(screen.getByTestId('send-button'));

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not submit on Enter when funding is denied', () => {
      mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
        ...defaultBudget,
        fundingSource: 'denied',
        hasContent: input.value.trim().length > 0,
      }));

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not submit when no funding verdict exists', () => {
      // Not a denial: nothing was read about the payer's money. A send started
      // here would carry an absence where the API expects a funding source.
      mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
        ...defaultBudget,
        fundingSource: 'no_verdict',
        hasContent: input.value.trim().length > 0,
      }));

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      fireEvent.click(screen.getByTestId('send-button'));

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not submit on Enter when no funding verdict exists', () => {
      mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
        ...defaultBudget,
        fundingSource: 'no_verdict',
        hasContent: input.value.trim().length > 0,
      }));

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('reasoning effort menu', () => {
    const reasoningCatalog = {
      data: {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            provider: 'Fictional',
            description: 'Text generation model.',
            modality: 'text',
            contextLength: 200_000,
            supportedParameters: [],
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
            reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
          },
        ],
        premiumIds: new Set<string>(),
      },
    } satisfies UseModelsStub;

    it('shows the effort chip when the model offers reasoning levels', () => {
      mockUseModels.mockReturnValue(reasoningCatalog);
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
        />
      );
      expect(screen.getByTestId(TEST_IDS.effortChip)).toHaveAccessibleName(
        'Reasoning effort: Auto'
      );
    });

    it('places the effort chip in the Effort slot, last in the left group', () => {
      mockUseModels.mockReturnValue(reasoningCatalog);
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
        />
      );
      const chip = screen.getByTestId(TEST_IDS.effortChip);
      const effortSlot = document.querySelector('[data-slot="composer-effort"]');
      expect(effortSlot).toContainElement(chip);
      expect(document.querySelector('[data-slot="composer-left"]')?.lastElementChild).toBe(
        effortSlot
      );
    });

    it("opens the effort menu from the mode menu's Effort row on a composer under 20rem", async () => {
      vi.useRealTimers();
      // The composer draws no box here, so it measures 0px: under 20rem at a 16px root.
      const root = document.documentElement;
      root.style.fontSize = '16px';
      try {
        mockUseModels.mockReturnValue(reasoningCatalog);
        const user = userEvent.setup();
        renderWithProviders(
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            isAuthenticated
            activeModality="text"
            onSelectModality={vi.fn()}
          />
        );
        await user.click(screen.getByRole('button', { name: 'Change mode' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Effort: Auto' }));

        expect(await screen.findByRole('menu', { name: /^Reasoning effort/u })).toBeInTheDocument();
      } finally {
        root.style.fontSize = '';
      }
    });

    it('returns focus to the "+" once the effort menu opened from its row closes', async () => {
      vi.useRealTimers();
      // The composer draws no box here, so it measures 0px: under 20rem at a 16px root.
      const root = document.documentElement;
      root.style.fontSize = '16px';
      try {
        mockUseModels.mockReturnValue(reasoningCatalog);
        const user = userEvent.setup();
        renderWithProviders(
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            isAuthenticated
            activeModality="text"
            onSelectModality={vi.fn()}
          />
        );
        await user.click(screen.getByRole('button', { name: 'Change mode' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Effort: Auto' }));
        await screen.findByRole('menu', { name: /^Reasoning effort/u });

        await user.keyboard('{Escape}');

        await waitFor(() => {
          expect(screen.getByRole('button', { name: 'Change mode' })).toHaveFocus();
        });
      } finally {
        root.style.fontSize = '';
      }
    });

    it('renders no effort chip when the selected model has no reasoning support', () => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'test-model',
              name: 'Test Model',
              provider: 'Fictional',
              description: 'Text generation model.',
              modality: 'text',
              contextLength: 8192,
              supportedParameters: [],
              pricing: { inputPerToken: '10000', outputPerToken: '30000' },
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
        />
      );
      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
    });

    it('forwards the effective reasoning selection into usePromptBudget', () => {
      mockUseModels.mockReturnValue(reasoningCatalog);
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
        />
      );
      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningEffort: 'high' })
      );
    });

    it('omits reasoningEffort from the budget input when nothing is engaged', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
        />
      );
      const lastCall = mockUsePromptBudget.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(lastCall).not.toHaveProperty('reasoningEffort');
    });
  });

  describe('the composer IS the media surface (the premise behind the text-arm gate)', () => {
    /**
     * SCOPE, stated exactly: this file mocks `use-prompt-budget` wholesale, so
     * the real `sendRefusalOf` never runs here and NOTHING in this describe can
     * detect a change to it. These tests pin only what the COMPOSER decides
     * from `activeModality` and from the verdict it is handed.
     *
     * The text-arm guard itself is pinned where it executes —
     * `use-prompt-budget.test.ts`, which mocks `useTurnOptions` beneath the real
     * hook, so removing `if (!isTextTurn) return undefined` reddens it. That is
     * the test to change if the rule changes.
     *
     * What these add is the PREMISE that made the guard's absence a user-facing
     * defect rather than a cosmetic one: this component is the surface that
     * sends image and video generations, so a text-arm refusal reaching it
     * stopped media outright.
     */
    it('renders the media composer chrome in image mode', () => {
      renderWithProviders(
        <PromptInput
          value="a cat"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
        />
      );

      // Both assertions turn on `activeModality`, which is the composer's OWN
      // input: `BottomRows` selects `ImageBottomRow` over `TextBottomRow`, and
      // only the text row carries the capacity meter. The same Send control
      // drives generation in either.
      //
      // Deliberately NOT asserted here: the absence of the search toggle. That
      // is `showSearch = searchProps !== undefined && …` — no modality term —
      // so it would be absent whatever the modality and could not fail for a
      // modality reason. `searchProps` omission is chat-layout's decision and
      // is pinned as such earlier in this file.
      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.capacityBar)).not.toBeInTheDocument();
    });

    it('disables Send in image mode when it IS handed a blocking verdict', () => {
      // The composer's wiring, not the fixture echoed back: a blocking verdict
      // must reach the media Send control exactly as it reaches the text one.
      // This is why a text-arm refusal leaking into media disabled generation.
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, hasBlockingError: true });

      renderWithProviders(
        <PromptInput
          value="a cat"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
        />
      );

      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
    });
  });

  describe('a blocked send always carries its notice (§Notices 7)', () => {
    it('renders the hold reason when the send is blocked by a run in flight', () => {
      // The disabled button alone is not a notice. A blocked send with no
      // explanation leaves the user to guess which input to change — and for a
      // hold there IS no input to change, only waiting.
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        sendRefusal: 'funds_held_by_run',
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(screen.getByText(/Wait for it to finish/)).toBeInTheDocument();
    });

    it('renders the LENGTH reason for a prompt-too-long refusal, not the hold reason', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        sendRefusal: 'prompt_too_long',
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(screen.getByText(/Shorten your message/)).toBeInTheDocument();
      expect(screen.queryByText(/Wait for it to finish/)).not.toBeInTheDocument();
    });

    it('renders exactly ONE blocking notice', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        sendRefusal: 'funds_held_by_run',
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      // One blocking notice, in the one notice surface the composer has.
      const blocking = screen.getAllByText(/Wait for it to finish/);
      expect(blocking).toHaveLength(1);
    });
  });

  describe('the send control explains a read the turn is still waiting on', () => {
    /**
     * A send held open only by a read still settling is the one disabled state
     * with no notice behind it, because there is no verdict yet to declare.
     * The button carries that state itself rather than the notice stack: a row
     * under the composer on every conversation open is noise on the one surface
     * every real refusal uses.
     */
    it('marks the send control busy while a read the turn needs is in flight', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: true,
        hasBlockingError: true,
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toHaveAttribute('aria-busy', 'true');
      expect(send).toHaveAccessibleName('Checking what you can send');
      expect(send).toBeDisabled();
    });

    it('shows a spinner in place of the send arrow while the funding read is in flight', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: true,
        hasBlockingError: true,
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send.querySelector('.animate-spin')).toBeInTheDocument();
      expect(send.querySelector('.lucide-arrow-up')).toBeNull();
    });

    it('adds nothing to the notices stack while the funding read is in flight', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: true,
        hasBlockingError: true,
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(screen.queryByTestId(TEST_IDS.budgetMessages)).not.toBeInTheDocument();
    });

    it('drops the busy affordance once the read comes back and the send may start', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toHaveAttribute('aria-busy', 'false');
      expect(send).toHaveAccessibleName('Send');
    });

    it('never claims the QUEUE control is busy, because a settling read does not close it', () => {
      // While a reply streams, this control queues rather than sends, and the
      // queue gate deliberately stays OPEN through a settling read — that window
      // is what a queue is for. So the busy affordance would land on a control
      // the user can still press, and "busy" would be false about it.
      //
      // The enabled assertion below is the premise, not decoration: it is what
      // makes the aria-busy assertion mean "we declined to mark an ACTIONABLE
      // control busy" rather than "the control happened to be closed anyway".
      // Delete it and the test still passes while proving much less.
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: true,
        hasBlockingError: true,
        hasPersistentBlockingError: false,
      });

      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={vi.fn()}
        />
      );

      const queue = screen.getByTestId(TEST_IDS.sendButton);
      expect(queue).not.toBeDisabled();
      expect(queue).toHaveAttribute('aria-busy', 'false');
      expect(queue).toHaveAccessibleName('Queue');
    });

    it('leaves an EXHAUSTED read its refusal, never the busy affordance', () => {
      // The state this affordance shipped broken in. `isBillingLoading` is TRUE
      // here and that is not a race: both flags are functions of one funding
      // status read from one cache entry, so an exhausted read raises the
      // refusal AND the loading term together, permanently. A 404 for a caller
      // with no purchased wallet never resolves, so a button gated on the
      // loading term alone spins forever under a notice saying the balance
      // could not be checked.
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: true,
        hasBlockingError: true,
        sendRefusal: 'send_check_unavailable',
        notifications: [
          {
            id: 'send_check_unavailable',
            type: 'error',
            message: 'We could not check your balance.',
          },
        ],
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toHaveAttribute('aria-busy', 'false');
      expect(send).toHaveAccessibleName('Cannot send');
      // The refusal's own notice is present, and is the only blocking
      // declaration the composer makes about this send.
      expect(screen.getByTestId(TEST_IDS.budgetMessages)).toBeInTheDocument();
    });

    it('leaves a REFUSED send its plain label, never the busy one', () => {
      // A later change is likeliest to break this by conditioning the busy
      // label on the disabled state instead of on the settling read: a refusal
      // already carries its notice, and a second blocking declaration on the
      // button would double it (§Notices 7).
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isBillingLoading: false,
        hasBlockingError: true,
        sendRefusal: 'funds_held_by_run',
        notifications: [
          { id: 'funds_held_by_run', type: 'error', message: 'Wait for it to finish.' },
        ],
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toHaveAttribute('aria-busy', 'false');
      expect(send).toHaveAccessibleName('Cannot send');
    });
  });

  describe('the send control is actionable only when activating it sends', () => {
    /**
     * The funding answer and the blocking flags are independent fields of the
     * budget result, and only the answer names a wallet. A control gated on the
     * flags alone stays live in every state that publishes no wallet without
     * raising one — a media turn the catalog carries no rate for reaches it —
     * and the press is then swallowed with nothing said and the text still in
     * the box.
     */
    const noWalletNamed: Partial<PromptBudgetResult> = {
      fundingSource: 'no_verdict',
      estimatedCostNanoUsd: undefined,
      hasBlockingError: false,
      hasPersistentBlockingError: false,
      isBillingLoading: false,
      sendRefusal: undefined,
    };

    it('refuses the send when the funding answer names no wallet and no block is raised', () => {
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...noWalletNamed });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toBeDisabled();
      fireEvent.click(send);
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('refuses the Enter that the same absent wallet would have swallowed', () => {
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...noWalletNamed });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('refuses the send while the funding read is still outstanding, and says so', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'no_verdict',
        isBillingLoading: true,
        hasBlockingError: true,
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toBeDisabled();
      expect(send).toHaveAccessibleName('Checking what you can send');
    });

    it('refuses the send when the funding read failed', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'no_verdict',
        isBillingLoading: true,
        hasBlockingError: true,
        sendRefusal: 'send_check_unavailable',
        notifications: [
          {
            id: 'send_check_unavailable',
            type: 'error',
            message: 'We could not check your balance.',
          },
        ],
      });

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(screen.getByTestId(TEST_IDS.sendButton)).toBeDisabled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('sends on the wallet the funding read landed on', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toBeEnabled();
      fireEvent.click(send);
      expect(mockOnSubmit).toHaveBeenCalledWith('personal_balance');
    });

    it('leaves the AI-off post actionable while the funding answer names no wallet', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...noWalletNamed });

      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'AI replies to this message', pressed: true })
      );
      const send = screen.getByTestId(TEST_IDS.sendButton);
      expect(send).toBeEnabled();
      await user.click(send);
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('leaves the queue actionable while the funding answer names no wallet', () => {
      // Queueing defers a send rather than making one, so it waits on no
      // funding read: closing it here would shut the affordance in the only
      // window it exists for.
      const mockOnQueue = vi.fn();
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, ...noWalletNamed });

      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={mockOnQueue}
        />
      );

      const queue = screen.getByTestId(TEST_IDS.sendButton);
      expect(queue).toBeEnabled();
      fireEvent.click(queue);
      expect(mockOnQueue).toHaveBeenCalledWith('Hello');
    });
  });

  describe('no text-modality surface renders a pre-send cost figure', () => {
    /**
     * §Affordability 11: an estimate is surfaced only where a generation is
     * priced per unit — media shows one before generating; a text turn displays
     * its FINAL cost at completion and never an estimate beforehand.
     *
     * The composer holds `estimatedCostNanoUsd` as a decision value, so this
     * pins the rendering rather than the intent: no currency reaches the DOM
     * however the budget is configured.
     */
    it('renders no currency anywhere in the composer, even with a priced estimate', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        estimatedCostNanoUsd: 123_456_789n,
      });

      const { container } = renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      // Any of these appearing would be a pre-send figure on a text turn.
      expect(container.textContent).not.toMatch(/\$/);
      expect(container.textContent).not.toMatch(/\d+\.\d{2,}/);
      expect(container.textContent).not.toMatch(/¢/);
    });
  });
  describe('the composer publishes whether its affordability producer has resolved', () => {
    /**
     * The composer's outermost element, reached by walking up from the textarea
     * rather than taking the container's first child — the provider stack this
     * harness mounts renders its own nodes alongside the composer.
     */
    function composerRoot(container: HTMLElement): HTMLElement {
      let node = screen.getByTestId(TEST_IDS.promptInput).parentElement;
      while (node !== null && node.parentElement !== container) node = node.parentElement;
      if (node === null) throw new Error('the composer textarea has no root beneath the container');
      return node;
    }

    it('publishes false while the affordability producer is still pending', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isAffordabilitySettled: false,
      });

      const { container } = renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(composerRoot(container)).toHaveAttribute(TEST_SIGNALS.affordabilitySettled, 'false');
    });

    it('publishes true once the affordability producer has resolved', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isAffordabilitySettled: true,
      });

      const { container } = renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(composerRoot(container)).toHaveAttribute(TEST_SIGNALS.affordabilitySettled, 'true');
    });

    it("publishes the producer's own answer rather than the send control's busy state", () => {
      // The two are different facts and the send affordance says so itself: a
      // resolved producer that named no wallet still leaves the control busy,
      // and a spec that read the control would wait forever on a read that is
      // already over.
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        isAffordabilitySettled: true,
        isBillingLoading: true,
      });

      const { container } = renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(composerRoot(container)).toHaveAttribute(TEST_SIGNALS.affordabilitySettled, 'true');
    });
  });

  describe('the media greying verdict reaches the generation controls', () => {
    /** The produced pair, with `resolution` `1080p` refused for money. */
    function mediaPairRefusing1080p(): PromptBudgetResult['mediaOptions'] {
      const options = [
        { optionId: '720p', label: '720p', availability: { available: true } },
        {
          optionId: '1080p',
          label: '1080p',
          availability: { available: false, reason: 'insufficient_funds' },
        },
      ] as const;
      const set = {
        sendable: true,
        all: [],
        turnDimensions: [{ dimensionId: 'resolution', options }],
      };
      return { affordable: set, admissible: set } as unknown as PromptBudgetResult['mediaOptions'];
    }

    function composeVideoTurn(): void {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/veo-3.1',
              name: 'Veo 3.1',
              provider: 'Google',
              description: 'Video generation model.',
              modality: 'video',
              contextLength: 0,
              supportedParameters: [],
              pricing: {
                perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
                dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
              },
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
    }

    it('greys the resolution the payer cannot afford, with its reason', () => {
      composeVideoTurn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        mediaOptions: mediaPairRefusing1080p(),
      });

      renderWithProviders(
        <PromptInput
          value="a video prompt"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="video"
        />
      );

      expect(screen.getByRole('button', { name: '1080p' })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
      expect(screen.getByText(noticeText('insufficient_funds'))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '720p' })).not.toHaveAttribute('aria-disabled');
    });

    it('greys nothing while the composer holds no media verdict', () => {
      composeVideoTurn();
      mockUsePromptBudget.mockReturnValue({ ...defaultBudget, mediaOptions: undefined });

      renderWithProviders(
        <PromptInput
          value="a video prompt"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="video"
        />
      );

      expect(screen.getByRole('button', { name: '1080p' })).not.toHaveAttribute('aria-disabled');
    });

    // The two states below hand the panel the SAME absent verdict, and the
    // refusal is the only thing that separates them. A composer that stopped
    // forwarding it would leave the failed read looking like a settling one and
    // go on offering options nothing has priced.
    it('hands the panel the refusal when the funding read failed', () => {
      composeVideoTurn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        mediaOptions: undefined,
        sendRefusal: 'send_check_unavailable',
      });

      renderWithProviders(
        <PromptInput
          value="a video prompt"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="video"
        />
      );

      expect(screen.queryByRole('button', { name: '1080p' })).not.toBeInTheDocument();
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    });

    it('announces an unread funding figure once, out of the notice list', () => {
      composeVideoTurn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        mediaOptions: undefined,
        sendRefusal: 'send_check_unavailable',
      });

      renderWithProviders(
        <PromptInput
          value="a video prompt"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="video"
        />
      );

      // WHICH surface says it, not how many regions exist: a bare count also
      // passes for a row that kept the sentence after the list lost it, which
      // is the same number and the opposite outcome.
      const announcements = [
        ...screen.queryAllByRole('status'),
        ...screen.queryAllByRole('alert'),
      ].filter((region) => region.textContent === noticeText('send_check_unavailable'));
      expect(announcements).toHaveLength(1);
      expect(screen.getByTestId(TEST_IDS.budgetMessages)).toContainElement(
        announcements[0] ?? null
      );
    });

    it('leaves the controls up while the funding read is still in flight', () => {
      composeVideoTurn();
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        mediaOptions: undefined,
        isBillingLoading: true,
      });

      renderWithProviders(
        <PromptInput
          value="a video prompt"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="video"
        />
      );

      expect(screen.getByRole('button', { name: '1080p' })).toBeInTheDocument();
      expect(screen.queryByText(noticeText('send_check_unavailable'))).not.toBeInTheDocument();
    });
  });

  describe('sentence-completion hint', () => {
    const TYPED = 'the quick brown fox';
    const RAW_COMPLETION = ' jumps over the lazy';
    const SHAPED_COMPLETION = ' jumps over the';

    function immediatePredictor(): PromptPredictor {
      return {
        predict: (_text, _signal, onCompletion) => {
          onCompletion(RAW_COMPLETION);
          return Promise.resolve({
            completion: RAW_COMPLETION,
            alternatives: [' leaps over the tall'],
          });
        },
      };
    }

    function ControlledComposer({
      predictor,
      onPredictionCandidatesChange,
      disabled = false,
    }: Readonly<{
      predictor?: PromptPredictor | undefined;
      onPredictionCandidatesChange?: ((candidates: readonly string[]) => void) | undefined;
      disabled?: boolean;
    }>): React.JSX.Element {
      const [value, setValue] = React.useState('');
      return (
        <PromptInput
          value={value}
          onChange={(next) => {
            mockOnChange(next);
            setValue(next);
          }}
          onSubmit={mockOnSubmit}
          disabled={disabled}
          {...(predictor !== undefined && { predictor })}
          {...(onPredictionCandidatesChange !== undefined && { onPredictionCandidatesChange })}
        />
      );
    }

    function hint(): HTMLElement | null {
      return document.querySelector('[data-slot="prediction-text"]');
    }

    function sizingReplica(): HTMLElement | null {
      return document.querySelector('[data-slot="textarea-sizing-replica"]');
    }

    async function typeAndSettle(text: string): Promise<void> {
      fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), { target: { value: text } });
      await act(async () => {
        vi.advanceTimersByTime(PREDICTION_DEBOUNCE_MS);
        await Promise.resolve();
      });
    }

    it('renders no hint and mounts no overlay when the caller supplies no predictor', async () => {
      renderWithProviders(<ControlledComposer />);
      await typeAndSettle(TYPED);
      expect(document.querySelector('[data-slot="prediction-overlay"]')).toBeNull();
      expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(TYPED);
    });

    it('renders the predicted continuation immediately after the typed text', async () => {
      renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
      await typeAndSettle(TYPED);
      expect(hint()).toHaveTextContent(SHAPED_COMPLETION.trim());
      expect(document.querySelector('[data-slot="prediction-overlay"]')).toHaveTextContent(
        `${TYPED}${SHAPED_COMPLETION}`.trim()
      );
    });

    it('sizes the composer for the typed text plus the shown completion', async () => {
      renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
      await typeAndSettle(TYPED);
      expect(sizingReplica()?.textContent).toBe(`${TYPED}${SHAPED_COMPLETION} `);
    });

    it('sizes the composer for the typed text alone once the hint is dismissed', async () => {
      renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
      await typeAndSettle(TYPED);
      fireEvent.keyDown(screen.getByTestId(TEST_IDS.promptInput), { key: 'Escape' });
      expect(sizingReplica()?.textContent).toBe(`${TYPED} `);
    });

    it('sizes the composer for the whole accepted value, unchanged by acceptance', async () => {
      renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
      await typeAndSettle(TYPED);
      const beforeAccept = sizingReplica()?.textContent;
      fireEvent.pointerDown(hint()!);
      expect(sizingReplica()?.textContent).toBe(beforeAccept);
      expect(sizingReplica()?.textContent).toBe(`${TYPED}${SHAPED_COMPLETION} `);
    });

    it('accepting by pointer sets the composer to the whole accepted value', async () => {
      renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
      await typeAndSettle(TYPED);
      fireEvent.pointerDown(hint()!);
      expect(mockOnChange).toHaveBeenLastCalledWith(`${TYPED}${SHAPED_COMPLETION}`);
      expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(`${TYPED}${SHAPED_COMPLETION}`);
    });

    it('hands the rival continuations to the consumer that renders the list, never the inline one', async () => {
      const onPredictionCandidatesChange = vi.fn<(candidates: readonly string[]) => void>();
      renderWithProviders(
        <ControlledComposer
          predictor={immediatePredictor()}
          onPredictionCandidatesChange={onPredictionCandidatesChange}
        />
      );
      await typeAndSettle(TYPED);
      expect(onPredictionCandidatesChange).toHaveBeenLastCalledWith([' leaps over the']);
    });

    it('withholds the hint while an input method is composing', async () => {
      renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
      await typeAndSettle(TYPED);
      expect(hint()).not.toBeNull();
      fireEvent.compositionStart(screen.getByTestId(TEST_IDS.promptInput));
      expect(hint()).toBeNull();
      fireEvent.compositionEnd(screen.getByTestId(TEST_IDS.promptInput));
      expect(hint()).not.toBeNull();
    });

    it('withdraws a hint that is already on screen when the composer is disabled', async () => {
      const { rerender } = renderWithProviders(
        <ControlledComposer predictor={immediatePredictor()} />
      );
      await typeAndSettle(TYPED);
      expect(hint()).not.toBeNull();
      rerender(<ControlledComposer predictor={immediatePredictor()} disabled />);
      expect(hint()).toBeNull();
      expect(document.querySelector('[data-slot="prediction-overlay"]')).toBeNull();
    });

    it('takes no text from a hint that was on screen when the composer was disabled', async () => {
      const { rerender } = renderWithProviders(
        <ControlledComposer predictor={immediatePredictor()} />
      );
      await typeAndSettle(TYPED);
      const staleHint = hint();
      rerender(<ControlledComposer predictor={immediatePredictor()} disabled />);
      fireEvent.pointerDown(staleHint!);
      expect(mockOnChange).not.toHaveBeenCalledWith(`${TYPED}${SHAPED_COMPLETION}`);
      expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(TYPED);
    });

    it('shows the held hint again once the composer stops being disabled', async () => {
      const { rerender } = renderWithProviders(
        <ControlledComposer predictor={immediatePredictor()} />
      );
      await typeAndSettle(TYPED);
      rerender(<ControlledComposer predictor={immediatePredictor()} disabled />);
      rerender(<ControlledComposer predictor={immediatePredictor()} />);
      expect(hint()).toHaveTextContent(SHAPED_COMPLETION.trim());
    });

    describe('keyboard gestures', () => {
      const ACCEPTED = `${TYPED}${SHAPED_COMPLETION}`;

      function press(key: string, init: Partial<KeyboardEventInit> = {}): boolean {
        return fireEvent.keyDown(screen.getByTestId(TEST_IDS.promptInput), { key, ...init });
      }

      it('takes the prediction into the composer on Tab', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        expect(press('Tab')).toBe(false);
        expect(mockOnChange).toHaveBeenLastCalledWith(ACCEPTED);
        expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(ACCEPTED);
      });

      it('takes the prediction into the composer on ArrowRight', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        expect(press('ArrowRight')).toBe(false);
        expect(mockOnChange).toHaveBeenLastCalledWith(ACCEPTED);
      });

      it('leaves Tab to move focus while a prediction is still being computed', () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), { target: { value: TYPED } });
        expect(hint()).toBeNull();
        expect(press('Tab')).toBe(true);
        expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
      });

      it('leaves Tab to move focus once the composer is disabled', async () => {
        const { rerender } = renderWithProviders(
          <ControlledComposer predictor={immediatePredictor()} />
        );
        await typeAndSettle(TYPED);
        rerender(<ControlledComposer predictor={immediatePredictor()} disabled />);
        expect(press('Tab')).toBe(true);
        expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
      });

      it('leaves Tab to move focus when the caller supplies no predictor', async () => {
        renderWithProviders(<ControlledComposer />);
        await typeAndSettle(TYPED);
        expect(press('Tab')).toBe(true);
        expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(TYPED);
      });

      it('leaves ArrowRight to move the caret when no prediction is rendered', async () => {
        renderWithProviders(<ControlledComposer />);
        await typeAndSettle(TYPED);
        expect(press('ArrowRight')).toBe(true);
        expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(TYPED);
      });

      it('leaves Shift+Tab to move focus backwards while a prediction renders', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        expect(press('Tab', { shiftKey: true })).toBe(true);
        expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
      });

      it.each(['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const)(
        'leaves a modified ArrowRight (%s) alone while a prediction renders',
        async (modifier) => {
          renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
          await typeAndSettle(TYPED);
          expect(press('ArrowRight', { [modifier]: true })).toBe(true);
          expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
        }
      );

      it('dismisses the rendered prediction on Escape', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        expect(press('Escape')).toBe(false);
        expect(hint()).toBeNull();
        expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(TYPED);
      });

      it('leaves Escape alone when no prediction is rendered', () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), { target: { value: TYPED } });
        expect(press('Escape')).toBe(true);
      });

      it('submits exactly the typed value on Enter while a prediction renders', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        press('Enter');
        expect(mockOnSubmit).toHaveBeenCalled();
        expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
        expect(screen.getByTestId(TEST_IDS.promptInput)).toHaveValue(TYPED);
      });

      it('leaves Tab alone once the caret has left the end, before the composer re-renders', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        const textarea = screen.getByTestId<HTMLTextAreaElement>(TEST_IDS.promptInput);
        textarea.selectionStart = 4;
        textarea.selectionEnd = 4;
        expect(hint()).not.toBeNull();
        expect(press('Tab')).toBe(true);
        expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
      });

      it('leaves Tab alone when the caret is back at the end but no hint is on screen', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        const textarea = screen.getByTestId<HTMLTextAreaElement>(TEST_IDS.promptInput);
        textarea.selectionStart = 4;
        textarea.selectionEnd = 4;
        fireEvent.select(textarea);
        expect(hint()).toBeNull();

        // The caret returns without an event, so the fresh read the handler makes
        // says nothing is withheld while the committed state the hint was drawn
        // from still does. Tab must reach the browser: no hint is on screen, and
        // swallowing it here is the keyboard trap WCAG 2.1.2 forbids.
        textarea.selectionStart = TYPED.length;
        textarea.selectionEnd = TYPED.length;
        expect(press('Tab')).toBe(true);
        expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
        expect(textarea).toHaveValue(TYPED);
      });

      it.each(['Tab', 'ArrowRight', 'Escape'])(
        'leaves %s to the input method while it is composing',
        async (key) => {
          renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
          await typeAndSettle(TYPED);
          expect(press(key, { isComposing: true })).toBe(true);
          expect(mockOnChange).not.toHaveBeenCalledWith(ACCEPTED);
          expect(hint()).not.toBeNull();
        }
      );
    });

    describe('suggestion list keyboard navigation', () => {
      function twoAlternativePredictor(): PromptPredictor {
        return {
          predict: (_text, _signal, onCompletion) => {
            onCompletion(RAW_COMPLETION);
            return Promise.resolve({
              completion: RAW_COMPLETION,
              alternatives: [' leaps over the tall', ' sleeps under the tall'],
            });
          },
        };
      }

      function press(key: string, init: Partial<KeyboardEventInit> = {}): boolean {
        return fireEvent.keyDown(screen.getByTestId(TEST_IDS.promptInput), { key, ...init });
      }

      function textarea(): HTMLTextAreaElement {
        return screen.getByTestId<HTMLTextAreaElement>(TEST_IDS.promptInput);
      }

      function activeDescendant(): string | null {
        return textarea().getAttribute('aria-activedescendant');
      }

      async function renderWithTwoAlternatives(): Promise<void> {
        renderWithProviders(
          <ControlledComposer
            predictor={twoAlternativePredictor()}
            onPredictionCandidatesChange={vi.fn()}
          />
        );
        await typeAndSettle(TYPED);
        // Keyboard navigation of the suggestion list is only reachable while the
        // user has focus in the composer; `typeAndSettle` only fires `change`,
        // so establish focus the way real typing would.
        textarea().focus();
      }

      it('moves the virtual focus to the first row on ArrowDown from the end of the value', async () => {
        await renderWithTwoAlternatives();
        expect(activeDescendant()).toBeNull();
        expect(press('ArrowDown')).toBe(false);
        expect(activeDescendant()).toBe(suggestionRowId(0));
      });

      it('walks down one row per ArrowDown', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        expect(press('ArrowDown')).toBe(false);
        expect(activeDescendant()).toBe(suggestionRowId(1));
      });

      it('stops at the last row rather than wrapping', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        press('ArrowDown');
        expect(press('ArrowDown')).toBe(false);
        expect(activeDescendant()).toBe(suggestionRowId(1));
      });

      it('walks back up one row per ArrowUp', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        press('ArrowDown');
        expect(press('ArrowUp')).toBe(false);
        expect(activeDescendant()).toBe(suggestionRowId(0));
      });

      it('returns the caret to the end of the prompt on ArrowUp from the top row', async () => {
        await renderWithTwoAlternatives();
        const before = {
          start: textarea().selectionStart,
          end: textarea().selectionEnd,
        };
        press('ArrowDown');
        expect(activeDescendant()).toBe(suggestionRowId(0));
        expect(document.activeElement).toBe(textarea());
        expect(press('ArrowUp')).toBe(false);
        expect(activeDescendant()).toBeNull();
        // DOM focus and the caret never left the textarea during the walk, so
        // leaving the list is already "back in the prompt" — nothing here
        // moves the caret to reproduce that.
        expect(document.activeElement).toBe(textarea());
        expect(textarea().selectionStart).toBe(before.start);
        expect(textarea().selectionEnd).toBe(before.end);
      });

      it('leaves ArrowDown to the composer when caret is not at the end of the value', async () => {
        await renderWithTwoAlternatives();
        const box = textarea();
        box.selectionStart = 4;
        box.selectionEnd = 4;
        fireEvent.select(box);
        expect(press('ArrowDown')).toBe(true);
        expect(activeDescendant()).toBeNull();
      });

      it('leaves ArrowDown to the composer when a selection range is active', async () => {
        await renderWithTwoAlternatives();
        const box = textarea();
        box.selectionStart = 4;
        box.selectionEnd = 8;
        fireEvent.select(box);
        expect(press('ArrowDown')).toBe(true);
        expect(activeDescendant()).toBeNull();
      });

      it('leaves ArrowDown alone with no wired candidate consumer, even once a hint is on screen', async () => {
        renderWithProviders(<ControlledComposer predictor={twoAlternativePredictor()} />);
        await typeAndSettle(TYPED);
        expect(press('ArrowDown')).toBe(true);
        expect(activeDescendant()).toBeNull();
      });

      it('applies the active row on Tab', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        expect(press('Tab')).toBe(false);
        expect(mockOnChange).toHaveBeenLastCalledWith(`${TYPED} leaps over the`);
        expect(textarea()).toHaveValue(`${TYPED} leaps over the`);
        expect(activeDescendant()).toBeNull();
      });

      it('applies the active row on ArrowRight', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        press('ArrowDown');
        expect(press('ArrowRight')).toBe(false);
        expect(mockOnChange).toHaveBeenLastCalledWith(`${TYPED} sleeps under the`);
      });

      it('applies the active row on Enter instead of submitting', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        expect(press('Enter')).toBe(false);
        expect(mockOnChange).toHaveBeenLastCalledWith(`${TYPED} leaps over the`);
        expect(mockOnSubmit).not.toHaveBeenCalled();
      });

      it('submits on Enter when no row is active, prediction rendering alongside it', async () => {
        await renderWithTwoAlternatives();
        expect(activeDescendant()).toBeNull();
        press('Enter');
        expect(mockOnSubmit).toHaveBeenCalled();
        expect(mockOnChange).not.toHaveBeenCalledWith(`${TYPED} leaps over the`);
      });

      it('leaves a modified Tab alone while a row is active', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        expect(press('Tab', { shiftKey: true })).toBe(true);
        expect(mockOnChange).not.toHaveBeenCalledWith(`${TYPED} leaps over the`);
      });

      it('clears the active row on Escape and lets the composer submit on the next Enter', async () => {
        await renderWithTwoAlternatives();
        press('ArrowDown');
        expect(activeDescendant()).toBe(suggestionRowId(0));
        expect(press('Escape')).toBe(false);
        expect(activeDescendant()).toBeNull();
        press('Enter');
        expect(mockOnSubmit).toHaveBeenCalled();
      });
    });

    describe('the screen-reader announcement', () => {
      const ANNOUNCED = 'Suggested continuation: jumps over the. Press Tab to accept.';

      function region(): HTMLElement | null {
        return document.querySelector('[data-slot="prediction-announcement"]');
      }

      function moveCaret(to: number): void {
        const textarea = screen.getByTestId<HTMLTextAreaElement>(TEST_IDS.promptInput);
        textarea.selectionStart = to;
        textarea.selectionEnd = to;
        fireEvent.select(textarea);
      }

      it('speaks the suggestion once the debounce has settled', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        expect(region()).toHaveTextContent(ANNOUNCED);
      });

      it('stays silent while the typing is still settling', () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        fireEvent.change(screen.getByTestId(TEST_IDS.promptInput), { target: { value: TYPED } });
        expect(region()).toBeEmptyDOMElement();
      });

      it('clears the announcement while the prediction is withheld', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);
        expect(region()).toHaveTextContent(ANNOUNCED);

        moveCaret(4);

        expect(hint()).toBeNull();
        expect(region()).toBeEmptyDOMElement();
      });

      it('re-announces the suggestion once it returns unchanged after being withheld', async () => {
        renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
        await typeAndSettle(TYPED);

        moveCaret(4);
        expect(hint()).toBeNull();
        expect(region()).toBeEmptyDOMElement();

        moveCaret(TYPED.length);
        expect(hint()).not.toBeNull();
        expect(region()).toHaveTextContent(ANNOUNCED);
      });

      it('clears once a font swap reflows the completion past the composer, not merely the overlay', async () => {
        let resolveReady: () => void = () => {};
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        Object.defineProperty(document, 'fonts', {
          configurable: true,
          value: { ready },
        });
        try {
          renderWithProviders(<ControlledComposer predictor={immediatePredictor()} />);
          await typeAndSettle(TYPED);
          expect(region()).toHaveTextContent(ANNOUNCED);

          // The composer's own box is unaffected; only the mirror measuring
          // typed text plus the completion grows once the real face swaps in.
          const composer = screen.getByTestId<HTMLTextAreaElement>(TEST_IDS.promptInput);
          Object.defineProperty(composer, 'scrollHeight', { value: 40, configurable: true });
          Object.defineProperty(composer, 'clientHeight', { value: 40, configurable: true });
          const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
          Object.defineProperty(Element.prototype, 'scrollHeight', {
            configurable: true,
            get: () => 200,
          });
          try {
            await act(async () => {
              resolveReady();
              await Promise.resolve();
            });
            expect(hint()).toBeNull();
            expect(region()).toBeEmptyDOMElement();
          } finally {
            if (original) Object.defineProperty(Element.prototype, 'scrollHeight', original);
          }
        } finally {
          Reflect.deleteProperty(document, 'fonts');
        }
      });

      it('speaks the next suggestion when a different one arrives', async () => {
        let completion = RAW_COMPLETION;
        renderWithProviders(
          <ControlledComposer
            predictor={{
              predict: (_text, _signal, onCompletion) => {
                onCompletion(completion);
                return Promise.resolve({ completion, alternatives: [] });
              },
            }}
          />
        );
        await typeAndSettle(TYPED);
        expect(region()).toHaveTextContent(ANNOUNCED);
        completion = ' sprints past the lazy';
        await typeAndSettle(`${TYPED} today`);
        expect(region()).toHaveTextContent(
          'Suggested continuation: sprints past the. Press Tab to accept.'
        );
      });

      it('mounts no live region when the caller supplies no predictor', async () => {
        renderWithProviders(<ControlledComposer />);
        await typeAndSettle(TYPED);
        expect(region()).toBeNull();
      });
    });
  });
});

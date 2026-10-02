import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { ChatWelcome } from '@/components/chat/page/chat-welcome';
import type { ChatModality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';

/**
 * Isolated harness that mocks ChatWelcome's heavy children as prop-capturers so
 * the page-level callbacks (modality switch, model select/remove, typing
 * complete) can be invoked directly and their store effects asserted — the real
 * model-selector modal is too heavy to drive reliably from this page.
 */
// Capture child props via vi.fn calls (a function call is allowed inside a
// component render, unlike a module-scope reassignment).
const headerSpy = vi.fn<(props: Record<string, unknown>) => void>();
const chipSpy = vi.fn<(props: Record<string, unknown>) => void>();
const promptSpy = vi.fn<(props: Record<string, unknown>) => void>();

function lastProps(spy: typeof headerSpy): Record<string, unknown> {
  return spy.mock.calls.at(-1)?.[0] ?? {};
}

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useVisualViewportHeight: () => 800,
    useIsMobile: () => false,
  };
});

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = Object.assign(
    (selector?: (s: ModelStoreStub) => unknown) =>
      selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current,
    {
      getState: () => modelStoreStubRef.current,
      setState: vi.fn(),
    }
  );
  return { ...actual, useModelStore: store };
});

vi.mock('@/hooks/models/use-resolve-default-model', () => ({
  useResolveDefaultModel: () => {},
}));

vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => ({ active: false, canUse: true, toggle: vi.fn() }),
}));

vi.mock('@/hooks/models/use-selected-model-capabilities', () => ({
  useSelectedModelCapabilities: () => ({ models: [], premiumIds: new Set<string>() }),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: () => ({ displayBalance: '5000000000' }),
}));

vi.mock('@/components/chat/layout/chat-header', () => ({
  ChatHeader: (props: Record<string, unknown>) => {
    headerSpy(props);
    return <div data-testid="chat-header" />;
  },
}));

vi.mock('@/components/chat/model-selector/model-selector-button', () => ({
  ModelSelectorButton: (props: Record<string, unknown>) => {
    chipSpy(props);
    return <div data-testid="model-selector-button" />;
  },
}));

vi.mock('@/components/chat/input/prompt-input', () => ({
  PromptInput: React.forwardRef(function MockPromptInput(
    props: Record<string, unknown>,
    _ref: React.ForwardedRef<unknown>
  ) {
    promptSpy(props);
    return (
      <div data-testid="prompt-input" data-search={props['searchProps'] ? 'yes' : 'no'}>
        {props['modelControl'] as React.ReactNode}
      </div>
    );
  }),
}));

vi.mock('@/components/chat/page/continue-list', () => ({
  ContinueList: () => null,
}));

vi.mock('@/components/chat/input/suggestion-chips', () => ({
  SuggestionChips: () => <div data-testid="suggestion-chips" />,
}));

vi.mock('@/components/chat/indicators/typing-animation', () => ({
  TypingAnimation: ({ text, onComplete }: { text: string; onComplete?: () => void }) => {
    // Fire in an effect (not during render) so the parent's showSubtitle update
    // — and the greeting's subtitle-reveal branch — are exercised.
    React.useEffect(() => {
      onComplete?.();
    }, [onComplete]);
    return <span>{text}</span>;
  },
}));

beforeEach(() => {
  headerSpy.mockClear();
  chipSpy.mockClear();
  promptSpy.mockClear();
  modelStoreStubRef.current = createModelStoreStub();
});

afterEach(() => {
  // The reset reaches components still mounted at this point: this file's
  // hook runs before the cleanup the test setup registers.
  act(() => {
    useA11yStore.getState().reset();
  });
});

describe('ChatWelcome callbacks', () => {
  it('switches the active modality through the prompt input handler', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    (lastProps(promptSpy)['onSelectModality'] as (m: ChatModality) => void)('image');

    expect(modelStoreStubRef.current.setActiveModality).toHaveBeenCalledWith('image');
  });

  it('commits a model selection through the composer chip handler', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    const entries: SelectedModelEntry[] = [{ id: 'gpt', name: 'GPT' }];
    (lastProps(chipSpy)['onSelect'] as (e: SelectedModelEntry[]) => void)(entries);

    expect(modelStoreStubRef.current.setSelectedModels).toHaveBeenCalledWith('text', entries);
  });

  it('gives the header no model to show', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    expect(lastProps(headerSpy)).not.toHaveProperty('selectedModels');
  });

  it('omits searchProps for a non-text modality', () => {
    modelStoreStubRef.current.activeModality = 'image';

    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    expect(lastProps(promptSpy)['searchProps']).toBeUndefined();
  });

  it('passes searchProps for the text modality', () => {
    render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    expect(lastProps(promptSpy)['searchProps']).toBeDefined();
  });
});

describe('ChatWelcome prediction suggestions', () => {
  const CANDIDATES = [' jumps over the', ' leaps over the', ' sleeps under the'];

  function emitCandidates(candidates: readonly string[]): void {
    act(() => {
      (lastProps(promptSpy)['onPredictionCandidatesChange'] as (c: readonly string[]) => void)(
        candidates
      );
    });
  }

  function typeIntoComposer(value: string): void {
    act(() => {
      (lastProps(promptSpy)['onChange'] as (next: string) => void)(value);
    });
  }

  function suggestionRows(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-slot="prediction-suggestion-row"]')];
  }

  function reservedRows(container: HTMLElement): HTMLElement[] {
    return [
      ...container.querySelectorAll<HTMLElement>('[data-slot="prediction-suggestion-reserve-row"]'),
    ];
  }

  it('offers nothing under the composer until a prediction arrives', () => {
    const { container } = render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    expect(suggestionRows(container)).toHaveLength(0);
  });

  it('lists the rival continuations under the composer once one arrives', () => {
    const { container } = render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    typeIntoComposer('the quick brown fox');
    emitCandidates(CANDIDATES);

    expect(
      suggestionRows(container).map(
        (row) =>
          row.querySelector('[data-slot="prediction-suggestion-completion"]')?.textContent ?? ''
      )
    ).toEqual(CANDIDATES);
  });

  it('adds the same height above the composer as the list adds below it', () => {
    const { container } = render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    typeIntoComposer('the quick brown fox');
    emitCandidates(CANDIDATES);

    // The column is vertically centred, so a list appearing under the composer
    // would pull the composer up by half its height. The reserved copy above
    // the greeting is what cancels that, and it can only cancel it while the
    // two are the same rows.
    expect(reservedRows(container).map((row) => row.textContent)).toEqual(
      suggestionRows(container).map((row) => row.textContent)
    );
  });

  it('reserves that height above the composer and lists it below, inside the centred column', () => {
    const { container } = render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    typeIntoComposer('the quick brown fox');
    emitCandidates(CANDIDATES);

    const centred = container.querySelector('.my-auto');
    const composer = container.querySelector('[data-testid="prompt-input"]')!;
    const reserved = reservedRows(container)[0]!;
    const listed = suggestionRows(container)[0]!;

    expect(centred).not.toBeNull();
    expect(centred!.contains(reserved)).toBe(true);
    expect(centred!.contains(listed)).toBe(true);
    expect(reserved.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(composer.compareDocumentPosition(listed) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('appends the chosen continuation to what the user has already typed', () => {
    const { container } = render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    typeIntoComposer('the quick brown fox');
    emitCandidates(CANDIDATES);
    fireEvent.click(suggestionRows(container)[1]!);

    expect(lastProps(promptSpy)['value']).toBe('the quick brown fox leaps over the');
  });

  it('passes the predictor to a live composer', () => {
    const predictor = { predict: vi.fn() };

    render(<ChatWelcome onSend={vi.fn()} isAuthenticated predictor={predictor} />);

    expect(lastProps(promptSpy)['predictor']).toBe(predictor);
  });

  it('withholds the predictor from a composer that cannot be typed into', () => {
    const predictor = { predict: vi.fn() };

    render(<ChatWelcome onSend={vi.fn()} isAuthenticated isLoading predictor={predictor} />);

    expect(lastProps(promptSpy)['predictor']).toBeUndefined();
  });

  it('takes the list away when the composer stops accepting input', () => {
    // Reduced motion so the collapse is the render rather than an exit
    // animation this environment cannot drive to completion.
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });
    const { container, rerender } = render(<ChatWelcome onSend={vi.fn()} isAuthenticated />);

    typeIntoComposer('the quick brown fox');
    emitCandidates(CANDIDATES);
    expect(suggestionRows(container)).toHaveLength(CANDIDATES.length);

    rerender(<ChatWelcome onSend={vi.fn()} isAuthenticated isLoading />);

    expect(suggestionRows(container)).toHaveLength(0);
    expect(reservedRows(container)).toHaveLength(0);
  });
});

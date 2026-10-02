import * as React from 'react';
import { cn, useVisualViewportHeight } from '@hushbox/ui';
import { useFormFactor } from '@hushbox/ui/platform';
import { TEST_IDS } from '@hushbox/shared';
import { getGreeting } from '@/lib/chat/greetings';
import { useModelStore, type SelectedModelEntry } from '@/stores/model';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useSelectedModelCapabilities } from '@/hooks/models/use-selected-model-capabilities';
import { useResolveDefaultModel } from '@/hooks/models/use-resolve-default-model';
import { getInspirationLabel, getPromptPlaceholder } from '@/lib/chat/modality-strings';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { ChatHeader } from '@/components/chat/layout/chat-header';
import { ModelSelectorButton } from '@/components/chat/model-selector/model-selector-button';
import { SuggestionChips } from '@/components/chat/input/suggestion-chips';
import { PromptInput } from '@/components/chat/input/prompt-input';
import {
  PredictionSuggestionList,
  PredictionSuggestionListSpacer,
} from '@/components/chat/input/prediction-suggestion-list';
import { WelcomeGreeting } from '@/components/chat/page/welcome-greeting';
import { ModelInfo } from '@/components/chat/page/model-info';
import { ContinueList } from '@/components/chat/page/continue-list';
import { StorageLine } from '@/components/chat/page/storage-line';
import type { FundingSource, ChatModality } from '@hushbox/shared';
import type { ChatSearchProps, PromptInputRef } from '@/components/chat/input/prompt-input';
import type { ModelSelectorGatingProps } from '@/components/chat/model-selector/model-selector-types';
import type { PromptPredictor } from '@/lib/prediction/predictor';

/** Stable identity, so a composer with nothing to offer never re-renders the list. */
const NO_PREDICTION_CANDIDATES: readonly string[] = [];

interface ChatWelcomeProps extends Pick<ModelSelectorGatingProps, 'onPremiumClick'> {
  onSend: (message: string, fundingSource: FundingSource) => void;
  isAuthenticated: boolean;
  isLoading?: boolean | undefined;
  className?: string | undefined;
  /**
   * Supplying a predictor turns on the sentence-completion hint and the
   * candidate list beneath the composer. Omit it and the page is exactly what
   * it is with the feature absent.
   */
  predictor?: PromptPredictor | undefined;
}

/**
 * Below 768 the stack's gaps and end spaces shrink with the screen's height, so the whole
 * stack fits a small phone's first screen; from 768 they are fixed.
 */
const STACK_CLASS =
  'flex flex-col gap-[var(--welcome-gap)] [--welcome-gap:clamp(0.5rem,3.2dvh_-_0.75rem,0.875rem)] pt-[clamp(0.75rem,4dvh_-_0.75rem,2rem)] pb-[clamp(0.75rem,5dvh_-_0.75rem,2.5rem)] md:pt-8 md:pb-10 md:[--welcome-gap:1.5rem]';

/**
 * The composer's focus tab rises 0.75rem above its field, so the composer never sits
 * closer than 0.875rem under the block above it, however far the stack's gap shrinks.
 */
const COMPOSER_CLASS = 'mt-[max(0px,0.875rem_-_var(--welcome-gap))]';

/** The new chat page: its blocks stacked in reading order and centred in the chat column. */
export function ChatWelcome({
  onSend,
  isAuthenticated,
  isLoading = false,
  className,
  onPremiumClick,
  predictor,
}: Readonly<ChatWelcomeProps>): React.JSX.Element {
  const [inputValue, setInputValue] = React.useState('');
  const [predictionCandidates, setPredictionCandidates] =
    React.useState<readonly string[]>(NO_PREDICTION_CANDIDATES);
  const [showSubtitle, setShowSubtitle] = React.useState(false);
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const viewportHeight = useVisualViewportHeight();
  const { band, pointer } = useFormFactor();
  // Focusing on a phone or a touch screen would raise the on-screen keyboard over the page.
  const autoFocuses = band === 'desktop' && pointer === 'fine';

  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const setActiveModality = useModelStore((state) => state.setActiveModality);
  // The welcome screen precedes any conversation, so the payer is the caller.
  useResolveDefaultModel(activeModality, null);
  const webSearch = useWebSearch();
  const selectModality = React.useCallback(
    (modality: ChatModality): void => {
      setActiveModality(modality);
    },
    [setActiveModality]
  );

  const { selectedModel, models, premiumIds } = useSelectedModelCapabilities();
  const searchProps: ChatSearchProps | undefined =
    activeModality === 'text'
      ? {
          webSearchEnabled: webSearch.active,
          canUseWebSearch: webSearch.canUse,
          onToggleWebSearch: webSearch.toggle,
        }
      : undefined;

  const handleModelSelect = React.useCallback((entries: SelectedModelEntry[]): void => {
    const { activeModality: current, setSelectedModels } = useModelStore.getState();
    setSelectedModels(current, entries);
  }, []);

  // Pick a stable greeting once auth state settles (prevents title flash on
  // auth changes).
  const greeting = React.useMemo(() => {
    if (isLoading) return null;
    return getGreeting(isAuthenticated);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isAuthenticated intentionally omitted: the greeting is computed once after loading settles; re-running on auth change would flash a new title
  }, [isLoading]);

  // Auto-focus the prompt input once the page is ready. Fires on the first ready render —
  // including a warm load that is ready immediately, where the prior
  // transition-only effect never focused. Guarded so a later re-render can't
  // steal focus the user has moved elsewhere.
  const hasFocusedRef = React.useRef(false);
  React.useEffect(() => {
    if (hasFocusedRef.current || isLoading || !autoFocuses) return;
    hasFocusedRef.current = true;
    promptInputRef.current?.focus();
  }, [isLoading, autoFocuses]);

  const handleSubmit = (fundingSource: FundingSource): void => {
    if (inputValue.trim()) {
      onSend(inputValue.trim(), fundingSource);
      setInputValue('');
    }
  };

  const handleSuggestionSelect = (prompt: string): void => {
    setInputValue(prompt);
  };

  // The hook drops its candidates when the composer freezes, but it publishes
  // that through a passive effect — a commit later than the render that froze
  // it. Clearing here in render is what keeps the list from being on screen and
  // clickable for that one commit.
  const suggestionCandidates = isLoading ? NO_PREDICTION_CANDIDATES : predictionCandidates;

  const handlePredictionSelect = React.useCallback((completion: string): void => {
    setInputValue((current) => current + completion);
  }, []);

  const handleTypingComplete = (): void => {
    setShowSubtitle(true);
  };

  return (
    <div
      data-testid={TEST_IDS.chatWelcome}
      data-loading={String(isLoading)}
      className={cn('flex flex-col overflow-hidden', className)}
      style={{ height: `${String(viewportHeight)}px` }}
    >
      <ChatHeader isAuthenticated={isAuthenticated} />

      {/* Auto margins centre the stack while it fits and let it scroll from its top when it
          does not, where centring by justification would push its top out of reach. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="my-auto">
          <ChatColumn>
            <div className={STACK_CLASS}>
              <div className="flex flex-col gap-[calc(var(--welcome-gap)/2)]">
                {/* At large text a one-word greeting is wider than a narrow column; it breaks
                    inside the word rather than run past the column's edges. */}
                <div className="wrap-anywhere">
                  {/* The list's height enters this centred stack twice, once on each
                      side of the composer. A centred stack that grows equally above and
                      below leaves everything between the two additions exactly where it
                      was, which is what holds the composer still while the list pushes
                      the blocks under it down. */}
                  <PredictionSuggestionListSpacer
                    typedText={inputValue}
                    candidates={suggestionCandidates}
                  />
                  <WelcomeGreeting
                    greeting={greeting}
                    showSubtitle={showSubtitle}
                    onTypingComplete={handleTypingComplete}
                  />
                </div>
                <ModelInfo
                  model={selectedModel}
                  selectionCount={selectedModels.length}
                  signedIn={isAuthenticated}
                />
              </div>

              <div className={COMPOSER_CLASS}>
                <PromptInput
                  ref={promptInputRef}
                  value={inputValue}
                  onChange={setInputValue}
                  onSubmit={handleSubmit}
                  placeholder={getPromptPlaceholder(activeModality, 'Ask me anything...')}
                  disabled={isLoading}
                  isAuthenticated={isAuthenticated}
                  activeModality={activeModality}
                  onSelectModality={selectModality}
                  {...(searchProps !== undefined && { searchProps })}
                  predictor={isLoading ? undefined : predictor}
                  onPredictionCandidatesChange={setPredictionCandidates}
                  modelControl={
                    <ModelSelectorButton
                      models={models}
                      selectedModels={selectedModels}
                      onSelect={handleModelSelect}
                      premiumIds={premiumIds}
                      isAuthenticated={isAuthenticated}
                      onPremiumClick={onPremiumClick}
                      activeModality={activeModality}
                    />
                  }
                />
                <PredictionSuggestionList
                  typedText={inputValue}
                  candidates={suggestionCandidates}
                  onSelect={handlePredictionSelect}
                />
              </div>

              {isAuthenticated ? <ContinueList /> : null}

              <div className="flex flex-col gap-3.5">
                <p className="text-muted-foreground text-center text-sm">
                  {getInspirationLabel(activeModality)}
                </p>
                <SuggestionChips onSelect={handleSuggestionSelect} showSurpriseMe />
              </div>

              <StorageLine signedIn={isAuthenticated} />
            </div>
          </ChatColumn>
        </div>
      </div>
    </div>
  );
}

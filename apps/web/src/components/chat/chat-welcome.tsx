import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@hushbox/ui';
import { useVisualViewportHeight } from '@hushbox/ui';
import { getGreeting } from '@/lib/greetings';
import { getTaglineSubtitle } from '@/lib/modality-strings';
import { useModelStore, type SelectedModelEntry } from '@/stores/model';
import { useSearchStore } from '@/stores/search';
import { useSelectedModelCapabilities } from '@/hooks/use-selected-model-capabilities';
import { useResolveDefaultModel } from '@/hooks/use-resolve-default-model';
import { useStableBalance } from '@/hooks/use-stable-balance';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { getInspirationLabel, getPromptPlaceholder } from '@/lib/modality-strings';
import { ComparisonBar } from './comparison-bar';
import { ChatHeader } from './chat-header';
import { SuggestionChips } from './suggestion-chips';
import { PromptInput } from './prompt-input';
import { TypingAnimation } from './typing-animation';
import type { FundingSource, Modality } from '@hushbox/shared';
import type { ChatSearchProps, PromptInputRef } from './prompt-input';

interface WelcomeGreetingProps {
  greeting: ReturnType<typeof getGreeting> | null;
  showSubtitle: boolean;
  onTypingComplete: () => void;
}

function WelcomeGreeting({
  greeting,
  showSubtitle,
  onTypingComplete,
}: Readonly<WelcomeGreetingProps>): React.JSX.Element {
  return (
    <div className="text-center">
      <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
        {greeting ? (
          <TypingAnimation
            text={greeting.title}
            typingSpeed={75}
            loop={false}
            onComplete={onTypingComplete}
          />
        ) : (
          <span className="invisible">Loading...</span>
        )}
      </h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: showSubtitle ? 1 : 0, y: showSubtitle ? 0 : 10 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="text-muted-foreground mt-4 text-lg"
      >
        {greeting?.subtitle ?? '\u00A0'}
      </motion.p>
    </div>
  );
}

interface ChatWelcomeProps {
  onSend: (message: string, fundingSource: FundingSource) => void;
  isAuthenticated: boolean;
  isLoading?: boolean | undefined;
  className?: string | undefined;
  /** Called when a trial user clicks a premium model */
  onPremiumClick?: ((modelId: string) => void) | undefined;
}

/**
 * Full-screen welcome page with centered greeting, prompt input, and suggestions.
 * This is the "blank canvas" experience for starting a new conversation.
 */
export function ChatWelcome({
  onSend,
  isAuthenticated,
  isLoading = false,
  className,
  onPremiumClick,
}: Readonly<ChatWelcomeProps>): React.JSX.Element {
  const [inputValue, setInputValue] = React.useState('');
  const [showSubtitle, setShowSubtitle] = React.useState(false);
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();

  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const setActiveModality = useModelStore((state) => state.setActiveModality);
  useResolveDefaultModel(activeModality);
  const { webSearchEnabled, toggleWebSearch } = useSearchStore();
  const selectModality = React.useCallback(
    (modality: Modality): void => {
      setActiveModality(modality);
    },
    [setActiveModality]
  );

  const { models, premiumIds } = useSelectedModelCapabilities();
  const searchProps: ChatSearchProps | undefined =
    activeModality === 'text'
      ? {
          webSearchEnabled,
          onToggleWebSearch: toggleWebSearch,
        }
      : undefined;

  const handleModelSelect = React.useCallback((entries: SelectedModelEntry[]): void => {
    const { activeModality: current, setSelectedModels } = useModelStore.getState();
    setSelectedModels(current, entries);
  }, []);

  const handleRemoveModel = React.useCallback((modelId: string): void => {
    const { activeModality: current, removeModel } = useModelStore.getState();
    removeModel(current, modelId);
  }, []);

  const { displayBalance } = useStableBalance();
  const balance = Number.parseFloat(displayBalance);
  const canAccessPremium = isAuthenticated && balance > 0;

  // Pick a stable base greeting once auth state settles (prevents title flash
  // on auth changes). Subtitle is re-derived per modality below so the tagline
  // can swap without re-rolling the title.
  const baseGreeting = React.useMemo(() => {
    if (isLoading) return null;
    return getGreeting(isAuthenticated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]); // Intentionally exclude isAuthenticated - we only want to compute once after loading

  const greeting = React.useMemo(() => {
    if (!baseGreeting) return null;
    return {
      title: baseGreeting.title,
      subtitle: getTaglineSubtitle(activeModality, baseGreeting.subtitle),
    };
  }, [baseGreeting, activeModality]);

  // Auto-focus input when page finishes loading (desktop only)
  // Skip on mobile to avoid triggering keyboard unexpectedly
  const previousIsLoadingRef = React.useRef(isLoading);
  React.useEffect(() => {
    if (previousIsLoadingRef.current && !isLoading && !isMobile) {
      promptInputRef.current?.focus();
    }
    previousIsLoadingRef.current = isLoading;
  }, [isLoading, isMobile]);

  const handleSubmit = (fundingSource: FundingSource): void => {
    if (inputValue.trim()) {
      onSend(inputValue.trim(), fundingSource);
      setInputValue('');
    }
  };

  const handleSuggestionSelect = (prompt: string): void => {
    setInputValue(prompt);
  };

  const handleTypingComplete = (): void => {
    setShowSubtitle(true);
  };

  return (
    <div
      data-testid="chat-welcome"
      data-loading={String(isLoading)}
      className={cn('flex flex-col overflow-hidden', className)}
      style={{ height: `${String(viewportHeight)}px` }}
    >
      <ChatHeader
        models={models}
        selectedModels={selectedModels}
        onModelSelect={handleModelSelect}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        onPremiumClick={onPremiumClick}
        activeModality={activeModality}
      />
      <ComparisonBar
        models={models}
        selectedModels={selectedModels}
        onRemoveModel={handleRemoveModel}
      />

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-8">
        <div className="w-full max-w-2xl space-y-8">
          <WelcomeGreeting
            greeting={greeting}
            showSubtitle={showSubtitle}
            onTypingComplete={handleTypingComplete}
          />

          <div className="w-full">
            <PromptInput
              ref={promptInputRef}
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              placeholder={getPromptPlaceholder(activeModality, 'Ask me anything...')}
              rows={6}
              disabled={isLoading}
              isAuthenticated={isAuthenticated}
              activeModality={activeModality}
              onSelectModality={selectModality}
              {...(searchProps !== undefined && { searchProps })}
            />
          </div>

          <div className="space-y-4">
            <p className="text-muted-foreground text-center text-sm">
              {getInspirationLabel(activeModality)}
            </p>
            <SuggestionChips onSelect={handleSuggestionSelect} showSurpriseMe />
          </div>

          <p data-testid="privacy-tagline" className="text-muted-foreground/60 text-center text-xs">
            {isAuthenticated
              ? 'Encrypted storage \u00B7 AI providers retain nothing'
              : 'AI providers retain nothing \u00B7 Sign up for encrypted storage'}
          </p>
        </div>
      </div>
    </div>
  );
}

import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@lome-chat/ui';
import { TypingAnimation } from './typing-animation';
import { PromptInput } from './prompt-input';
import type { PromptInputRef } from './prompt-input';
import { SuggestionChips } from './suggestion-chips';
import { ChatHeader } from './chat-header';
import { getGreeting } from '@/lib/greetings';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useStableBalance } from '@/hooks/use-stable-balance';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';
import { useIsMobile } from '@/hooks/use-is-mobile';

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
  onSend: (message: string) => void;
  isAuthenticated: boolean;
  isLoading?: boolean | undefined;
  className?: string | undefined;
  /** Called when a guest user clicks a premium model */
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

  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();

  const { data: modelsData } = useModels();
  const models = modelsData?.models ?? [];
  const premiumIds = modelsData?.premiumIds ?? new Set<string>();

  // Premium access requires authentication AND positive balance
  const { displayBalance } = useStableBalance();
  const balance = Number.parseFloat(displayBalance);
  const canAccessPremium = isAuthenticated && balance > 0;

  // Get a greeting once auth state is settled (prevents flash when isAuthenticated changes)
  // Use null while loading, generate greeting only after isLoading becomes false
  const greeting = React.useMemo(() => {
    if (isLoading) return null;
    return getGreeting(isAuthenticated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]); // Intentionally exclude isAuthenticated - we only want to compute once after loading

  // Auto-focus input when page finishes loading (desktop only)
  // Skip on mobile to avoid triggering keyboard unexpectedly
  const previousIsLoadingRef = React.useRef(isLoading);
  React.useEffect(() => {
    if (previousIsLoadingRef.current && !isLoading && !isMobile) {
      promptInputRef.current?.focus();
    }
    previousIsLoadingRef.current = isLoading;
  }, [isLoading, isMobile]);

  const handleSubmit = (): void => {
    if (inputValue.trim()) {
      onSend(inputValue.trim());
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
        selectedModelId={selectedModelId}
        selectedModelName={selectedModelName}
        onModelSelect={setSelectedModel}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        onPremiumClick={onPremiumClick}
      />

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-4 sm:py-8">
        <div className="w-full max-w-2xl space-y-4 sm:space-y-8">
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
              placeholder="Ask me anything..."
              rows={6}
              disabled={isLoading}
            />
          </div>

          <div className="space-y-4">
            <p className="text-muted-foreground text-center text-sm">
              Need inspiration? Try these:
            </p>
            <SuggestionChips onSelect={handleSuggestionSelect} showSurpriseMe />
          </div>
        </div>
      </div>
    </div>
  );
}

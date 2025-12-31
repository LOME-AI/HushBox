import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@lome-chat/ui';
import { TypingAnimation } from './typing-animation';
import { PromptInput } from './prompt-input';
import { SuggestionChips } from './suggestion-chips';
import { ChatHeader } from './chat-header';
import { getGreeting } from '@/lib/greetings';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport-height';

interface NewChatPageProps {
  onSend: (message: string) => void;
  isAuthenticated: boolean;
  isLoading?: boolean;
  className?: string;
}

/**
 * Full-screen new chat page with centered greeting, prompt input, and suggestions.
 * This is the "blank canvas" experience for starting a new conversation.
 */
export function NewChatPage({
  onSend,
  isAuthenticated,
  isLoading = false,
  className,
}: NewChatPageProps): React.JSX.Element {
  const [inputValue, setInputValue] = React.useState('');
  const [showSubtitle, setShowSubtitle] = React.useState(false);
  const viewportHeight = useVisualViewportHeight();

  const { selectedModelId, selectedModelName, setSelectedModel } = useModelStore();

  const { data: models = [] } = useModels();

  // Find selected model to get context length
  const selectedModel = models.find((m) => m.id === selectedModelId);

  // Get a greeting once on mount
  const greeting = React.useMemo(() => getGreeting(isAuthenticated), [isAuthenticated]);

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
      data-testid="new-chat-page"
      className={cn('flex flex-col overflow-hidden', className)}
      style={{ height: `${String(viewportHeight)}px` }}
    >
      {/* ChatHeader with model selector and theme toggle */}
      <ChatHeader
        models={models}
        selectedModelId={selectedModelId}
        selectedModelName={selectedModelName}
        onModelSelect={setSelectedModel}
      />

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-4 sm:py-8">
        <div className="w-full max-w-2xl space-y-4 sm:space-y-8">
          {/* Greeting Section */}
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
              <TypingAnimation
                text={greeting.title}
                typingSpeed={50}
                loop={false}
                onComplete={handleTypingComplete}
              />
            </h1>

            {/* Subtitle with fade-in animation */}
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: showSubtitle ? 1 : 0, y: showSubtitle ? 0 : 10 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-muted-foreground mt-4 text-lg"
            >
              {greeting.subtitle}
            </motion.p>
          </div>

          {/* Prompt Input Section */}
          <div className="w-full">
            <PromptInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              placeholder="Ask me anything..."
              modelContextLimit={selectedModel?.contextLength}
              historyTokens={0}
              rows={6}
              disabled={isLoading}
            />
          </div>

          {/* Suggestions Section */}
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

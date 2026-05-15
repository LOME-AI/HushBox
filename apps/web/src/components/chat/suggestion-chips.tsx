import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Dices } from 'lucide-react';
import { cn, useReducedMotion } from '@hushbox/ui';
import { Button } from '@hushbox/ui';
import { getSecureRandomIndex } from '@hushbox/shared';
import { getSuggestionsForModality, type PromptSuggestion } from '@/lib/prompt-suggestions';
import { useModelStore } from '@/stores/model';

interface SuggestionChipsProps {
  onSelect: (prompt: string) => void;
  showSurpriseMe?: boolean;
  className?: string;
}

interface ChipContentProps {
  suggestions: readonly PromptSuggestion[];
  onSelect: (prompt: string) => void;
  showSurpriseMe: boolean;
  onSurpriseMe: () => void;
  reducedMotion: boolean;
}

function ChipContent({
  suggestions,
  onSelect,
  showSurpriseMe,
  onSurpriseMe,
  reducedMotion,
}: Readonly<ChipContentProps>): React.JSX.Element {
  return (
    <>
      {suggestions.map((suggestion, index) => {
        const Icon = suggestion.icon;
        const button = (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const randomIndex = getSecureRandomIndex(suggestion.prompts.length);
              const prompt = suggestion.prompts[randomIndex];
              if (prompt) {
                onSelect(prompt);
              }
            }}
            className="gap-2 rounded-full"
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {suggestion.label}
          </Button>
        );

        if (reducedMotion) {
          return <div key={suggestion.id}>{button}</div>;
        }
        return (
          <motion.div
            key={suggestion.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: index * 0.03, duration: 0.2 }}
          >
            {button}
          </motion.div>
        );
      })}

      {showSurpriseMe && (
        <Button variant="secondary" size="sm" onClick={onSurpriseMe} className="gap-2 rounded-full">
          <Dices className="h-4 w-4" aria-hidden="true" />
          Surprise Me
        </Button>
      )}
    </>
  );
}

/**
 * Chip-style buttons for quick prompt suggestions.
 * Used on the new chat page to help users get started.
 */
export function SuggestionChips({
  onSelect,
  showSurpriseMe = false,
  className,
}: Readonly<SuggestionChipsProps>): React.JSX.Element {
  const activeModality = useModelStore((state) => state.activeModality);
  const reducedMotion = useReducedMotion();
  const suggestions = getSuggestionsForModality(activeModality);

  const handleSurpriseMe = (): void => {
    const pool = suggestions.flatMap((s) => s.prompts);
    if (pool.length === 0) return;
    const randomIndex = getSecureRandomIndex(pool.length);
    const prompt = pool[randomIndex];
    if (prompt) {
      onSelect(prompt);
    }
  };

  return (
    <div
      data-testid="suggestion-chips"
      className={cn('flex flex-wrap items-center justify-center gap-2', className)}
    >
      {reducedMotion ? (
        <ChipContent
          suggestions={suggestions}
          onSelect={onSelect}
          showSurpriseMe={showSurpriseMe}
          onSurpriseMe={handleSurpriseMe}
          reducedMotion
        />
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeModality}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="flex flex-wrap items-center justify-center gap-2"
          >
            <ChipContent
              suggestions={suggestions}
              onSelect={onSelect}
              showSurpriseMe={showSurpriseMe}
              onSurpriseMe={handleSurpriseMe}
              reducedMotion={false}
            />
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

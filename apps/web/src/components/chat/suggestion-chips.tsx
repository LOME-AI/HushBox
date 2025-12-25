import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Button } from '@lome-chat/ui';
import { Dices } from 'lucide-react';
import { promptSuggestions } from '@/lib/prompt-suggestions';

interface SuggestionChipsProps {
  onSelect: (prompt: string) => void;
  showSurpriseMe?: boolean;
  className?: string;
}

/**
 * Chip-style buttons for quick prompt suggestions.
 * Used on the new chat page to help users get started.
 */
export function SuggestionChips({
  onSelect,
  showSurpriseMe = false,
  className,
}: SuggestionChipsProps): React.JSX.Element {
  const handleSurpriseMe = (): void => {
    const randomIndex = Math.floor(Math.random() * promptSuggestions.length);
    const randomSuggestion = promptSuggestions[randomIndex];
    if (randomSuggestion) {
      onSelect(randomSuggestion.prompt);
    }
  };

  return (
    <div
      data-testid="suggestion-chips"
      className={cn('flex flex-wrap items-center justify-center gap-2', className)}
    >
      {promptSuggestions.map((suggestion) => {
        const Icon = suggestion.icon;
        return (
          <Button
            key={suggestion.id}
            variant="outline"
            size="sm"
            onClick={() => {
              onSelect(suggestion.prompt);
            }}
            className="gap-2 rounded-full"
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {suggestion.label}
          </Button>
        );
      })}

      {showSurpriseMe && (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSurpriseMe}
          className="gap-2 rounded-full"
        >
          <Dices className="h-4 w-4" aria-hidden="true" />
          Surprise Me
        </Button>
      )}
    </div>
  );
}

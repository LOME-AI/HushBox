import * as React from 'react';
import { Button, Card, CardContent } from '@lome-chat/ui';
import { promptSuggestions } from '@/lib/prompt-suggestions';
import { getGreeting } from '@/lib/greetings';
import { TypingAnimation } from './typing-animation';

interface EmptyChatProps {
  onSuggestionClick?: (prompt: string) => void;
  isAuthenticated?: boolean;
}

export function EmptyChat({
  onSuggestionClick,
  isAuthenticated = true,
}: EmptyChatProps): React.JSX.Element {
  const [greeting] = React.useState(() => getGreeting(isAuthenticated));

  return (
    <div
      data-testid="empty-chat"
      className="flex h-full flex-col items-center justify-center gap-8 p-6 sm:p-8"
    >
      <div className="text-center">
        <h1 className="text-primary mb-2 text-4xl font-bold">
          <TypingAnimation text={greeting.title} typingSpeed={50} loop={false} />
        </h1>
        <p data-testid="greeting-subtitle" className="text-muted-foreground text-lg font-medium">
          {greeting.subtitle}
        </p>
      </div>

      <Card data-testid="suggestions-card" className="w-full max-w-2xl rounded-lg border">
        <CardContent className="p-6 sm:p-8">
          <div data-testid="suggestions" className="grid grid-cols-2 gap-4">
            {promptSuggestions.map((suggestion) => (
              <Button
                key={suggestion.id}
                variant="outline"
                className="h-auto flex-col items-start gap-2 rounded-lg p-4 text-left"
                onClick={() => onSuggestionClick?.(suggestion.prompt)}
              >
                <suggestion.icon className="text-muted-foreground h-12 w-12" />
                <span className="text-sm font-medium">{suggestion.label}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

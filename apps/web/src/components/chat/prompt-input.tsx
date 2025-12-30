import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';
import { Button } from '@lome-chat/ui';
import { Textarea } from '@lome-chat/ui';
import { estimateTokenCount } from '@/lib/tokens';

/** Buffer reserved for AI response generation */
const RESPONSE_BUFFER = 10000;

/** Default max tokens when model context is not available */
const DEFAULT_MAX_TOKENS = 2000;

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** Model's total context length in tokens */
  modelContextLimit?: number | undefined;
  /** Current conversation history token count (system + user + assistant messages) */
  historyTokens?: number;
  className?: string;
  rows?: number;
  disabled?: boolean;
  /** When true, shows stop button instead of send and disables textarea */
  isStreaming?: boolean;
  /** Called when stop button is clicked during streaming */
  onStop?: () => void;
}

/**
 * Large prompt input with token counter, send button, and keyboard handling.
 * Used for the new chat page's main input area.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Ask me anything...',
  modelContextLimit,
  historyTokens = 0,
  className,
  rows = 6,
  disabled = false,
  isStreaming = false,
  onStop,
}: PromptInputProps): React.JSX.Element {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Calculate available tokens based on model context, history, and response buffer
  // Formula: available = modelContext - historyTokens - responseBuffer
  // Falls back to default if model context not provided
  const availableTokens = modelContextLimit
    ? Math.max(0, modelContextLimit - historyTokens - RESPONSE_BUFFER)
    : DEFAULT_MAX_TOKENS;

  // Calculate token count
  const currentTokens = estimateTokenCount(value);
  const isOverLimit = currentTokens > availableTokens;
  const excessTokens = Math.max(0, currentTokens - availableTokens);

  const canSubmit = value.trim().length > 0 && !isOverLimit && !disabled && !isStreaming;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) {
        onSubmit();
      }
    }
  };

  const handleSubmitClick = (): void => {
    if (canSubmit) {
      onSubmit();
    }
  };

  const handleStopClick = (): void => {
    onStop?.();
  };

  return (
    <div className={cn('relative w-full', className)}>
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={rows}
          disabled={disabled || isStreaming}
          className={cn(
            'max-h-[40vh] min-h-[150px] resize-none overflow-y-auto pr-14 pb-10 text-base',
            isOverLimit && 'border-destructive focus-visible:ring-destructive'
          )}
        />

        {/* Token counter */}
        <div
          data-testid="token-counter"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            'absolute bottom-3 left-3 text-sm',
            isOverLimit ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {isOverLimit ? (
            <span>
              {availableTokens}+{excessTokens}/{availableTokens} Tokens
            </span>
          ) : (
            <span>
              {currentTokens}/{availableTokens} Tokens
            </span>
          )}
        </div>

        {/* Send or Stop button */}
        {isStreaming ? (
          <Button
            type="button"
            size="icon"
            onClick={handleStopClick}
            className="absolute right-3 bottom-3"
            aria-label="Stop"
            variant="destructive"
          >
            <Square className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={handleSubmitClick}
            disabled={!canSubmit}
            className="absolute right-3 bottom-3"
            aria-label="Send"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* Over limit warning */}
      {isOverLimit && (
        <p className="text-destructive mt-2 text-sm">
          Tokens beyond the {availableTokens} token limit will not be included.
        </p>
      )}
    </div>
  );
}

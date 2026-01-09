import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';
import { Button } from '@lome-chat/ui';
import { Textarea } from '@lome-chat/ui';
import { estimateTokenCount } from '@/lib/tokens';
import { buildSystemPrompt, type CapabilityId } from '@lome-chat/shared';

/** Buffer reserved for AI response generation */
const RESPONSE_BUFFER = 1000;

/** Default max tokens when model context is not available */
const DEFAULT_MAX_TOKENS = 2000;

export interface PromptInputRef {
  focus: () => void;
}

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** Model's total context length in tokens */
  modelContextLimit?: number | undefined;
  /** Current conversation history token count (system + user + assistant messages) */
  historyTokens?: number;
  /** Active capabilities that affect system prompt size */
  capabilities?: CapabilityId[];
  className?: string;
  rows?: number;
  disabled?: boolean;
  /** When true, shows stop button instead of send and disables textarea */
  isStreaming?: boolean;
  /** Called when stop button is clicked during streaming */
  onStop?: () => void;
  /** Custom minimum height for textarea (e.g., "56px"). Defaults to "120px" */
  minHeight?: string;
  /** Custom maximum height for textarea (e.g., "112px"). Defaults to "40vh" */
  maxHeight?: string;
}

/**
 * Large prompt input with token counter, send button, and keyboard handling.
 * Used for the new chat page's main input area.
 */
export const PromptInput = React.forwardRef<PromptInputRef, PromptInputProps>(function PromptInput(
  {
    value,
    onChange,
    onSubmit,
    placeholder = 'Ask me anything...',
    modelContextLimit,
    historyTokens = 0,
    capabilities = [],
    className,
    rows = 6,
    disabled = false,
    isStreaming = false,
    onStop,
    minHeight = '120px',
    maxHeight = '40vh',
  },
  ref
) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  // Calculate system prompt tokens based on active capabilities
  const systemPrompt = React.useMemo(() => buildSystemPrompt(capabilities), [capabilities]);
  const systemPromptTokens = React.useMemo(() => estimateTokenCount(systemPrompt), [systemPrompt]);

  // Calculate available tokens based on model context, history, system prompt, and response buffer
  // Formula: available = modelContext - historyTokens - systemPromptTokens - responseBuffer
  // Falls back to default if model context not provided
  const availableTokens = modelContextLimit
    ? Math.max(0, modelContextLimit - historyTokens - systemPromptTokens - RESPONSE_BUFFER)
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
    <div className={cn('w-full', className)}>
      <div className="border-border-strong bg-background dark:border-input flex flex-col rounded-md border">
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
            `max-h-[${maxHeight}] min-h-[${minHeight}] resize-none overflow-y-auto border-0 text-base focus-visible:ring-0`,
            isOverLimit && 'text-destructive'
          )}
        />

        <div className="border-border flex items-center justify-between border-t px-3 py-2">
          <div
            data-testid="token-counter"
            aria-live="polite"
            aria-atomic="true"
            className={cn('text-sm', isOverLimit ? 'text-destructive' : 'text-muted-foreground')}
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

          {isStreaming ? (
            <Button
              type="button"
              size="icon"
              onClick={handleStopClick}
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
              aria-label="Send"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {isOverLimit && (
        <p className="text-destructive mt-2 text-sm">
          Tokens beyond the {availableTokens} token limit will not be included.
        </p>
      )}
    </div>
  );
});

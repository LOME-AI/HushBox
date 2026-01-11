import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';
import { Button } from '@lome-chat/ui';
import { Textarea } from '@lome-chat/ui';
import { estimateTokenCount } from '@/lib/tokens';
import {
  buildSystemPrompt,
  applyFees,
  type CapabilityId,
  MINIMUM_OUTPUT_TOKENS,
} from '@lome-chat/shared';
import { CapacityBar } from './capacity-bar';
import { BudgetMessages } from './budget-messages';
import { useBudgetCalculation } from '@/hooks/use-budget-calculation';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useSession } from '@/lib/auth';

/** Default model context when not provided */
const DEFAULT_MODEL_CONTEXT = 4000;

export interface PromptInputRef {
  focus: () => void;
}

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** Current conversation history character count (for budget calculation) */
  historyCharacters?: number;
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
 * Large prompt input with budget calculation, capacity bar, and keyboard handling.
 * Self-contained: calculates budget internally using model and balance data.
 */
export const PromptInput = React.forwardRef<PromptInputRef, PromptInputProps>(function PromptInput(
  {
    value,
    onChange,
    onSubmit,
    placeholder = 'Ask me anything...',
    historyCharacters = 0,
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

  // Get selected model and pricing from stores/hooks
  const { selectedModelId } = useModelStore();
  const { data: modelsData } = useModels();
  const { data: session } = useSession();
  const isAuthenticated = !!session?.user;

  // Find selected model to get pricing and context length
  const selectedModel = modelsData?.models.find((m) => m.id === selectedModelId);
  const modelContextLength = selectedModel?.contextLength ?? DEFAULT_MODEL_CONTEXT;

  // Calculate system prompt based on active capabilities
  const systemPrompt = React.useMemo(() => buildSystemPrompt(capabilities), [capabilities]);
  const systemPromptTokens = React.useMemo(() => estimateTokenCount(systemPrompt), [systemPrompt]);

  // Calculate current message tokens for capacity bar
  const currentMessageTokens = estimateTokenCount(value);

  // Estimate history tokens from characters (for capacity bar)
  // Using conservative estimate of 2 chars per token
  const historyTokens = Math.ceil(historyCharacters / 2);

  // Calculate prompt character count for budget calculation
  const promptCharacterCount = systemPrompt.length + historyCharacters + value.length;

  // Self-contained budget calculation - handles capacity, affordability, and errors
  const budgetResult = useBudgetCalculation({
    promptCharacterCount,
    modelInputPricePerToken: applyFees(selectedModel?.pricePerInputToken ?? 0),
    modelOutputPricePerToken: applyFees(selectedModel?.pricePerOutputToken ?? 0),
    modelContextLength,
    isAuthenticated,
  });

  // Use capacity from budget result for consistency
  const isOverCapacity = budgetResult.capacityPercent > 100;

  // Total current usage for capacity bar (calculate locally for display)
  const currentUsage =
    systemPromptTokens + historyTokens + currentMessageTokens + MINIMUM_OUTPUT_TOKENS;

  // Check if there are any blocking errors
  const hasBlockingError = budgetResult.errors.some((e) => e.type === 'error');

  // Send button disabled, but textarea remains enabled for editing
  const canSubmit =
    value.trim().length > 0 &&
    !isOverCapacity &&
    budgetResult.canAfford &&
    !hasBlockingError &&
    !disabled &&
    !isStreaming;

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
          className={`max-h-[${maxHeight}] min-h-[${minHeight}] resize-none overflow-y-auto border-0 text-base focus-visible:ring-0`}
        />

        <div className="border-border flex items-center justify-between gap-4 border-t px-3 py-2">
          <CapacityBar
            currentUsage={currentUsage}
            maxCapacity={modelContextLength}
            className="flex-1"
            data-testid="capacity-bar"
          />

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

      {/* Budget messages appear below the input (self-calculated) */}
      {budgetResult.errors.length > 0 && (
        <BudgetMessages errors={budgetResult.errors} className="mt-2" />
      )}
    </div>
  );
});

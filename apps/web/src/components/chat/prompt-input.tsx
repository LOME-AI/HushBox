import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';
import { Button } from '@lome-chat/ui';
import { Textarea } from '@lome-chat/ui';
import type { CapabilityId } from '@lome-chat/shared';
import { CapacityBar } from './capacity-bar';
import { BudgetMessages } from './budget-messages';
import { usePromptBudget } from '@/hooks/use-prompt-budget';
import { useStability } from '@/providers/stability-provider';
import { StableContent } from '@/components/shared/stable-content';

export interface PromptInputRef {
  focus: () => void;
}

interface SubmitState {
  hasContent: boolean;
  isOverCapacity: boolean;
  canAfford: boolean;
  hasBlockingError: boolean;
  disabled: boolean;
  isProcessing: boolean;
}

function canSubmitMessage(state: SubmitState): boolean {
  if (!state.hasContent) return false;
  if (state.isOverCapacity) return false;
  if (!state.canAfford) return false;
  if (state.hasBlockingError) return false;
  if (state.disabled) return false;
  if (state.isProcessing) return false;
  return true;
}

function isSubmitKeyEvent(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey;
}

const BUTTON_ARIA_LABELS = { true: 'Send', false: 'Cannot send' } as const;

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
  /** When true, blocks sending (shows stop icon on disabled button) */
  isProcessing?: boolean;
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
    isProcessing = false,
    minHeight = '120px',
    maxHeight = '40vh',
  },
  ref
) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  const { isAppStable } = useStability();
  const budget = usePromptBudget({ value, historyCharacters, capabilities });

  const canSubmit = canSubmitMessage({
    hasContent: budget.hasContent,
    isOverCapacity: budget.isOverCapacity,
    canAfford: budget.budgetResult.canAfford,
    hasBlockingError: budget.hasBlockingError,
    disabled,
    isProcessing,
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isSubmitKeyEvent(e) && canSubmit) {
      e.preventDefault();
      onSubmit();
    }
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
          disabled={disabled}
          className={`max-h-[${maxHeight}] min-h-[${minHeight}] resize-none overflow-y-auto border-0 text-base focus-visible:ring-0`}
        />

        <div className="border-border flex items-center justify-between gap-4 border-t px-3 py-2">
          <CapacityBar
            currentUsage={budget.capacityCurrentUsage}
            maxCapacity={budget.capacityMaxCapacity}
            className="flex-1"
            data-testid="capacity-bar"
          />

          <Button
            type="button"
            size="icon"
            onClick={onSubmit}
            disabled={!canSubmit}
            aria-label={BUTTON_ARIA_LABELS[String(canSubmit) as 'true' | 'false']}
          >
            {isProcessing ? (
              <Square className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>

      <StableContent isStable={isAppStable}>
        <BudgetMessages errors={budget.budgetResult.errors} className="mt-2" />
      </StableContent>
    </div>
  );
});

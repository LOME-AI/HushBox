import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';
import { Button } from '@lome-chat/ui';
import { Textarea } from '@lome-chat/ui';
import { buildSystemPrompt, applyFees, type CapabilityId } from '@lome-chat/shared';
import { CapacityBar } from './capacity-bar';
import { BudgetMessages } from './budget-messages';
import { useBudgetCalculation } from '@/hooks/use-budget-calculation';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models';
import { useSession } from '@/lib/auth';
import { useStability } from '@/providers/stability-provider';
import { StableContent } from '@/components/shared/stable-content';

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

  React.useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  const { selectedModelId } = useModelStore();
  const { data: modelsData, isLoading: isModelsLoading } = useModels();
  const { data: session, isPending: isSessionPending } = useSession();
  const { isAppStable } = useStability();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const selectedModel = modelsData?.models.find((m) => m.id === selectedModelId);
  const modelContextLength = selectedModel?.contextLength;

  const systemPrompt = React.useMemo(() => buildSystemPrompt(capabilities), [capabilities]);
  const promptCharacterCount = systemPrompt.length + historyCharacters + value.length;

  const budgetResult = useBudgetCalculation({
    promptCharacterCount,
    modelInputPricePerToken: applyFees(selectedModel?.pricePerInputToken ?? 0),
    modelOutputPricePerToken: applyFees(selectedModel?.pricePerOutputToken ?? 0),
    modelContextLength: modelContextLength ?? 0,
    isAuthenticated,
    isModelsLoading,
  });

  const isOverCapacity = budgetResult.capacityPercent > 100;
  const hasBlockingError = budgetResult.errors.some((e) => e.type === 'error');

  const canSubmit =
    value.trim().length > 0 &&
    !isOverCapacity &&
    budgetResult.canAfford &&
    !hasBlockingError &&
    !disabled &&
    !isProcessing;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
            currentUsage={modelContextLength ? budgetResult.currentUsage : 0}
            maxCapacity={modelContextLength ?? 1}
            className="flex-1"
            data-testid="capacity-bar"
          />

          <Button
            type="button"
            size="icon"
            onClick={handleSubmitClick}
            disabled={!canSubmit}
            aria-label={canSubmit ? 'Send' : 'Cannot send'}
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
        <BudgetMessages errors={budgetResult.errors} className="mt-2" />
      </StableContent>
    </div>
  );
});

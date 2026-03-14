import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Bot, MessageSquare, Pencil, Search, SearchX, Send, Square, X } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui';
import { Textarea } from '@hushbox/ui';
import type { CapabilityId, FundingSource, MemberPrivilege } from '@hushbox/shared';
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
  hasBlockingError: boolean;
  disabled: boolean;
  isProcessing: boolean;
}

function canSubmitMessage(state: SubmitState): boolean {
  if (!state.hasContent) return false;
  if (state.isOverCapacity) return false;
  if (state.hasBlockingError) return false;
  if (state.disabled) return false;
  if (state.isProcessing) return false;
  return true;
}

function isSubmitKeyEvent(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey;
}

const BUTTON_ARIA_LABELS = { true: 'Send', false: 'Cannot send' } as const;
const TYPING_THROTTLE_MS = 3000;

function emitTypingChange(
  newValue: string,
  onTypingChange: ((isTyping: boolean) => void) | undefined,
  lastTypingSentRef: React.RefObject<number>
): void {
  if (!onTypingChange) return;
  if (newValue.length === 0) {
    onTypingChange(false);
    lastTypingSentRef.current = 0;
  } else {
    const now = Date.now();
    if (now - lastTypingSentRef.current >= TYPING_THROTTLE_MS) {
      onTypingChange(true);
      lastTypingSentRef.current = now;
    }
  }
}

interface ToggleButtonWithTooltipProps {
  tooltipText: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}

function ToggleButtonWithTooltip({
  tooltipText,
  onClick,
  disabled,
  ariaLabel,
  children,
}: Readonly<ToggleButtonWithTooltipProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex"
          onClick={() => {
            setOpen(true);
            if (!disabled) onClick?.();
          }}
        >
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label={ariaLabel}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

interface SubmitButtonIconProps {
  isProcessing: boolean;
}

function SubmitButtonIcon({ isProcessing }: Readonly<SubmitButtonIconProps>): React.JSX.Element {
  if (isProcessing) {
    return <Square className="h-4 w-4" aria-hidden="true" />;
  }
  return <Send className="h-4 w-4" aria-hidden="true" />;
}

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (fundingSource: FundingSource) => void;
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
  /** Auto-focus the textarea on mount. Use for desktop only to avoid mobile keyboard popup. */
  autoFocus?: boolean;
  /** Conversation ID for group budget lookup. Omit for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
  /** When true, shows the AI toggle button (group chats only). */
  isGroupChat?: boolean;
  /** Called when user submits with AI toggle off (user-only message, no AI invocation). */
  onSubmitUserOnly?: () => void;
  /** Called when typing state changes (for WebSocket typing indicators). Throttled internally. */
  onTypingChange?: ((isTyping: boolean) => void) | undefined;
  /** Whether web search is enabled */
  webSearchEnabled?: boolean;
  /** Whether the selected model supports native web search */
  modelSupportsSearch?: boolean;
  /** Whether the user is authenticated (trial users can't search) */
  isAuthenticated?: boolean;
  /** Called when user toggles web search */
  onToggleWebSearch?: (() => void) | undefined;
  /** Whether the prompt input is in edit mode (editing a previous message) */
  isEditing?: boolean;
  /** Called when the user cancels editing */
  onCancelEdit?: (() => void) | undefined;
}

const PROMPT_INPUT_DEFAULTS: Pick<
  Required<PromptInputProps>,
  | 'placeholder'
  | 'historyCharacters'
  | 'capabilities'
  | 'rows'
  | 'disabled'
  | 'isProcessing'
  | 'minHeight'
  | 'maxHeight'
  | 'autoFocus'
  | 'isGroupChat'
> = {
  placeholder: 'Ask me anything...',
  historyCharacters: 0,
  capabilities: [] as CapabilityId[],
  rows: 6,
  disabled: false,
  isProcessing: false,
  minHeight: '120px',
  maxHeight: '40vh',
  autoFocus: false,
  isGroupChat: false,
};

/**
 * Large prompt input with budget calculation, capacity bar, and keyboard handling.
 * Self-contained: calculates budget internally using model and balance data.
 */
function AIToggleButton({
  aiEnabled,
  onToggle,
}: Readonly<{ aiEnabled: boolean; onToggle: () => void }>): React.JSX.Element {
  const label = aiEnabled ? 'AI response on' : 'AI response off';
  return (
    <ToggleButtonWithTooltip tooltipText={label} onClick={onToggle} ariaLabel={label}>
      {aiEnabled ? (
        <Bot className="h-4 w-4" aria-hidden="true" />
      ) : (
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
      )}
    </ToggleButtonWithTooltip>
  );
}

interface SearchToggleButtonProps {
  webSearchEnabled: boolean;
  modelSupportsSearch: boolean;
  isAuthenticated: boolean;
  onToggle?: (() => void) | undefined;
}

function getSearchTooltipText(
  isAuthenticated: boolean,
  modelSupportsSearch: boolean,
  webSearchEnabled: boolean
): string {
  if (!isAuthenticated) {
    return 'Sign up to access internet search';
  }
  if (!modelSupportsSearch) {
    return "This model doesn't support internet search";
  }
  return webSearchEnabled ? 'Internet search on' : 'Internet search off';
}

function SearchToggleButton({
  webSearchEnabled,
  modelSupportsSearch,
  isAuthenticated,
  onToggle,
}: Readonly<SearchToggleButtonProps>): React.JSX.Element {
  const isDisabled = !isAuthenticated || !modelSupportsSearch;
  const searchState = webSearchEnabled ? 'Internet search on' : 'Internet search off';
  const ariaLabel = isDisabled ? 'Internet search unavailable' : searchState;
  const tooltipText = getSearchTooltipText(isAuthenticated, modelSupportsSearch, webSearchEnabled);

  return (
    <ToggleButtonWithTooltip
      tooltipText={tooltipText}
      onClick={onToggle}
      disabled={isDisabled}
      ariaLabel={ariaLabel}
    >
      {webSearchEnabled && !isDisabled ? (
        <Search className="h-4 w-4" aria-hidden="true" />
      ) : (
        <SearchX className="h-4 w-4 opacity-50" aria-hidden="true" />
      )}
    </ToggleButtonWithTooltip>
  );
}

export const PromptInput = React.forwardRef<PromptInputRef, PromptInputProps>(
  function PromptInput(rawProps, ref) {
    const {
      value,
      onChange,
      onSubmit,
      placeholder,
      historyCharacters,
      capabilities,
      className,
      rows,
      disabled,
      isProcessing,
      minHeight,
      maxHeight,
      autoFocus,
      conversationId,
      currentUserPrivilege,
      isGroupChat,
      onSubmitUserOnly,
      onTypingChange,
      webSearchEnabled,
      modelSupportsSearch,
      isAuthenticated,
      onToggleWebSearch,
      isEditing,
      onCancelEdit,
    } = { ...PROMPT_INPUT_DEFAULTS, ...rawProps };
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const [aiEnabled, setAiEnabled] = React.useState(true);
    const lastTypingSentRef = React.useRef(0);
    const onTypingChangeRef = React.useRef(onTypingChange);
    onTypingChangeRef.current = onTypingChange;

    React.useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

    React.useEffect(() => {
      if (!autoFocus) return;
      const id = requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(id);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    React.useEffect(() => {
      return () => {
        onTypingChangeRef.current?.(false);
      };
    }, []);

    const { isAppStable } = useStability();
    const budget = usePromptBudget({
      value,
      historyCharacters,
      capabilities,
      ...(conversationId != null && { conversationId }),
      ...(currentUserPrivilege !== undefined && { currentUserPrivilege }),
    });

    const canSubmit = canSubmitMessage({
      hasContent: budget.hasContent,
      isOverCapacity: budget.isOverCapacity,
      hasBlockingError: budget.hasBlockingError,
      disabled,
      isProcessing,
    });

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const newValue = e.target.value;
      onChange(newValue);
      emitTypingChange(newValue, onTypingChange, lastTypingSentRef);
    };

    const handleSubmit = (): void => {
      onTypingChange?.(false);
      lastTypingSentRef.current = 0;
      if (!aiEnabled && onSubmitUserOnly) {
        onSubmitUserOnly();
      } else if (budget.fundingSource !== 'denied') {
        onSubmit(budget.fundingSource);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (isSubmitKeyEvent(e) && canSubmit) {
        onTypingChange?.(false);
        lastTypingSentRef.current = 0;
        if (!aiEnabled && onSubmitUserOnly) {
          e.preventDefault();
          onSubmitUserOnly();
        } else if (budget.fundingSource !== 'denied') {
          e.preventDefault();
          onSubmit(budget.fundingSource);
        }
      }
    };

    return (
      <div className={cn('w-full', className)}>
        <div className="border-border-strong bg-background dark:border-input flex flex-col rounded-md border">
          {isEditing && (
            <div className="border-border flex items-center justify-between border-b px-3 py-2">
              <div className="flex items-center gap-1.5 text-sm">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Editing message</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancelEdit}
                aria-label="Cancel"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Cancel
              </Button>
            </div>
          )}
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

            <div className="flex items-center gap-1">
              {modelSupportsSearch !== undefined && isAuthenticated !== undefined && (
                <SearchToggleButton
                  webSearchEnabled={webSearchEnabled ?? false}
                  modelSupportsSearch={modelSupportsSearch}
                  isAuthenticated={isAuthenticated}
                  onToggle={onToggleWebSearch}
                />
              )}

              {isGroupChat && (
                <AIToggleButton
                  aiEnabled={aiEnabled}
                  onToggle={() => {
                    setAiEnabled((previous) => !previous);
                  }}
                />
              )}

              <Button
                type="button"
                size="icon"
                onClick={handleSubmit}
                disabled={!canSubmit}
                aria-label={BUTTON_ARIA_LABELS[String(canSubmit) as 'true' | 'false']}
                data-testid="send-button"
              >
                <SubmitButtonIcon isProcessing={isProcessing} />
              </Button>
            </div>
          </div>
        </div>

        <StableContent isStable={isAppStable}>
          <BudgetMessages errors={budget.notifications} className="mt-2" />
        </StableContent>
      </div>
    );
  }
);

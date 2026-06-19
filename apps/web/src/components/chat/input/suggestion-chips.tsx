import * as React from 'react';
import { Dices, type LucideIcon } from 'lucide-react';
import { Button, cn } from '@hushbox/ui';
import { getSecureRandomIndex, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { getSuggestionsForModality } from '@/lib/prompt-suggestions';
import { useModelStore } from '@/stores/model';
import { IconMorph } from '@/components/shared/icon-morph';
import { MorphWidth } from '@/components/shared/morph-width';
import { TypingAnimation } from '@/components/chat/indicators/typing-animation';

interface SuggestionChipsProps {
  onSelect: (prompt: string) => void;
  showSurpriseMe?: boolean;
  className?: string;
}

interface SlotData {
  iconKey: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant: 'outline' | 'secondary';
}

interface ChipSlotProps {
  index: number;
  slot: SlotData;
}

function ChipSlot({ index, slot }: Readonly<ChipSlotProps>): React.JSX.Element {
  return (
    <Button
      variant={slot.variant}
      size="sm"
      onClick={slot.onClick}
      className="gap-2 rounded-full"
      data-testid={TEST_ID_BUILDERS.suggestionSlot(index)}
      aria-label={slot.label}
    >
      <IconMorph icon={slot.icon} iconKey={slot.iconKey} data-testid={TEST_IDS.iconMorph} />
      <MorphWidth duration={0.7} data-testid={TEST_IDS.morphWidth}>
        <TypingAnimation text={slot.label} loop={false} skipInitialTyping />
      </MorphWidth>
    </Button>
  );
}

/**
 * Chip-style quick-prompt buttons rendered below the new-chat input.
 *
 * Slot positions are stable across modality switches: when the active modality
 * changes, the same five button DOM nodes persist; only their inner icon
 * (via [[IconMorph]]) and label (via [[TypingAnimation]]) cross-fade and
 * type-and-delete into the new content. The outer container does not wrap the
 * row in AnimatePresence, so the buttons themselves never unmount and remount.
 */
export function SuggestionChips({
  onSelect,
  showSurpriseMe = false,
  className,
}: Readonly<SuggestionChipsProps>): React.JSX.Element {
  const activeModality = useModelStore((state) => state.activeModality);
  const suggestions = getSuggestionsForModality(activeModality);

  const handleCategoryClick = React.useCallback(
    (prompts: readonly string[]) => {
      if (prompts.length === 0) return;
      const index = getSecureRandomIndex(prompts.length);
      const prompt = prompts[index];
      if (prompt) onSelect(prompt);
    },
    [onSelect]
  );

  const handleSurpriseMe = React.useCallback(() => {
    const pool = suggestions.flatMap((s) => s.prompts);
    if (pool.length === 0) return;
    const index = getSecureRandomIndex(pool.length);
    const prompt = pool[index];
    if (prompt) onSelect(prompt);
  }, [suggestions, onSelect]);

  const slots: SlotData[] = React.useMemo(() => {
    const built: SlotData[] = suggestions.map((s) => ({
      iconKey: s.id,
      icon: s.icon,
      label: s.label,
      onClick: () => {
        handleCategoryClick(s.prompts);
      },
      variant: 'outline' as const,
    }));
    if (showSurpriseMe) {
      built.push({
        iconKey: 'surprise-me',
        icon: Dices,
        label: 'Surprise Me',
        onClick: handleSurpriseMe,
        variant: 'secondary' as const,
      });
    }
    return built;
  }, [suggestions, showSurpriseMe, handleCategoryClick, handleSurpriseMe]);

  const firstRowSlots = slots.slice(0, 3);
  const secondRowSlots = slots.slice(3);

  return (
    <div
      data-testid={TEST_IDS.suggestionChips}
      className={cn('flex flex-col items-center gap-2', className)}
    >
      <div
        data-testid={TEST_IDS.suggestionChipsRow}
        className="flex flex-wrap items-center justify-center gap-2"
      >
        {firstRowSlots.map((slot, index) => (
          // Slot identity is positional, not content-based: slot N must be the
          // same DOM node across modality switches so IconMorph and the label
          // animations run instead of an unmount/remount.
          <ChipSlot key={index} index={index} slot={slot} />
        ))}
      </div>
      {secondRowSlots.length > 0 && (
        <div
          data-testid={TEST_IDS.suggestionChipsRow}
          className="flex flex-wrap items-center justify-center gap-2"
        >
          {secondRowSlots.map((slot, offset) => {
            const index = offset + 3;
            return <ChipSlot key={index} index={index} slot={slot} />;
          })}
        </div>
      )}
    </div>
  );
}

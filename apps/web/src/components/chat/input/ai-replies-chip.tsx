import * as React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui';
import { Bot, MessageSquare } from '@hushbox/ui/icons';
import { Chip } from '@/components/shared/chip';
import { usePressTooltip } from './use-press-tooltip';

const ICON_ONLY =
  '@max-composer-ai-icon/composer:w-8 @max-composer-ai-icon/composer:px-0 @max-composer-ai-icon/composer:justify-center';

/**
 * A group composer's toggle for whether the AI answers the next message: pressed while it
 * will. It reads "AI replies", "AI" on a composer under 34rem, and the icon alone under 24rem,
 * so the model chip keeps its short name. A press also opens its tooltip, so a touch screen,
 * which never hovers, still names what the icon-only chip does.
 */
export function AiRepliesChip({
  enabled,
  onToggle,
}: Readonly<{ enabled: boolean; onToggle: () => void }>): React.JSX.Element {
  const tooltip = usePressTooltip(onToggle);
  return (
    <Tooltip {...tooltip.root}>
      <TooltipTrigger asChild>
        <Chip
          icon={enabled ? Bot : MessageSquare}
          aria-label="AI replies to this message"
          pressed={enabled}
          className={ICON_ONLY}
          {...tooltip.trigger}
        >
          <span className="@max-composer-compact/composer:hidden">AI replies</span>
          <span
            aria-hidden="true"
            className="@max-composer-compact/composer:inline @max-composer-ai-icon/composer:hidden hidden"
          >
            AI
          </span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent side="top">
        {enabled ? 'Turn off AI replies' : 'Turn on AI replies'}
      </TooltipContent>
    </Tooltip>
  );
}

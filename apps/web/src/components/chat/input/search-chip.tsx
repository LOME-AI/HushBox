import * as React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui';
import { Globe } from '@hushbox/ui/icons';
import { Chip } from '@/components/shared/chip';
import { usePressTooltip } from './use-press-tooltip';

/** Why a visitor cannot search, on the chip's tooltip and on the narrow composer's menu row. */
export const SEARCH_VISITOR_REASON = 'Sign up to access internet search';

function searchTooltipText(canUse: boolean, webSearchEnabled: boolean): string {
  if (!canUse) return SEARCH_VISITOR_REASON;
  return webSearchEnabled ? 'Turn off internet search' : 'Turn on internet search';
}

interface SearchChipProps {
  readonly webSearchEnabled: boolean;
  readonly canUse: boolean;
  readonly onToggle: () => void;
}

/**
 * The composer's web-search toggle: pressed while search is on, dashed and refusing while the
 * viewer may not search. A press also opens its tooltip, so a touch screen, which never hovers,
 * still shows a visitor why the chip refuses.
 */
export function SearchChip({
  webSearchEnabled,
  canUse,
  onToggle,
}: Readonly<SearchChipProps>): React.JSX.Element {
  const tooltip = usePressTooltip(onToggle);
  const tooltipText = searchTooltipText(canUse, webSearchEnabled);
  return (
    <Tooltip {...tooltip.root}>
      <TooltipTrigger asChild>
        <Chip
          icon={Globe}
          label="Search"
          aria-label={canUse ? tooltipText : 'Internet search unavailable'}
          {...(canUse && { pressed: webSearchEnabled })}
          disabled={!canUse}
          {...tooltip.trigger}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

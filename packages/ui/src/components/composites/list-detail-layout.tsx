import * as React from 'react';

import { useHotkeys } from '../../hooks/use-hotkeys';
import { cn } from '../../lib/utilities';

/** The neighbour of `currentId`, clamped at both ends of the loaded ids. */
function stepSelection(
  itemIds: readonly string[],
  currentId: string | null,
  direction: 1 | -1
): string | null {
  const index = currentId === null ? -1 : itemIds.indexOf(currentId);
  const next = itemIds[Math.min(itemIds.length - 1, Math.max(0, index + direction))];
  return next ?? currentId;
}

/**
 * A list with a detail panel beside it: the panel is a region rather than a
 * modal, so the list stays visible and arrow keys keep moving the selection
 * while it is open.
 */
function ListDetailLayout({
  itemIds,
  selectedId,
  onSelect,
  list,
  detail,
  detailLabel,
  detailTestId,
  className,
  ...props
}: Readonly<
  // A div carries a native `onSelect` handler; without the omit the selection
  // callback intersects with it instead of replacing it.
  Omit<React.ComponentProps<'div'>, 'onSelect'> & {
    /** The selectable ids, in the order they are listed. */
    itemIds: readonly string[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    list: React.ReactNode;
    /** Absent closes the detail panel and its keyboard handling with it. */
    detail?: React.ReactNode | undefined;
    /** Accessible name for the detail region. */
    detailLabel: string;
    detailTestId?: string | undefined;
  }
>): React.JSX.Element {
  const step = React.useCallback(
    (direction: 1 | -1) => {
      onSelect(stepSelection(itemIds, selectedId, direction));
    },
    [itemIds, selectedId, onSelect]
  );

  useHotkeys(
    [
      {
        combo: 'arrowdown',
        description: 'Next item',
        onTrigger: () => {
          step(1);
        },
      },
      {
        combo: 'arrowup',
        description: 'Previous item',
        onTrigger: () => {
          step(-1);
        },
      },
      {
        combo: 'escape',
        description: 'Close the detail',
        onTrigger: () => {
          onSelect(null);
        },
      },
    ],
    { enabled: detail !== undefined }
  );

  return (
    <div data-slot="list-detail-layout" className={cn('flex flex-col gap-4', className)} {...props}>
      {list}
      {detail === undefined ? null : (
        <aside
          data-slot="list-detail-detail"
          data-testid={detailTestId}
          aria-label={detailLabel}
          className="border-border bg-background fixed inset-y-0 right-0 z-40 flex w-96 max-w-full flex-col gap-3 overflow-y-auto border-l p-4 shadow-lg"
        >
          {detail}
        </aside>
      )}
    </div>
  );
}

export { ListDetailLayout };

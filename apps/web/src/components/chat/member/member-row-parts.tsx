import { TEST_ID_BUILDERS } from '@hushbox/shared';
import type * as React from 'react';
import type { MoneyFigure } from '@/lib/chat/member-money';

/** A member or link row: the avatar or link disc, the body, then the options button. */
export const ROW_CLASS = 'flex min-h-13 min-w-0 items-center gap-2.5 py-1.5';

/**
 * The name and sub-line beside the money. The name gives way first; once it is down to its
 * floor, as with large text on a phone, the money drops under it rather than cut it further.
 */
export const ROW_BODY_CLASS = 'flex min-w-0 flex-auto flex-wrap items-center justify-end gap-x-2.5';
export const ROW_MAIN_CLASS = 'flex min-w-24 flex-[1_1_0] flex-col';
export const ROW_SUB_CLASS = 'text-caption text-muted-foreground';
export const ROW_OPTIONS_CLASS = 'text-muted-foreground -mr-1.5 shrink-0';

/** A privilege as the row's sub-line reads it: "Write", not "write". */
export function privilegeWord(privilege: string): string {
  return `${privilege.charAt(0).toUpperCase()}${privilege.slice(1)}`;
}

/** A member's or a link guest's figure at the row's end; it never shrinks. */
export function MoneyColumn({
  entityId,
  figure,
}: Readonly<{ entityId: string; figure: MoneyFigure }>): React.JSX.Element {
  return (
    <span
      data-testid={TEST_ID_BUILDERS.memberMoney(entityId)}
      className="flex shrink-0 flex-col items-end text-right"
    >
      <span className="text-num text-foreground font-mono tabular-nums">{figure.amount}</span>
      <span className="text-caption text-muted-foreground whitespace-nowrap">{figure.caption}</span>
    </span>
  );
}

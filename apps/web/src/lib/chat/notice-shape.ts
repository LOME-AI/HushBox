import { AlertTriangle, CircleAlert, Hourglass, Info } from '@hushbox/ui/icons';
import type { BudgetError } from '@hushbox/shared';
import type { NoticeTone } from '@hushbox/ui/notice';
import type * as React from 'react';

/**
 * The icon's shape, which names a notice's severity without its colour. The composer's
 * stack and a turn's notice in the thread draw the same refusal, so both read it here.
 */
export type NoticeShape = 'hourglass' | 'circle' | 'triangle' | 'info';

export const NOTICE_SHAPES: Readonly<
  Record<NoticeShape, { tone: NoticeTone; icon: React.ComponentType<{ className?: string }> }>
> = {
  hourglass: { tone: 'error', icon: Hourglass },
  circle: { tone: 'error', icon: CircleAlert },
  triangle: { tone: 'warning', icon: AlertTriangle },
  info: { tone: 'info', icon: Info },
};

/** A block that clears on its own waits; any other block asks the user to act. */
export function blockShape(clears: BudgetError['blockClears']): 'hourglass' | 'circle' {
  return clears === 'on_its_own' ? 'hourglass' : 'circle';
}

export function composerNoticeShape(notice: BudgetError): NoticeShape {
  if (notice.type === 'warning') return 'triangle';
  if (notice.type === 'info') return 'info';
  return blockShape(notice.blockClears);
}

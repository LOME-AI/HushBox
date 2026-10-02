'use client';

import * as React from 'react';
import { cn } from '../../lib/utilities';
import { useOverlayChrome } from './overlay-chrome';
import { useOverlayPresentation } from './overlay-presentation';

const SIZE_MAP = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
} as const;

// Cap height to the viewport and scroll internally so content taller than the screen never
// pushes actions out of reach.
const DIALOG_CLASS =
  'bg-background flex max-h-[calc(100dvh-2rem)] w-[90vw] flex-col gap-4 overflow-y-auto rounded-lg border p-6 text-pretty shadow-lg';

const SHEET_CLASS =
  'bg-background flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-3 pb-6 text-pretty';

// Merged after the caller's classes: a sheet or a full-screen dialog spans the viewport's width
// whatever width the caller gave the dialog.
const SHEET_SPAN_CLASS = 'w-full max-w-none rounded-t-xl border-0 shadow-none';

const FULLSCREEN_SPAN_CLASS =
  'h-full max-h-none w-full max-w-none rounded-none border-0 shadow-none';

export interface OverlayContentProps {
  children: React.ReactNode;
  /** Size variant controlling a dialog's max-width. Defaults to 'md'. */
  size?: keyof typeof SIZE_MAP;
  /** Makes a sheet 90dvh tall. */
  tall?: boolean;
  /** Where a dialog sits from 768px: centred, or near the top of the viewport. */
  placement?: 'center' | 'top';
  className?: string;
  'data-testid'?: string;
}

function contentClass(
  presentation: ReturnType<typeof useOverlayPresentation>,
  fullscreen: boolean,
  { size = 'md', tall = false, className }: Readonly<OverlayContentProps>
): string {
  if (presentation === 'sheet') {
    return cn(SHEET_CLASS, tall && 'h-[90dvh]', className, SHEET_SPAN_CLASS);
  }
  if (fullscreen) return cn(DIALOG_CLASS, className, FULLSCREEN_SPAN_CLASS);
  return cn(DIALOG_CLASS, SIZE_MAP[size], className);
}

/**
 * The overlay's panel. It draws the chrome of the presentation it sits in, however deep a
 * caller's own elements place it: a bordered, shadowed dialog, or a sheet that spans the
 * viewport. Outside an overlay it draws the dialog chrome.
 */
export function OverlayContent(props: Readonly<OverlayContentProps>): React.JSX.Element {
  const { children, placement = 'center', 'data-testid': testId } = props;
  const presentation = useOverlayPresentation();
  const chrome = useOverlayChrome();
  const claimTopPlacement = chrome?.claimTopPlacement;

  React.useLayoutEffect(
    () => (placement === 'top' ? claimTopPlacement?.() : undefined),
    [claimTopPlacement, placement]
  );

  return (
    <div
      className={contentClass(presentation, chrome?.fullscreen === true, props)}
      {...(testId !== undefined && { 'data-testid': testId })}
    >
      {children}
    </div>
  );
}

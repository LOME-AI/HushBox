'use client';

import * as React from 'react';
import { ArrowLeftIcon } from 'lucide-react';

import { cn } from '../../lib/utilities';
import { HIT_AREA_CLASSES } from '../button/icon-button';

// The coarse target comes first so the corner's `absolute` outranks its `relative`: an absolute
// box anchors the target as a relative one does.
const NAV_BUTTON_CLASS = cn(
  HIT_AREA_CLASSES.extend,
  'absolute z-10 inline-flex size-7 cursor-pointer items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4'
);

const BACK_BUTTON_CLASS = cn(NAV_BUTTON_CLASS, 'top-5 left-3');
const CLOSE_BUTTON_CLASS = cn(NAV_BUTTON_CLASS, 'top-5 right-3');

interface OverlayNavButtonsProps {
  showBackButton: boolean;
  onBack?: (() => void) | undefined;
  closeElement: React.ReactNode | null;
}

function OverlayNavButtons({
  showBackButton,
  onBack,
  closeElement,
}: Readonly<OverlayNavButtonsProps>): React.JSX.Element | null {
  if (!showBackButton && !closeElement) return null;

  return (
    <>
      {showBackButton && (
        <button type="button" onClick={onBack} className={BACK_BUTTON_CLASS}>
          <ArrowLeftIcon />
          <span className="sr-only">Back</span>
        </button>
      )}
      {closeElement}
    </>
  );
}

export { OverlayNavButtons, CLOSE_BUTTON_CLASS };

'use client';

import * as React from 'react';
import { ArrowLeftIcon } from 'lucide-react';

import { cn } from '../lib/utilities';

const NAV_BUTTON_CLASS =
  'ring-offset-background focus:ring-ring absolute z-10 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4';

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

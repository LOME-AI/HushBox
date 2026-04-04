'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';

import { cn } from '../lib/utilities';
import type { OverlayProps } from './overlay';
import { OverlayNavButtons, CLOSE_BUTTON_CLASS } from './overlay-nav-buttons';

/**
 * Dialog renderer for Overlay — centered modal with blur backdrop.
 * Used on desktop (non-touch) devices.
 */
function OverlayDialog({
  open,
  onOpenChange,
  children,
  className,
  ariaLabel,
  onOpenAutoFocus,
  showCloseButton = true,
  currentStep,
  onBack,
}: Readonly<OverlayProps>): React.JSX.Element {
  const showBackButton = currentStep !== undefined && currentStep > 1 && onBack !== undefined;

  const closeElement = showCloseButton ? (
    <DialogPrimitive.Close data-slot="overlay-close" className={CLOSE_BUTTON_CLASS}>
      <XIcon />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  ) : null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="overlay-backdrop"
          data-testid="overlay-backdrop"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm'
          )}
        />
        <DialogPrimitive.Content
          data-slot="overlay-content"
          data-testid="overlay-content"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'fixed top-[50%] left-[50%] z-50 translate-x-[-50%] translate-y-[-50%] pt-2 outline-none',
            className
          )}
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <DialogPrimitive.Title className="sr-only">{ariaLabel}</DialogPrimitive.Title>
          <OverlayNavButtons
            showBackButton={showBackButton}
            onBack={onBack}
            closeElement={closeElement}
          />
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { OverlayDialog };

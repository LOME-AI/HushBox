'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeftIcon, XIcon } from 'lucide-react';

import { cn } from '../lib/utilities';

interface ModalOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  /** Accessible label for screen readers. Required for accessibility. */
  ariaLabel: string;
  /** Callback when modal opens before auto-focus. Prevent default to disable auto-focus. */
  onOpenAutoFocus?: (event: Event) => void;
  /** Whether to show the close button. Defaults to true. */
  showCloseButton?: boolean;
  /** Current step in a multi-step flow. If > 1, shows back button. */
  currentStep?: number;
  /** Called when back button is clicked. Required for back button to show. */
  onBack?: () => void;
}

/**
 * Reusable modal overlay component with blur backdrop.
 * Centers content on screen with click-outside-to-close and Escape key support.
 */
function ModalOverlay({
  open,
  onOpenChange,
  children,
  className,
  ariaLabel,
  onOpenAutoFocus,
  showCloseButton = true,
  currentStep,
  onBack,
}: Readonly<ModalOverlayProps>): React.JSX.Element {
  const showBackButton = currentStep !== undefined && currentStep > 1 && onBack !== undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="modal-overlay-backdrop"
          data-testid="modal-overlay-backdrop"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm'
          )}
        />
        <DialogPrimitive.Content
          data-slot="modal-overlay-content"
          data-testid="modal-overlay-content"
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'fixed top-[50%] left-[50%] z-50 translate-x-[-50%] translate-y-[-50%] pt-2 outline-none',
            className
          )}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <DialogPrimitive.Title className="sr-only">{ariaLabel}</DialogPrimitive.Title>
          {showBackButton && (
            <button
              type="button"
              onClick={onBack}
              className="ring-offset-background focus:ring-ring absolute top-5 left-3 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <ArrowLeftIcon />
              <span className="sr-only">Back</span>
            </button>
          )}
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="modal-overlay-close"
              className="ring-offset-background focus:ring-ring absolute top-5 right-3 cursor-pointer rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { ModalOverlay };
export type { ModalOverlayProps };

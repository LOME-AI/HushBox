'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';

import { cn } from '../../lib/utilities';
import { revealFocusAfterCancelledTab } from '../../lib/reveal-focus-after-tab';
import { OverlayNavButtons, CLOSE_BUTTON_CLASS } from './overlay-nav-buttons';
import { OverlayTitleProvider } from './overlay-title';
import { usePortalContainer } from '../primitives/portal-container';
import {
  OverlayBackButtonContext,
  OverlayDescriptionContext,
  useOverlayDescriber,
} from './overlay-header';
import { wrapShiftTabFromContainer } from './overlay-focus-wrap';
import { SCRIM_BASE_CLASS, SCRIM_BLUR_CLASS } from './scrim';
import { OverlayChromeContext, useDialogChrome } from './overlay-chrome';
import type { OverlayRendererProps } from './overlay';

interface OverlayDialogProps extends OverlayRendererProps {
  /** Skips open autofocus, and `initialFocus` with it, so a coarse pointer raises no soft keyboard. */
  suppressAutoFocus?: boolean;
  /** Fills the viewport, the phone presentation a caller can ask for in place of a sheet. */
  fullscreen?: boolean;
  /**
   * The element the dialog portals into; else the nearest `PortalContainerProvider`'s element,
   * else the document body.
   */
  container?: React.ComponentProps<typeof DialogPrimitive.Portal>['container'];
}

const ANIMATION_CLASS =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

// A fixed, translate-centered dialog cannot be window-scrolled, so it caps its own height and
// scrolls internally — otherwise content taller than the viewport pushes its actions
// off-screen unreachably. Its 0.5rem top padding sits above the content's own panel.
const POSITION_CLASS = {
  center:
    'fixed top-[50%] left-[50%] max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] overflow-y-auto pt-2',
  top: 'fixed top-[calc(12vh-0.5rem)] left-[50%] max-h-[calc(88dvh-1rem)] translate-x-[-50%] translate-y-0 overflow-y-auto pt-2',
  fullscreen: 'fixed inset-0 h-dvh w-full overflow-y-auto',
} as const;

/** Dialog renderer for Overlay: a centred modal over the scrim, from 768px wide. */
function OverlayDialog({
  open,
  onOpenChange,
  children,
  className,
  ariaLabel,
  onOpenAutoFocus,
  initialFocus,
  showCloseButton = true,
  currentStep,
  onBack,
  dismissible = true,
  returnFocus,
  role,
  suppressAutoFocus = false,
  fullscreen = false,
  container,
}: Readonly<OverlayDialogProps>): React.JSX.Element {
  const showBackButton = currentStep !== undefined && currentStep > 1 && onBack !== undefined;
  // When undismissible, suppress the close button entirely — leaving it visible
  // while it does nothing would be a UI lie.
  const renderCloseButton = showCloseButton && dismissible;
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { chrome, placement } = useDialogChrome(fullscreen);
  const { describer, describedByProps } = useOverlayDescriber(DialogPrimitive.Description);

  // A consumer skips open autofocus to keep a soft keyboard down. Focus the dialog itself then:
  // it is no field, and holding focus inside is what keeps Tab in the dialog's focus trap.
  const handleOpenAutoFocus = (event: Event): void => {
    if (suppressAutoFocus) event.preventDefault();
    onOpenAutoFocus?.(event);
    if (event.defaultPrevented) {
      contentRef.current?.focus({ preventScroll: true });
      return;
    }
    // Radix pauses any outer focus trap, such as an open menu's, before this event, so focus
    // set here holds where React's `autoFocus` is undone.
    const target = initialFocus?.current;
    if (target) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
  };

  const closeElement = renderCloseButton ? (
    <DialogPrimitive.Close data-slot="overlay-close" className={CLOSE_BUTTON_CLASS}>
      <XIcon />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  ) : null;

  const preventDismiss = (event: Event): void => {
    if (!dismissible) event.preventDefault();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={usePortalContainer(container)}>
        <DialogPrimitive.Overlay
          data-slot="overlay-backdrop"
          data-testid={TEST_IDS.overlayBackdrop}
          className={cn(
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'z-modal',
            SCRIM_BASE_CLASS,
            SCRIM_BLUR_CLASS
          )}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          data-slot="overlay-content"
          data-testid={TEST_IDS.overlayContent}
          data-overlay-variant="dialog"
          className={cn(
            ANIMATION_CLASS,
            'z-modal outline-none',
            POSITION_CLASS[placement],
            className
          )}
          {...(role !== undefined && { role })}
          {...describedByProps}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={returnFocus}
          onKeyDown={(event) => {
            wrapShiftTabFromContainer(event);
            revealFocusAfterCancelledTab(event);
          }}
          onEscapeKeyDown={preventDismiss}
          onPointerDownOutside={preventDismiss}
          onInteractOutside={preventDismiss}
        >
          <OverlayTitleProvider Title={DialogPrimitive.Title} ariaLabel={ariaLabel}>
            <OverlayChromeContext value={chrome}>
              <OverlayNavButtons
                showBackButton={showBackButton}
                onBack={onBack}
                closeElement={closeElement}
              />
              <OverlayDescriptionContext value={describer}>
                <OverlayBackButtonContext value={showBackButton}>
                  {children}
                </OverlayBackButtonContext>
              </OverlayDescriptionContext>
            </OverlayChromeContext>
          </OverlayTitleProvider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { OverlayDialog };

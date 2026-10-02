'use client';

import * as React from 'react';
import { Drawer } from 'vaul';
import { XIcon } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';

import { cn } from '../../lib/utilities';
import { revealFocusAfterCancelledTab } from '../../lib/reveal-focus-after-tab';
import { useVisualViewportHeight } from '../../hooks/use-visual-viewport-height';
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
import type { OverlayRendererProps } from './overlay';

interface OverlayBottomSheetProps extends OverlayRendererProps {
  /**
   * The element the sheet portals into; else the nearest `PortalContainerProvider`'s element,
   * else the document body.
   */
  container?: React.ComponentProps<typeof Drawer.Portal>['container'];
}

/** Bottom sheet renderer for Overlay: a slide-up drawer with drag-to-dismiss, below 768px wide. */
function OverlayBottomSheet({
  open,
  onOpenChange,
  children,
  className,
  ariaLabel,
  onOpenAutoFocus,
  showCloseButton = true,
  currentStep,
  onBack,
  dismissible = true,
  returnFocus,
  role,
  container,
}: Readonly<OverlayBottomSheetProps>): React.JSX.Element {
  const showBackButton = currentStep !== undefined && currentStep > 1 && onBack !== undefined;
  // Hide close button + drag handle together when undismissible: the drag
  // handle implies swipe-to-dismiss (which vaul disables via `dismissible`),
  // and a visible close button you can't use is a UI lie.
  const renderCloseButton = showCloseButton && dismissible;
  const viewportHeight = useVisualViewportHeight();
  const contentRef = React.useRef<HTMLDivElement>(null);
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const { describer, describedByProps } = useOverlayDescriber(Drawer.Description);

  // Radix's open autofocus lands on the first tabbable, which may be a field that raises the
  // soft keyboard. Focus the sheet itself instead: it is no field, and holding focus inside
  // is what keeps Tab in the sheet's focus trap. The consumer's handler still runs.
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      event.preventDefault();
      onOpenAutoFocus?.(event);
      sheetRef.current?.focus({ preventScroll: true });
    },
    [onOpenAutoFocus]
  );

  // Scroll focused input into view when keyboard opens inside the sheet.
  React.useEffect(() => {
    const container = contentRef.current;
    if (!container || !open) return;

    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        // Delay to let keyboard open/close animation settle
        const KEYBOARD_ANIMATION_MS = 300;
        setTimeout(() => {
          target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, KEYBOARD_ANIMATION_MS);
      }
    };

    container.addEventListener('focusin', handleFocusIn);
    return () => {
      container.removeEventListener('focusin', handleFocusIn);
    };
  }, [open]);

  // When the keyboard is open, visualViewport shrinks below the CSS 90dvh.
  // Apply a JS override only in that case; otherwise let CSS dvh handle it.
  const isKeyboardOpen = viewportHeight < window.innerHeight * 0.8;
  const keyboardStyle = isKeyboardOpen ? { maxHeight: viewportHeight * 0.9 } : undefined;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} dismissible={dismissible}>
      <Drawer.Portal container={usePortalContainer(container)}>
        <Drawer.Overlay
          data-slot="overlay-backdrop"
          data-testid={TEST_IDS.overlayBackdrop}
          className={cn(
            'z-modal',
            SCRIM_BASE_CLASS,
            SCRIM_BLUR_CLASS,
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        />
        <Drawer.Content
          ref={sheetRef}
          data-slot="overlay-content"
          data-testid={TEST_IDS.overlayContent}
          data-overlay-variant="bottom-sheet"
          className={cn(
            'bg-background z-modal fixed inset-x-0 bottom-0 flex max-h-[90dvh] flex-col rounded-t-xl outline-none',
            className
          )}
          style={keyboardStyle}
          {...(role !== undefined && { role })}
          {...describedByProps}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={returnFocus}
          onKeyDown={(event) => {
            wrapShiftTabFromContainer(event);
            revealFocusAfterCancelledTab(event);
          }}
        >
          <OverlayTitleProvider Title={Drawer.Title} ariaLabel={ariaLabel}>
            {/* Drag handle — implies swipe-to-dismiss, so hide it when vaul's
              `dismissible={false}` disables that affordance. */}
            {dismissible && (
              <div className="flex shrink-0 justify-center pt-3 pb-1">
                <div className="bg-muted-foreground/30 h-1 w-10 rounded-full" />
              </div>
            )}

            {/* Unpositioned, so the nav buttons sit against the sheet's own top edge. It scrolls
              whatever the content cannot shrink to fit, such as a caller's wrapper element. */}
            <div
              ref={contentRef}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-2 pb-[env(safe-area-inset-bottom,0px)]"
            >
              <OverlayNavButtons
                showBackButton={showBackButton}
                onBack={onBack}
                closeElement={
                  renderCloseButton ? (
                    <Drawer.Close data-slot="overlay-close" className={CLOSE_BUTTON_CLASS}>
                      <XIcon />
                      <span className="sr-only">Close</span>
                    </Drawer.Close>
                  ) : null
                }
              />
              {/* The content draws its own sheet chrome from the presentation. */}
              <div className="flex min-h-0 flex-1 flex-col">
                <OverlayDescriptionContext value={describer}>
                  <OverlayBackButtonContext value={showBackButton}>
                    {children}
                  </OverlayBackButtonContext>
                </OverlayDescriptionContext>
              </div>
            </div>
          </OverlayTitleProvider>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export { OverlayBottomSheet };

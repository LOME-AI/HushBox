'use client';

import * as React from 'react';
import { Drawer } from 'vaul';
import { XIcon } from 'lucide-react';

import { cn } from '../lib/utilities';
import { useVisualViewportHeight } from '../hooks/use-visual-viewport-height';
import type { OverlayProps } from './overlay';
import { OverlayNavButtons, CLOSE_BUTTON_CLASS } from './overlay-nav-buttons';

/**
 * Bottom sheet renderer for Overlay — slide-up drawer with drag-to-dismiss.
 * Used on touch devices (phones, tablets).
 */
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
}: Readonly<OverlayProps>): React.JSX.Element {
  const showBackButton = currentStep !== undefined && currentStep > 1 && onBack !== undefined;
  const viewportHeight = useVisualViewportHeight();
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Suppress auto-focus on bottom sheets to avoid keyboard popup on open.
  // Still call consumer's handler so they can do custom logic.
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      event.preventDefault();
      onOpenAutoFocus?.(event);
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
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay
          data-slot="overlay-backdrop"
          data-testid="overlay-backdrop"
          className={cn(
            'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
        />
        <Drawer.Content
          data-slot="overlay-content"
          data-testid="overlay-content"
          data-overlay-variant="bottom-sheet"
          className={cn(
            'bg-background fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-xl outline-none',
            className
          )}
          style={keyboardStyle}
          aria-describedby={undefined}
          onOpenAutoFocus={handleOpenAutoFocus}
        >
          <Drawer.Title className="sr-only">{ariaLabel}</Drawer.Title>

          {/* Drag handle */}
          <div className="flex shrink-0 justify-center pt-3 pb-1">
            <div className="bg-muted-foreground/30 h-1 w-10 rounded-full" />
          </div>

          {/* Content wrapper — pt-2 matches DialogPrimitive.Content padding so buttons align identically */}
          <div
            ref={contentRef}
            className="relative min-h-0 flex-1 overflow-hidden pt-2 pb-[env(safe-area-inset-bottom,0px)]"
          >
            <OverlayNavButtons
              showBackButton={showBackButton}
              onBack={onBack}
              closeElement={
                showCloseButton ? (
                  <Drawer.Close data-slot="overlay-close" className={CLOSE_BUTTON_CLASS}>
                    <XIcon />
                    <span className="sr-only">Close</span>
                  </Drawer.Close>
                ) : null
              }
            />
            {/* Child content — full-width override for children that set their own w-[90vw] */}
            <div className="size-full [&>*]:max-h-full [&>*]:w-full [&>*]:max-w-none [&>*]:rounded-none [&>*]:border-x-0 [&>*]:border-b-0 [&>*]:shadow-none">
              {children}
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export { OverlayBottomSheet };

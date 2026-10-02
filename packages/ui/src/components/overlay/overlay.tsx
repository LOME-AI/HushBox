'use client';

import * as React from 'react';

import { useFormFactor } from '../platform/use-form-factor';
import { OverlayDialog } from './overlay-dialog';
import { OverlayBottomSheet } from './overlay-bottom-sheet';
import { OverlayPresentationContext, type OverlayPresentation } from './overlay-presentation';
import { useOverlayFocusReturn } from './overlay-focus-return';
import { useOpenedValue } from './open-state';

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  /**
   * Names the overlay only while it shows no heading. An `OverlayHeader` or
   * `OverlayTitle` in the children takes the name over, so a modal with a visible
   * title announces that title and never this string.
   */
  ariaLabel: string;
  /**
   * Called as the overlay opens, before its autofocus; prevent default to skip that autofocus.
   * A sheet, or a dialog under a coarse pointer, skips it regardless and still calls this.
   */
  onOpenAutoFocus?: (event: Event) => void;
  /**
   * Called as the overlay closes, in place of its own focus return (to the opener, else its
   * menu's button, else the main landmark), for a caller that returns focus by a rule of its own.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /**
   * The element the dialog focuses when it opens, in place of React's `autoFocus`, which a
   * menu's focus trap undoes when a menu item opens the dialog. A bottom sheet, and a dialog
   * under a coarse pointer, ignore it and focus themselves, so no soft keyboard rises.
   */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Whether to show the close button. Defaults to true. */
  showCloseButton?: boolean;
  /** Current step in a multi-step flow. If > 1, shows back button. */
  currentStep?: number;
  /** Called when back button is clicked. Required for back button to show. */
  onBack?: () => void;
  /**
   * When false, blocks every user-initiated dismissal: Escape, backdrop click,
   * mobile swipe-to-dismiss, the close button (which is hidden), and the
   * mobile drag handle (also hidden). The back button is preserved — back is
   * navigation, not dismissal. Defaults to true. Use this while an in-flight
   * action owns the modal (e.g. `ActionModal` flips it during isPending).
   */
  dismissible?: boolean;
  /** `alertdialog` announces an overlay that interrupts to confirm or warn. */
  role?: 'dialog' | 'alertdialog';
  /** Below 768px: a bottom sheet, or a dialog that fills the screen. */
  phonePresentation?: 'sheet' | 'fullscreen';
}

type OverlayShape = OverlayPresentation | 'fullscreen';

function phoneShape(phonePresentation: OverlayProps['phonePresentation']): OverlayShape {
  return phonePresentation === 'fullscreen' ? 'fullscreen' : 'sheet';
}

/**
 * Responsive overlay: a bottom sheet with drag-to-dismiss below 768px and a centred dialog from
 * 768px, whatever the pointer, chosen as it opens.
 */
function Overlay(props: Readonly<OverlayProps>): React.JSX.Element {
  const { band, pointer } = useFormFactor();
  const shape = useOpenedValue<OverlayShape>(
    props.open,
    band === 'phone' ? phoneShape(props.phonePresentation) : 'dialog'
  );
  // One record of the opener, whichever renderer the overlay opens in.
  const ownReturn = useOverlayFocusReturn(props.open);
  const returnFocus = props.onCloseAutoFocus ?? ownReturn;

  return (
    <OverlayPresentationContext value={shape === 'sheet' ? 'sheet' : 'dialog'}>
      {shape === 'sheet' ? (
        <OverlayBottomSheet {...props} returnFocus={returnFocus} />
      ) : (
        <OverlayDialog
          {...props}
          returnFocus={returnFocus}
          suppressAutoFocus={pointer === 'coarse'}
          fullscreen={shape === 'fullscreen'}
        />
      )}
    </OverlayPresentationContext>
  );
}

interface OverlayRendererProps extends OverlayProps {
  /** Returns focus to the overlay's opener as it closes. */
  returnFocus: (event: Event) => void;
}

export { Overlay };
export type { OverlayProps, OverlayRendererProps };

'use client';

import * as React from 'react';

import { useIsTouchDevice } from '../hooks/use-is-touch-device';
import { OverlayDialog } from './overlay-dialog';
import { OverlayBottomSheet } from './overlay-bottom-sheet';

interface OverlayProps {
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
  /**
   * When false, blocks every user-initiated dismissal: Escape, backdrop click,
   * mobile swipe-to-dismiss, the close button (which is hidden), and the
   * mobile drag handle (also hidden). The back button is preserved — back is
   * navigation, not dismissal. Defaults to true. Use this while an in-flight
   * action owns the modal (e.g. `ActionModal` flips it during isPending).
   */
  dismissible?: boolean;
}

/**
 * Responsive overlay — renders as a centered dialog on non-touch devices
 * or a bottom sheet with drag-to-dismiss on touch devices. To override the
 * touch detection, wrap a subtree in `<TouchDeviceOverrideContext value={...}>`.
 */
function Overlay(props: Readonly<OverlayProps>): React.JSX.Element {
  const isTouch = useIsTouchDevice();

  if (isTouch) {
    return <OverlayBottomSheet {...props} />;
  }
  return <OverlayDialog {...props} />;
}

export { Overlay };
export type { OverlayProps };

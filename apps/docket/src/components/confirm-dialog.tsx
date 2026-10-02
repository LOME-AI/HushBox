import { useRef } from 'react';
import { Button } from '@hushbox/ui/button';
import { Overlay, OverlayContent, OverlayFooter, OverlayHeader } from '@hushbox/ui/overlay';
import { TEST_IDS } from '@/test-ids';
import { useHotkeyHold } from './hotkey-hold';
import { useDialogFocusRestore } from './use-dialog-focus-restore';
import type { JSX, ReactNode } from 'react';

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  /** What the reader has to weigh: the note count, or every id about to change. */
  readonly children: ReactNode;
  readonly busy?: boolean;
}

/**
 * The one confirmation in this console. What it guards is always reversible but
 * always wide: discarding a decision that work has been done against, or
 * writing to every finding the filters admit at once.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onClose,
  children,
  busy = false,
}: ConfirmDialogProps): JSX.Element {
  const regionRef = useRef<HTMLElement | null>(null);
  const { captureOpener, restoreFocus } = useDialogFocusRestore(() => regionRef.current);

  useHotkeyHold(open);

  // Controlled, with no trigger of its own, so the only change the overlay
  // reports is the dialog closing: Escape, the scrim, or the close button.
  return (
    <>
      {/* The dialog itself is portalled to `<body>`, so this marks where the
          caller mounted it. It is the only handle on the reader's place in the
          page when the opener is already gone before the dialog opens. */}
      <span
        hidden
        ref={(node) => {
          regionRef.current = node === null ? null : node.parentElement;
        }}
      />
      <Overlay
        open={open}
        onOpenChange={onClose}
        ariaLabel={title}
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreFocus}
      >
        <OverlayContent>
          {/* The guard copy is the dialog's accessible description: it is the
              whole reason the dialog exists, and a reader who cannot see it
              gets nothing. */}
          <OverlayHeader
            title={title}
            description={<div className="flex flex-col gap-2">{children}</div>}
          />
          <OverlayFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onConfirm}
              disabled={busy}
              data-testid={TEST_IDS.confirmAccept}
            >
              {confirmLabel}
            </Button>
          </OverlayFooter>
        </OverlayContent>
      </Overlay>
    </>
  );
}

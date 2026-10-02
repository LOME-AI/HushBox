import { toast } from '@hushbox/ui';

/**
 * Long enough to notice a misclick and reach the button. A one-click action
 * that commits to a file will be misclicked over a few hundred findings, so the
 * way back has to still be on screen when the reader realises.
 */
export const UNDO_TOAST_MS = 8000;

export type UndoNotifier = (message: string, onUndo: () => void) => void;

/**
 * The one place this console uses a toast. Every other result is reported in
 * place, the way `apps/admin` does it; undo is the exception because it has to
 * be ephemeral and must not block the next ruling.
 */
export const showUndoToast: UndoNotifier = (message, onUndo) => {
  toast(message, {
    duration: UNDO_TOAST_MS,
    action: { label: 'Undo', onClick: onUndo },
  });
};

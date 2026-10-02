import * as React from 'react';
import { motion } from 'framer-motion';
import { ModalActions } from '@hushbox/ui';
import { MAX_SELECTED_MODELS, TEST_IDS } from '@hushbox/shared';

interface ModelSelectorFooterProps {
  selectedCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Multi-mode footer. Single mode hides the footer entirely (row click commits +
 * closes, so there's no pending state to confirm or discard).
 *
 * Slides up from below when entering — gives the visual cue that the user has
 * a pending state to confirm. The root MotionConfig globally collapses this
 * to instant when reduced motion is on.
 */
export function ModelSelectorFooter({
  selectedCount,
  onCancel,
  onConfirm,
}: Readonly<ModelSelectorFooterProps>): React.JSX.Element {
  const useLabel = selectedCount === 1 ? 'Use 1 model' : `Use ${String(selectedCount)} models`;
  return (
    <motion.div
      data-testid={TEST_IDS.modelSelectorFooterMotion}
      initial={{ y: 24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 24, opacity: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="border-t p-4"
    >
      <ModalActions
        cancel={{
          label: 'Cancel',
          onClick: onCancel,
          testId: TEST_IDS.cancelButton,
        }}
        primary={{
          label: useLabel,
          onClick: onConfirm,
          testId: TEST_IDS.useModelsButton,
        }}
      />
    </motion.div>
  );
}

interface MultiCountChipProps {
  selectedCount: number;
  onClear: () => void;
}

export function MultiCountChip({
  selectedCount,
  onClear,
}: Readonly<MultiCountChipProps>): React.JSX.Element {
  return (
    <motion.span
      data-testid={TEST_IDS.pickerModeCounter}
      layout
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: 'auto' }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ duration: 0.18 }}
      className="text-muted-foreground inline-flex flex-shrink-0 items-center gap-1 overflow-hidden text-xs whitespace-nowrap"
    >
      <span>{`${String(selectedCount)} of ${String(MAX_SELECTED_MODELS)}`}</span>
      {selectedCount > 0 && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            data-testid={TEST_IDS.clearSelectionButton}
            onClick={onClear}
            className="text-primary cursor-pointer underline-offset-2 hover:underline"
          >
            Clear
          </button>
        </>
      )}
    </motion.span>
  );
}

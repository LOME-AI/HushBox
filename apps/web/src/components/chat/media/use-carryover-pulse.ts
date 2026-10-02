import * as React from 'react';
import { type PickerMode } from '@/stores/model';

const PICKER_PULSE_DURATION_MS = 600;

/**
 * Highlights the carryover-selected row briefly when the picker transitions
 * single → multi. Returns the model id to pulse, or null when no pulse should
 * play. Resets when the modal closes so a re-open in multi mode doesn't pulse.
 */
export function useCarryoverPulse(
  pickerMode: PickerMode,
  selectedIds: Set<string>,
  isOpen: boolean
): string | null {
  const [pulsingModelId, setPulsingModelId] = React.useState<string | null>(null);
  const previousModeReference = React.useRef<PickerMode>(pickerMode);

  React.useEffect(() => {
    if (!isOpen) {
      previousModeReference.current = pickerMode;
      setPulsingModelId(null);
      return;
    }
    const previous = previousModeReference.current;
    previousModeReference.current = pickerMode;
    if (previous !== 'single' || pickerMode !== 'multi') return;
    const firstId = selectedIds.values().next().value;
    if (firstId === undefined) return;
    setPulsingModelId(firstId);
    const timer = setTimeout(() => {
      setPulsingModelId(null);
    }, PICKER_PULSE_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pickerMode, selectedIds, isOpen]);

  return pulsingModelId;
}

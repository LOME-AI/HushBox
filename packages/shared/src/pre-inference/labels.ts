import type { StageId } from './events.js';

/**
 * Display labels surfaced to the user while a stage is running ("Choosing the
 * best model…"). Single source of truth — frontend looks up by stageId.
 */
export const STAGE_LABELS: Record<StageId, string> = {
  'smart-model': 'Choosing the best model…',
};

/** Look up the user-facing label for a stage id. */
export function stageLabel(stageId: StageId): string {
  return STAGE_LABELS[stageId];
}

import { REASONING_EFFORT_LABELS } from '@hushbox/shared';
import type { ReasoningEffortSelection } from '@hushbox/shared';

/**
 * What a settled reasoning row reads once a turn has recorded the level it ran
 * at. The rung's word comes from the shared label map rather than a second
 * spelling of it, and the sentence around it is spelled here rather than in
 * each spec that asserts it — a bare "Reasoning" means the level never reached
 * the persisted answer, and that distinction is only readable if every spec
 * expects the same sentence.
 */
export function settledReasoningLabel(effort: ReasoningEffortSelection): string {
  return `Reasoning · ${REASONING_EFFORT_LABELS[effort]} effort`;
}

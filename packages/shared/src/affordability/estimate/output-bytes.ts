/**
 * The bytes a media run's output can rest in — the one bound every reserved
 * media storage term is priced from, beside the byte rate that prices it
 * (`mediaStorageNanoUsd` in
 * `packages/shared/src/affordability/estimate/storage-rate.ts`).
 *
 * The bound is the run's value-store budget: every media value a run holds is
 * admitted by that store, which refuses what would exceed it, so no run can store
 * more bytes than the budget whatever its models, durations or sibling count.
 * Settlement bills the bytes actually stored, so reserving the budget once per
 * run covers any artifact set the run can produce.
 *
 * It has one home because every path that prices the reserved storage leg must
 * agree to the nano — the server's admission ceiling and its payer-freeze
 * minimum, the client's cost estimate, the composer's media verdict. A second
 * expression of it presents rows as affordable that admission then refuses
 * (`docs/CODE-RULES.md` §One Implementation, Shared).
 */

import { VALUE_STORE_BYTE_BUDGET_BYTES } from '../../constants.ts';
import { mediaStorageNanoUsd } from './storage-rate.ts';
import type { Modality } from '../model/modality.ts';

export const MEDIA_RUN_STORAGE_BOUND_BYTES = VALUE_STORE_BYTE_BUDGET_BYTES;

/** The media storage one persisting run reserves, once, whatever it generates. */
export function mediaRunStorageNanoUsd(): bigint {
  return mediaStorageNanoUsd(MEDIA_RUN_STORAGE_BOUND_BYTES);
}

/**
 * The modalities whose output rests in object storage. Derived from the closed
 * modality set rather than listed, so a new modality is stored unless it is
 * excluded here.
 */
export type StoredMediaModality = Exclude<Modality, 'text' | 'embedding'>;

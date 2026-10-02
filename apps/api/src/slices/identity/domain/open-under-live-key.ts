import { UnknownKeyVersionError } from '@hushbox/crypto';

/**
 * Opens a stored sealed value under the key this deployment holds. A blob
 * whose key id names a key the deployment does not hold answers `null` — the
 * key and the rows disagree, an operator condition each caller maps to its
 * typed outcome. A blob carrying the live key's id that still fails to open is
 * corruption in data the slice wrote: a defect, rethrown. One shape for every
 * gate, so the operator condition cannot surface as a 500 on one path and a
 * typed outcome on another.
 */
export function openUnderLiveKey<T>(open: () => T): T | null {
  try {
    return open();
  } catch (error) {
    if (error instanceof UnknownKeyVersionError) return null;
    throw error;
  }
}

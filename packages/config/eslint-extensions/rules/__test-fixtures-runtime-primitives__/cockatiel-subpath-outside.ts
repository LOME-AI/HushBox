// Fixture: a subpath specifier reaches the same library as the bare one, so
// outside the resilience policy factory every import form below must be
// flagged: static import, star re-export, named re-export, dynamic import.

import { neverAbortedSignal } from 'cockatiel/dist/common/abort.js';

export * from 'cockatiel/dist/Policy.js';

export { handleAll } from 'cockatiel/dist/Policy.js';

export async function loadDynamically(): Promise<unknown> {
  return import('cockatiel/dist/common/abort.js');
}

export const reExported = neverAbortedSignal;

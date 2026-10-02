// Fixture: the policy factory reaching an internal module of the library by
// subpath — the allowed directory admits both spellings. Zero findings
// expected.

import { neverAbortedSignal } from 'cockatiel/dist/common/abort.js';

export const allowed = neverAbortedSignal;

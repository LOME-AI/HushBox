export { callerUserId } from './principal.js';
export { searchInvitableUsers, searchUsersQuerySchema } from './user-search.js';
export {
  clearInstructions,
  getInstructions,
  putInstructionsBodySchema,
  saveInstructions,
} from './instructions.js';
export {
  getAccessibilityPreferences,
  putAccessibilityPreferencesBodySchema,
  saveAccessibilityPreferences,
} from './preferences.js';
export type { AccountStoresFactory } from '../ports/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the idempotency wrappers the exemption
// declarations must compose with — is published here rather than imported from
// lib directly in routes.ts.
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';

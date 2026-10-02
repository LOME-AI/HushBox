export { buildGreeting } from './greeting.js';
export { callerUserId } from './principal.js';
export { putNoteBodySchema, saveNote } from './note.js';
export type { TemplateDeps } from './greeting.js';
export type { NoteState } from './note.js';

// Routes import only this barrel and the middleware (boundaries), so the
// idempotency wrappers a mutating route needs are published here.
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';

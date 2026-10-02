export { authorizePresign } from './presign-authz.js';
export type { PresignAuthzDeps } from './presign-authz.js';
export { LINK_CREDENTIAL_HEADER, resolveMediaCaller } from './caller.js';
export {
  contentItemParameterSchema,
  mintDownloadUrl,
  sharedPresignParameterSchema,
} from './presign.js';
export type { MintDownloadUrlDeps } from './presign.js';
// This slice's `routes.ts` calls the counting functions, which is why the registry is
// republished here rather than off the slice barrel; the rule and its derivation are
// stated at `apps/api/src/slices/chat/domain/index.ts`.
export { MEDIA_RATE_LIMITS, consumeLinkMint, reserveShareRemint } from './rate-limit.js';
export { runMediaGc } from './gc.js';
export type { MediaGcDeps } from './gc.js';
export { MEDIA_RECLAIM_USER_JOB_TYPE, createMediaReclaimUserJob } from './reclaim-user.js';
export { createBackupAuditEntry, createBackupRetentionAuditEntry } from './audit/entries.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib and port surfaces the route seam needs are published here rather than
// imported from lib or ports directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export type { PresignReaders, Storage } from '../ports/index.js';
export type { LinkResolutionPort } from '../../identity/index.js';

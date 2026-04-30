import type { Context } from 'hono';
import type { EvidenceConfig } from '@hushbox/db';
import type { AppEnv } from '../types.js';

/**
 * Bundle the dependencies any external-service factory needs to record
 * evidence after a successful real API call. Used by every middleware that
 * wires a service which records evidence (today: aiClientMiddleware,
 * helcimMiddleware).
 *
 * `recordServiceEvidence` itself gates the write on `isCI === true`; this
 * helper just collects the inputs from Hono context.
 */
export function createEvidenceConfig(c: Context<AppEnv>): EvidenceConfig {
  return {
    db: c.get('db'),
    isCI: c.get('envUtils').isCI,
  };
}

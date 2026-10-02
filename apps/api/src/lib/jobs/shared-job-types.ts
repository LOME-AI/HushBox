/**
 * Job type names whose enqueuers live in a slice other than the one owning the
 * handler. The name is the protocol between the two, so it belongs to the jobs
 * machinery rather than to either party: a slice-private job type (one only its
 * owner enqueues) stays next to its handler, and moves here the day a second
 * slice enqueues it.
 */

/**
 * `session.revoke.v1` — identity owns the handler; billing's chargeback webhook
 * and the admin containment ops enqueue it, each inside its own settlement
 * transaction.
 */
export const SESSION_REVOKE_JOB_TYPE = 'session.revoke.v1';

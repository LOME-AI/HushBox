/**
 * The failure an execution-budget kill records, defined here because two sides
 * depend on the same text and neither owns the other: the dispatcher's budget
 * race writes it, and the lease-timeout auditor recognises a kill by matching
 * its prefix. Held apart from both so the executor never imports the module
 * that audits it. The message is derived from the prefix rather than repeating
 * it, so the two cannot drift — and drift here is silent, leaving the auditor
 * reporting nothing with no failure anywhere to say so.
 */
export const LEASE_TIMEOUT_ERROR_PREFIX = 'lease timeout:';

export const LEASE_TIMEOUT_ERROR = `${LEASE_TIMEOUT_ERROR_PREFIX} handler exceeded its maxExecutionSeconds`;

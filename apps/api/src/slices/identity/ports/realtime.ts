/**
 * The realtime eviction capability the identity slice composes when it revokes
 * a session (ARCHITECTURE §Streaming & realtime). This is the PROMPTNESS layer: it closes the
 * revoked user's live sockets immediately by fanning out over their active-room
 * set, rather than waiting for the next broadcast.
 *
 * The CORRECTNESS guarantee is the fail-closed broadcast-time SESSION-liveness
 * check (packages/realtime session-liveness.ts): a socket this fan-out misses —
 * an entry expired out of the active-room set, or a per-room evict failed — is
 * cut at its next broadcast before more plaintext reaches it. The WS-upgrade
 * re-auth (the upgrade runs the default-deny pipeline, so a deleted
 * `sessionActive` key denies reconnect) closes the reconnect path. The
 * broadcast-time MEMBERSHIP check is not part of this — it validates
 * membership, not session validity.
 *
 * Best-effort by contract: the returned promise never rejects, and the caller
 * must never let a fan-out failure fail or block the revocation itself — a
 * missed eviction is backstopped by the session-liveness check above.
 */
export interface EvictUserPort {
  /**
   * `sessionId` scopes the close to the one device that session authorizes, so
   * signing out on one device leaves the user's others connected. Omitted, every
   * socket the user holds closes — what an account-wide revocation (credential
   * rotation, account lock, account deletion) means. Optional rather than
   * required so an omission over-closes rather than leaving a revoked session
   * connected.
   */
  evictUser(userId: string, sessionId?: string): Promise<void>;
}

/**
 * The most keys the end-to-end stack's Redis database may hold once its seed
 * has finished. The seed's tail reads the database's own key count and refuses
 * above this, so a seed that writes history into that stack fails the run that
 * introduced it rather than the suite that inherits it.
 *
 * **What it protects is not a round-trip count.** The per-test usage reset in
 * `apps/api/src/dev/redis-resets.ts` walks the keyspace inside Redis, so it
 * costs one round trip whatever that keyspace holds — a bulk seed cannot make
 * the reset chatty again. What it can still make expensive is the volume that
 * server-side walk deletes, which every test pays twice, and what it destroys
 * outright is the discipline that gives the number meaning: the end-to-end
 * stack holds only what the suite reads, so a key found there was put there by
 * a test.
 *
 * **It is a ceiling, never a band.** A seed over a freshly wiped database
 * leaves a few hundred transient admission-snapshot keys behind its personas
 * step, each expiring on its own short TTL, so the count at the tail is
 * unstable by construction and anything asserting a fixed number would flake.
 * This sits several times above that transient population and several times
 * below a keyspace carrying seeded history, which is the whole width the check
 * needs.
 */
export const E2E_KEYSPACE_CEILING = 2000;

/**
 * Where the CI HTTP cassettes live — on disk and in the shared object store.
 *
 * Three values two packages must agree on: the api harness reads and writes the
 * local directory, the CI sync script maps that directory onto object keys, and
 * both address the same recording generation. Disagreement is silent — the
 * harness simply misses and records a live, charged call — so the values are
 * shared rather than restated on each side.
 *
 * Reached through the `@hushbox/shared/cassettes` subpath so the barrel, and
 * with it every browser bundle, stays free of CI-only constants.
 */

/** Repository-root-relative directory the cassette harness reads and writes. */
export const CASSETTE_DIRECTORY = '.ai-cassettes';

/** Object-key prefix for every cassette in the shared bucket. */
export const CASSETTE_OBJECT_PREFIX = 'cassettes/';

/**
 * Suffix that identifies a cassette, on disk and in an object key. Both sides
 * use it twice over — to name what they write, and to decide what to read back
 * — and a disagreement is not a crash but a skipped upload and a charged call.
 */
export const CASSETTE_FILE_SUFFIX = '.json';

/**
 * Recording generation — a directory segment on disk and a key segment in the
 * store. Bumping it retires every current recording: the harness reads only
 * this generation's directory and the restore fetches only this generation's
 * objects, so older ones are neither read nor downloaded. They are not deleted
 * either — the store has no eviction, and reclaiming the bytes is a manual
 * delete on the bucket.
 *
 * Bump when:
 *   1. the serialized cassette schema changes incompatibly (adding an optional
 *      field is compatible and needs no bump);
 *   2. the hash key changes (the canonical-request header allowlist, say);
 *   3. provider behaviour changed and every current recording should retire;
 *   4. test prompts changed and the recordings should be clean.
 * It is a deliberate one-line change; review catches mistakes.
 *
 * `v3` is current because the video poll cadence is derived from whether this
 * generation holds any recording at all: a populated one means the run replays,
 * so leaving it populated would have recorded the first video poll loop at the
 * replay cadence rather than the provider's. Emptying it put that recording on
 * the provider's own cadence, which is the only one safe against a live
 * endpoint.
 */
export const AI_RECORDING_VERSION = 'v3' as const;

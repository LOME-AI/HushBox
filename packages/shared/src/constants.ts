/** CSS media query for detecting coarse pointer (touch) devices */
export const TOUCH_QUERY = '(pointer: coarse)';

/** Shared password for all dev personas. Only for local development. */
export const DEV_PASSWORD = 'pass1234';

/** Email domain for development personas */
export const DEV_EMAIL_DOMAIN = 'dev.hushbox.ai';

/** Email domain for test personas (used by E2E tests) */
export const TEST_EMAIL_DOMAIN = 'test.hushbox.ai';

/**
 * Synthetic ID for HushBox's Smart Model — the classifier-based router
 * that picks the best underlying model per message. Stable identifier the
 * frontend persists in user prefs and the backend special-cases on its
 * classifier path.
 */
export const SMART_MODEL_ID = 'smart-model';

/** Payment expiration time in milliseconds (30 minutes) */
export const PAYMENT_EXPIRATION_MS = 30 * 60 * 1000;

/**
 * Time-to-live for presigned R2 GET URLs, in seconds.
 * Short enough to prevent long-lived leaks, long enough for clients
 * to fetch and decrypt media after unwrapping the content key.
 */
export const MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * Key prefix of the short-TTL client-encrypted staging objects in the media
 * bucket. It lives here because two independent writers must name the same
 * prefix: the media slice's key builders and garbage collector produce it, and
 * the backup config excludes it from the R2 snapshot — staging objects are
 * run-scoped and expire within the hour, so backing them up would retain
 * ciphertext the product itself has already dropped.
 */
export const INPUTS_PREFIX = 'inputs/';

/**
 * Days a hidden object version survives in the backup bucket before the store
 * destroys it, which that bucket's lifecycle rule must carry.
 *
 * It lives here because two independent readers must name the same number: the
 * Worker's cron auditor, which pages when the bucket's rule drifts from it, and
 * the backup orchestrator's retention arithmetic, which adds it to the forget
 * ladder and the prune cadence and checks the total against the ceiling the
 * privacy policy publishes. The backup key holds no destroy capability, so
 * removing an object only hides a version and this rule is the single stage of
 * the deletion chain that erases anything: raising it raises the worst-case age
 * of deleted user data by the same number of days.
 */
export const BACKUP_LIFECYCLE_NONCURRENT_DAYS = 30;

/** Maximum bytes for a single-PUT R2 upload via the Worker. Multipart is not supported. */
export const MAX_MEDIA_OBJECT_BYTES = 250_000_000; // 250 MB

/**
 * Byte budget for the workflow engine's in-memory ValueStore — the ceiling every
 * mid-flow value of one run shares, assuming a ≥3× real-memory multiplier over the
 * metered size. It lives here because two slices must agree on it: the engine
 * meters against it, and admission's media size gate refuses a declaration that
 * could not possibly fit it. Neither may reach into the other (the models domain
 * cannot import `workflows/engine`, and a workflows-barrel import would make the
 * dependency bidirectional), so the shared package is the one home.
 */
export const VALUE_STORE_BYTE_BUDGET_BYTES = 20 * 1024 * 1024;

/**
 * Maximum audio duration the user can cap a TTS generation at, in seconds.
 * Unlike video (deterministic duration in the request), TTS duration emerges
 * from synthesizing the input text, so the user picks an upper bound that
 * caps worst-case spend; the actual bill uses the generated `durationMs`.
 */
export const MAX_AUDIO_DURATION_SECONDS = 600;

/** Audio output formats offered in the audio config picker. Single source of truth — request schema derives from this. */
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg'] as const;

/** Feature flags for conditional feature rendering */
interface FeatureFlags {
  /** Enable settings feature in user menu. Currently disabled pending feature completion */
  readonly SETTINGS_ENABLED: boolean;
  /** Enable audio generation UI. Flip to true when the AI Gateway ships audio output support. */
  readonly AUDIO_ENABLED: boolean;
}

export const FEATURE_FLAGS: FeatureFlags = Object.freeze({
  SETTINGS_ENABLED: true,
  AUDIO_ENABLED: false,
});

/** Maximum number of members (users + link guests) allowed in a single conversation */
export const MAX_CONVERSATION_MEMBERS = 100;

/** Maximum number of forks allowed per conversation */
export const MAX_FORKS_PER_CONVERSATION = 5;

/** Maximum number of models that can be selected simultaneously for multi-model chat */
export const MAX_SELECTED_MODELS = 5;

/**
 * HTTP header carrying a shared-link visitor's credential: the base64 link auth
 * token its URL's secret derives. The token is a secret; the server stores only
 * its hash, and the link's public key authenticates nothing. Shared because both
 * ends of the wire must name it identically: the web client sets it on every
 * link-guest request, and the API keys guest credential rate limiting on it and
 * resolves the link-guest principal that authorizes conversation reads, chat
 * sends and media presign from it. A second spelling on either side stops guests
 * being recognized rather than erroring.
 * Header names are case-insensitive on both sides, so lowercase here is the
 * canonical spelling, not a behavioural requirement.
 */
export const LINK_CREDENTIAL_HEADER = 'x-link-auth';

/**
 * Query parameter carrying a link guest's single-use socket ticket on the
 * conversation WebSocket upgrade. A browser cannot set headers on
 * `new WebSocket`, and the link credential is a secret that must never ride a
 * URL, so the guest mints a short-lived ticket with the header and presents
 * that instead.
 */
export const UPGRADE_TICKET_PARAM = 'ticket';

/**
 * The product's release stage: the one source everything that differs in the beta derives
 * from, the Terms' beta section included. Typed as the union rather than its literal so code that
 * compares against either stage typechecks. Moving it changes the published Terms, which the
 * pinned copy digest refuses until a human re-pins it, raising the Terms revision for a substantive change.
 */
export const RELEASE_STAGE: 'beta' | 'stable' = 'beta';

/**
 * Revision of the published Privacy Policy, raised by a human whenever a change to the
 * document's copy is substantive. It is the only human input to the effective date:
 * `scripts/legal-effective-dates.ts` derives that date from the earliest release tag whose
 * commit already declared this number, and the build injects the answer into the page,
 * where `packages/shared/src/legal/effective-dates.ts` reads it. No published effective
 * date is typed in this repository: every binding on the way to a production build carries
 * the derivation's answer, and the day `packages/shared/src/env/env.config.ts` declares is
 * the placeholder for builds that derive nothing, and production never reads it.
 *
 * The derivation reads the declaration line whole, so what follows the `=` must be digits
 * and the closing semicolon and nothing else: a trailing comment there refuses the build.
 */
export const PRIVACY_POLICY_REVISION = 5;

/**
 * Revision of the published Terms of Service, on the same footing as the Privacy Policy's,
 * including the shape its declaration line must keep.
 */
export const TERMS_OF_SERVICE_REVISION = 5;

/**
 * SHA-256 of the Privacy Policy's rendered copy, as `legalCopyDigest` computes it. Pinned
 * so that a change to what a reader sees fails until a human judges it substantive (raise
 * the revision) or cosmetic (re-pin this alone).
 */
export const PRIVACY_POLICY_COPY_DIGEST =
  '99e94e6250094b8fcdf087192fad2f6b31999065ef7adae441e40edbe737dbd3';

/** SHA-256 of the Terms of Service's rendered copy, on the same footing as the Privacy Policy's. */
export const TERMS_OF_SERVICE_COPY_DIGEST =
  'fab7f1e40fdadddcce5c788efcc44eb0f56237d993d897b368dbe98b6d4af642';

/** The one contact address both legal documents publish. */
export const LEGAL_CONTACT_EMAIL = 'legal@hushbox.ai';

/** Phrase typed by the user to confirm account deletion (compared trim+lowercased, no NFKC). */
export const DELETE_ACCOUNT_CONFIRMATION_PHRASE = 'delete my account';

/** Minimum new-password length enforced at every password-entry surface. */
export const MIN_PASSWORD_LENGTH = 8;

/** Minimum card-loading deposit, in whole US dollars (README pricing). */
export const MIN_DEPOSIT_USD = 5;

/**
 * Maximum single card-loading deposit, in whole US dollars. Bounds one charge,
 * never a lifetime total: chargeback and card-testing exposure scale with the
 * size of an individual charge.
 */
export const MAX_DEPOSIT_USD = 1000;

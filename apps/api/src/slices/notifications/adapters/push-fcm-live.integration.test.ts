import { beforeAll, describe, expect, it } from 'vitest';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  recordServiceEvidence,
  SERVICE_NAMES,
  type Database,
} from '@hushbox/db';
import { evidenceDatabaseUrl } from '@hushbox/db/test-db';
import { createEnvUtilities, type EnvContext, type EnvUtilities } from '@hushbox/shared';
import { collectFcmErrorCodes, createFcmPushSender } from './push-fcm.js';

/**
 * The real FCM send path against Google, CI-vitest only. It proves what no
 * mocked test can: that the service-account JWT our RS256 signer produces is
 * accepted by Google's own token endpoint, and that the request our adapter
 * builds reaches FCM's v1 API as a well-formed, authenticated, correctly
 * scoped send. `validate_only` keeps it off real devices; the token is
 * fabricated, so FCM is expected to reject the message itself — which is the
 * part that also lets the test check our error classifier against a real
 * Google error body instead of a fixture we wrote.
 *
 * What the live arm proves is request-shape acceptance, never payload
 * discrimination: the token it sends is fabricated, so the answer it draws is a
 * verdict on that token and says nothing about which notification fields FCM
 * wanted. The fixture legs below carry the discrimination, where anyone can run
 * it.
 *
 * `SERVICE_NAMES.PUSH_FCM` evidence is recorded only after that real call
 * succeeded, so `pnpm verify:evidence --require=push-fcm` cannot be satisfied
 * by a mocked seam. Without the credentials the suite skips and that step
 * fails loudly — the intended guard.
 */

function readEnv(): EnvContext {
  return {
    ...(process.env['NODE_ENV'] !== undefined && { NODE_ENV: process.env['NODE_ENV'] }),
    ...(process.env['CI'] !== undefined && { CI: process.env['CI'] }),
    ...(process.env['E2E'] !== undefined && { E2E: process.env['E2E'] }),
    ...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] }),
  };
}

/** CI-vitest (CI, not E2E) with the credentials — the only shell that calls Google. */
function deriveFcmLiveGate(envUtilities: EnvUtilities, hasCredentials: boolean): boolean {
  return envUtilities.isCI && !envUtilities.isE2E && hasCredentials;
}

const projectId = process.env['FCM_PROJECT_ID_CI'];
const serviceAccountJson = process.env['FCM_SERVICE_ACCOUNT_JSON_CI'];
const HAS_CREDENTIALS =
  projectId !== undefined &&
  projectId.length > 0 &&
  serviceAccountJson !== undefined &&
  serviceAccountJson.length > 0;

/** THE one `createEnvUtilities` derivation for this harness (vitest sets NODE_ENV). */
const AMBIENT_ENV = createEnvUtilities(readEnv());

const shouldRun = deriveFcmLiveGate(AMBIENT_ENV, HAS_CREDENTIALS);

describe('deriveFcmLiveGate', () => {
  it('refuses a local vitest shell even with the credentials present', () => {
    expect(
      deriveFcmLiveGate(createEnvUtilities({ NODE_ENV: 'development', VITEST: 'true' }), true)
    ).toBe(false);
  });

  it('refuses a CI-E2E shell', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(false);
  });

  it('refuses CI-vitest without the credentials (skip — verify:evidence is the loud guard)', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        false
      )
    ).toBe(false);
  });

  it('admits only CI-vitest with the credentials', () => {
    expect(
      deriveFcmLiveGate(
        createEnvUtilities({ NODE_ENV: 'development', CI: 'true', VITEST: 'true' }),
        true
      )
    ).toBe(true);
  });
});

/** A syntactically plausible device token that was never issued by FCM. */
const FABRICATED_TOKEN = 'hushbox-ci-validation-token-never-issued-by-fcm';

interface CapturedLeg {
  readonly url: string;
  readonly status: number;
  readonly body: unknown;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Google minted an access token for our RS256-signed service-account JWT. */
function expectOAuthAccepted(leg: CapturedLeg | undefined): void {
  expect(leg?.url).toBe('https://oauth2.googleapis.com/token');
  const accessToken = (leg?.body as { access_token?: unknown } | undefined)?.access_token;
  expect(typeof accessToken).toBe('string');
}

interface ErrorDetail {
  readonly '@type'?: unknown;
  readonly errorCode?: unknown;
  readonly fieldViolations?: { readonly field?: unknown }[];
}

/** FCM's own per-message detail: its messaging layer reached a verdict. */
function isFcmErrorDetail(detail: ErrorDetail): boolean {
  return String(detail['@type']).endsWith('google.firebase.fcm.v1.FcmError');
}

/**
 * A request-level violation naming the token field — a verdict on the token
 * reached before FCM's messaging layer. The field name is matched whole: a
 * containment test would also admit a payload field whose name happens to carry
 * the word, and telling the token apart from the payload is the whole point.
 */
function namesTokenField(detail: ErrorDetail): boolean {
  if (!String(detail['@type']).endsWith('google.rpc.BadRequest')) return false;
  const violations = detail.fieldViolations;
  if (!Array.isArray(violations)) return false;
  return violations.some((violation) => violation.field === 'message.token');
}

/**
 * FCM answered the send as FCM: either it accepted the message, or it rejected
 * the one token this send names. The success placeholder's value is not
 * contractual, so only its shape is asserted. A rejection counts as a verdict on
 * the token when it carries FCM's own per-message detail or a violation naming
 * the token field; one whose violations name payload fields is a verdict on the
 * body and is refused, which is the discrimination this helper exists for. Which
 * code FCM pairs with a detail is deliberately not asserted: it varies with
 * the token's shape, the service owns the choice, and this helper's live caller
 * is the one arm no local run can reproduce — so a wrong guess there would be a
 * red nobody can chase. A 401 would mean our credential or scope was refused and
 * is the one answer that falsifies the proof outright.
 */
function expectFcmVerdict(leg: CapturedLeg | undefined): void {
  expect(leg?.status).not.toBe(401);
  const body = leg?.body as { name?: unknown; error?: unknown } | undefined;
  if (typeof body?.name === 'string') {
    expect(body.name.length).toBeGreaterThan(0);
    return;
  }
  const details = (body?.error as { details?: unknown } | undefined)?.details;
  expect(Array.isArray(details)).toBe(true);
  const tokenVerdictDetails = (details as ErrorDetail[]).filter(
    (detail) => isFcmErrorDetail(detail) || namesTokenField(detail)
  );
  expect(tokenVerdictDetails).not.toHaveLength(0);
  // Our own classifier, run against Google's real error body rather than a
  // fixture written to match it: every code FCM names in its own detail must
  // come back out of it, whichever codes the service chose to name.
  const namedCodes = tokenVerdictDetails.flatMap((detail) =>
    typeof detail.errorCode === 'string' ? [detail.errorCode] : []
  );
  expect(collectFcmErrorCodes(body?.error)).toEqual(expect.arrayContaining(namedCodes));
}

/** The answer FCM gives for a registration token it issued and has since retired. */
const RETIRED_TOKEN_LEG: CapturedLeg = {
  url: 'https://fcm.googleapis.com/v1/projects/p/messages:send',
  status: 404,
  body: {
    error: {
      code: 404,
      message: 'Requested entity was not found.',
      status: 'NOT_FOUND',
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode: 'UNREGISTERED',
        },
      ],
    },
  },
};

/** The answer FCM gives when the request body names a field it does not know. */
const MALFORMED_BODY_LEG: CapturedLeg = {
  url: 'https://fcm.googleapis.com/v1/projects/p/messages:send',
  status: 400,
  body: {
    error: {
      code: 400,
      message:
        'Invalid JSON payload received. Unknown name "headline" at \'message.notification\'.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'message.notification', description: 'Cannot find field.' }],
        },
      ],
    },
  },
};

/**
 * The answer FCM gives when it cannot parse the token at all, so it never
 * reaches its registry: the request-level violation names the token field, and
 * FCM's own per-message detail rides alongside it.
 */
const UNPARSEABLE_TOKEN_LEG: CapturedLeg = {
  url: 'https://fcm.googleapis.com/v1/projects/p/messages:send',
  status: 400,
  body: {
    error: {
      code: 400,
      message: 'The registration token is not a valid FCM registration token.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }],
        },
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode: 'INVALID_ARGUMENT',
        },
      ],
    },
  },
};

/**
 * A rejection carrying no per-message detail at all, whose request-level
 * violation names the token field as the one at fault — the shape the
 * token-field clause admits. Whether FCM ever answers a send this way is
 * asserted nowhere: this leg pins the helper, not the service.
 */
const TOKEN_FIELD_VIOLATION_LEG: CapturedLeg = {
  url: 'https://fcm.googleapis.com/v1/projects/p/messages:send',
  status: 400,
  body: {
    error: {
      code: 400,
      message: 'The registration token is not a valid FCM registration token.',
      status: 'INVALID_ARGUMENT',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.BadRequest',
          fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }],
        },
      ],
    },
  },
};

describe('expectFcmVerdict', () => {
  it('accepts the rejection a retired token earns', () => {
    expect(() => {
      expectFcmVerdict(RETIRED_TOKEN_LEG);
    }).not.toThrow();
  });

  it('accepts the rejection a token FCM cannot parse earns', () => {
    expect(() => {
      expectFcmVerdict(UNPARSEABLE_TOKEN_LEG);
    }).not.toThrow();
  });

  it('accepts a rejection whose only violation names the token field', () => {
    expect(() => {
      expectFcmVerdict(TOKEN_FIELD_VIOLATION_LEG);
    }).not.toThrow();
  });

  it('refuses the rejection a malformed request body earns', () => {
    expect(() => {
      expectFcmVerdict(MALFORMED_BODY_LEG);
    }).toThrow();
  });
});

describe.skipIf(!shouldRun)('createFcmPushSender — real FCM', () => {
  let db: Database;

  beforeAll(() => {
    // The evidence row has to outlive this worker's database — `verify:evidence`
    // reads the stack's own in a later process.
    db = createDb(evidenceDatabaseUrl(process.env), { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  it(
    'exchanges a real service-account JWT and reaches FCM with a well-formed send',
    { timeout: 30_000 },
    async () => {
      if (projectId === undefined || serviceAccountJson === undefined) {
        throw new Error('unreachable');
      }

      // Both legs go to the real endpoints; the wrapper only records what came
      // back, so every byte the adapter sends is the adapter's own.
      const legs: CapturedLeg[] = [];
      const capturingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        legs.push({
          url: requestUrl(input),
          status: response.status,
          // A non-JSON body from either endpoint means the proof failed; let
          // the parse throw rather than hide it behind a fallback.
          body: await response.clone().json(),
        });
        return response;
      };

      const sender = createFcmPushSender({
        projectId,
        serviceAccountJson,
        fetchImpl: capturingFetch,
        validateOnly: true,
      });

      const result = await sender.send({
        recipients: [{ platform: 'android', userId: crypto.randomUUID(), token: FABRICATED_TOKEN }],
        payload: { category: 'message', conversationId: crypto.randomUUID() },
      });

      // A per-token rejection is a delivery count, never a transport error.
      expect(result.isOk()).toBe(true);

      const [oauthLeg, sendLeg] = legs;
      expectOAuthAccepted(oauthLeg);
      expect(sendLeg?.url).toBe(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`
      );
      expectFcmVerdict(sendLeg);

      await recordServiceEvidence(db, AMBIENT_ENV.isCI, SERVICE_NAMES.PUSH_FCM, {
        sendStatus: sendLeg?.status ?? 0,
        validateOnly: true,
      });
    }
  );
});

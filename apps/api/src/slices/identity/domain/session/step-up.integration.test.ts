import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  createOpaqueClient,
  createOpaqueServer,
  deriveOpaqueKek,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration,
  mintServerMaterial,
  sealServerMaterial,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import { STEP_UP_GATES, createStepUpFinishFlow, startGuardedStepUp } from './step-up.js';
import type { OpaqueKek } from '@hushbox/crypto';
import type { StepUpPending } from './step-up.js';
import type { Result } from '../../../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const KEK = deriveOpaqueKek(textEncoder.encode('step-up-kek-at-least-32-characters-long!'));
const OTHER_KEK = deriveOpaqueKek(textEncoder.encode('step-up-other-kek-at-least-32-chars!!!!'));
const PASSWORD = 'correct horse battery';
const ROTATION_PIN = {
  observedRegistration: [1, 2, 3],
  serverMaterial: [4, 5, 6],
  kekFingerprint: [7, 8, 9, 10, 11, 12, 13, 14],
};

interface Registered {
  readonly userId: string;
  readonly opaqueRegistration: Uint8Array;
  readonly opaqueServerMaterial: Uint8Array;
}

async function registered(kek: OpaqueKek): Promise<Registered> {
  const userId = crypto.randomUUID();
  const material = await mintServerMaterial();
  const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
  const client = createOpaqueClient();
  const { serialized } = await opaqueClientStartRegistration(client, PASSWORD);
  const request = OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized);
  const response = await server.registerInit(request, userId);
  if (response instanceof Error) throw response;
  const { record } = await finishRegistration(
    client,
    response.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );
  return {
    userId,
    opaqueRegistration: new Uint8Array(record),
    opaqueServerMaterial: sealServerMaterial(kek, userId, material),
  };
}

describe('startGuardedStepUp on per-user server material', () => {
  it('answers server-material-unreadable when the row was sealed under another KEK', async () => {
    const user = await registered(OTHER_KEK);
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);
    const outcome = await startGuardedStepUp({
      redis,
      gate: STEP_UP_GATES.recoverySave,
      ke1,
      userId: user.userId,
      opaqueRegistration: user.opaqueRegistration,
      opaqueServerMaterial: user.opaqueServerMaterial,
      opaqueKek: KEK,
    });
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'server-material-unreadable' });
  });

  it('pins what the admitted pin thunk yields in the handshake entry', async () => {
    const user = await registered(KEK);
    const { ke1 } = await opaqueClientStartLogin(createOpaqueClient(), PASSWORD);
    const outcome = await unwrap(
      startGuardedStepUp({
        redis,
        gate: STEP_UP_GATES.changePassword,
        ke1,
        userId: user.userId,
        opaqueRegistration: user.opaqueRegistration,
        opaqueServerMaterial: user.opaqueServerMaterial,
        opaqueKek: KEK,
        pin: () => okAsync(ROTATION_PIN),
      })
    );
    if (outcome.kind !== 'started') throw new Error(`expected started, got ${outcome.kind}`);
    const raw = await redis.get(
      IDENTITY_KEYS.opaquePendingChangePassword.buildKey(outcome.stepUpSessionId)
    );
    const stored = IDENTITY_KEYS.opaquePendingChangePassword.schema.parse(raw);
    expect(stored.rotation).toEqual(ROTATION_PIN);
    expect(stored.userId).toBe(user.userId);
  });

  it('hands the consumed handshake, pin included, to the verified effect', async () => {
    const user = await registered(KEK);
    const client = createOpaqueClient();
    const { ke1 } = await opaqueClientStartLogin(client, PASSWORD);
    const started = await unwrap(
      startGuardedStepUp({
        redis,
        gate: STEP_UP_GATES.changePassword,
        ke1,
        userId: user.userId,
        opaqueRegistration: user.opaqueRegistration,
        opaqueServerMaterial: user.opaqueServerMaterial,
        opaqueKek: KEK,
        pin: () => okAsync(ROTATION_PIN),
      })
    );
    if (started.kind !== 'started') throw new Error(`expected started, got ${started.kind}`);
    const { ke3 } = await opaqueClientFinishLogin(client, started.ke2, OPAQUE_SERVER_IDENTIFIER);
    const seen: StepUpPending[] = [];
    const flow = createStepUpFinishFlow({
      redis,
      gate: STEP_UP_GATES.changePassword,
      userId: user.userId,
      stepUpSessionId: started.stepUpSessionId,
      ke3,
      onVerified: (pending) => {
        seen.push(pending);
        return okAsync('done' as const);
      },
    });
    expect(await unwrap(flow.claim())).toBe(true);
    expect(await unwrap(flow.execute())).toEqual({ kind: 'verified', value: 'done' });
    expect(seen[0]?.rotation).toEqual(ROTATION_PIN);
  });
});

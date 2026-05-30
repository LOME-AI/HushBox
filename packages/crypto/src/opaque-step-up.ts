import { OpaqueServer } from '@cloudflare/opaque-ts';
import {
  createOpaqueServer,
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueRegistrationRecord,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueExpectedAuthResult,
  OpaqueServerConfig,
} from './opaque-server.js';

interface InitArgs {
  masterSecret: Uint8Array;
  opaqueRegistration: Uint8Array;
  username: string;
  ke1: Uint8Array;
}

interface InitResult {
  ke2: Uint8Array;
  expectedSerialized: number[];
}

interface FinishArgs {
  ke3: Uint8Array;
  expectedSerialized: number[];
}

export type FinishOutcome = { ok: true } | { ok: false; reason: 'bad-proof' };

/**
 * Drives the server side of an OPAQUE step-up auth init.
 *
 * `expectedSerialized` is the OPAQUE expected-auth-result as `number[]` — the
 * exact shape `ExpectedAuthResult.serialize()` produces. Callers persist it
 * verbatim (e.g. in Redis) and pass it back to `opaqueStepUpFinish` unchanged.
 */
export async function opaqueStepUpInit(args: InitArgs): Promise<InitResult> {
  const server = await createOpaqueServer(args.masterSecret, OPAQUE_SERVER_IDENTIFIER);

  const registrationRecord = OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, [
    ...args.opaqueRegistration,
  ]);
  const ke1Message = OpaqueKE1.deserialize(OpaqueServerConfig, [...args.ke1]);

  const result = await server.authInit(ke1Message, registrationRecord, args.username);
  if (result instanceof Error) {
    throw result;
  }
  const { ke2, expected } = result;

  return {
    ke2: new Uint8Array(ke2.serialize()),
    expectedSerialized: expected.serialize(),
  };
}

/**
 * `OpaqueServer.authFinish` is exposed only as an instance method on
 * `@cloudflare/opaque-ts`'s `OpaqueServer`, but its body delegates to a
 * stateless 3DH MAC comparison and reads nothing from the constructed
 * server. The constructor only validates byte-array shape, so a zero-filled
 * dummy seed and keypair suffice and avoid per-request async ECC derivation.
 */
const STEP_UP_FINISH_OPRF_SEED: number[] = Array.from<number>({
  length: OpaqueServerConfig.hash.Nh,
}).fill(0);
const STEP_UP_FINISH_AKE_KEYPAIR = {
  private_key: Array.from<number>({ length: OpaqueServerConfig.ake.Nsk }).fill(0),
  public_key: Array.from<number>({ length: OpaqueServerConfig.ake.Npk }).fill(0),
};

/**
 * Drives the server side of an OPAQUE step-up auth finish.
 *
 * Returns a discriminated union rather than throwing on bad proofs: a wrong
 * client KE3 is an authentication failure (the caller chooses how to react),
 * not an exceptional condition.
 */
export function opaqueStepUpFinish(args: FinishArgs): FinishOutcome {
  const server = new OpaqueServer(
    OpaqueServerConfig,
    STEP_UP_FINISH_OPRF_SEED,
    STEP_UP_FINISH_AKE_KEYPAIR,
    OPAQUE_SERVER_IDENTIFIER
  );
  const ke3Message = OpaqueKE3.deserialize(OpaqueServerConfig, [...args.ke3]);
  const expected = OpaqueExpectedAuthResult.deserialize(
    OpaqueServerConfig,
    args.expectedSerialized
  );

  const result = server.authFinish(ke3Message, expected);
  if (result instanceof Error) {
    return { ok: false, reason: 'bad-proof' };
  }

  return { ok: true };
}

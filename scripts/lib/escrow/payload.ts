/**
 * The document one escrow run encrypts: every secret whose loss class says a
 * copy must exist, under the run and commit that produced it.
 *
 * The whole document is built before anything is encrypted, and a variable that
 * is absent or empty refuses the run naming only names — the posture
 * `encode-deploy-secrets.ts` carries, for the same reason: the refusal branch is
 * what reaches a log.
 */
import {
  deriveOpaqueKek,
  deriveTotpEncryptionKey,
  opaqueKekFingerprint,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { escrowEnvironments, escrowedSecretKeys } from '../../generate-env.js';

/** The environment as read: a value, or nothing, per name. */
export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

/** The set whose objects predate the per-set prefixes; see {@link escrowObjectKey}. */
const PRODUCTION_SET = 'production';

/** Which variable carries the run identity Actions publishes for every job. */
const RUN_ID_VARIABLE = 'GITHUB_RUN_ID';
const COMMIT_SHA_VARIABLE = 'GITHUB_SHA';

/**
 * The escrowed secrets a restored value can be checked against without decrypting
 * anything: the database stamps each row with the fingerprint of the key that
 * sealed it, so a drill compares the hex here against a `users` row by eye. Both
 * are derived through the barrel's own helpers, never re-derived here — a second
 * derivation that drifted would validate a key the rows cannot be opened with.
 */
const FINGERPRINTED_SECRETS: readonly (readonly [string, (value: string) => Uint8Array])[] = [
  ['OPAQUE_KEK', (value) => opaqueKekFingerprint(deriveOpaqueKek(textEncoder.encode(value)))],
  [
    'TOTP_ENCRYPTION_SECRET',
    (value) => totpKeyFingerprint(deriveTotpEncryptionKey(textEncoder.encode(value))),
  ],
];

function fingerprintFunctionFor(name: string): ((value: string) => Uint8Array) | undefined {
  return FINGERPRINTED_SECRETS.find(([fingerprinted]) => fingerprinted === name)?.[1];
}

/** The escrow document, exactly as it is serialized. Fingerprints are non-secret. */
export interface EscrowPayload {
  readonly runId: string;
  readonly commitSha: string;
  /** The GitHub environment whose escrowed secrets this document holds. */
  readonly set: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly fingerprints: Readonly<Record<string, string>>;
}

type EscrowPayloadResult =
  | { readonly ok: true; readonly payload: EscrowPayload }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * The whole document, or the names whose value is absent. Names, never values.
 * Actions renders an unset secret or variable as the empty string, so empty is
 * the only form "missing" takes on the runner.
 */
export function buildEscrowPayload(env: EnvironmentValues, set: string): EscrowPayloadResult {
  const environments = escrowEnvironments();
  if (!environments.includes(set)) {
    throw new Error(
      `escrow: ${set} names no environment the escrow runs under. Sets: ${environments.join(', ')}.`
    );
  }

  const runId = env[RUN_ID_VARIABLE] ?? '';
  const commitSha = env[COMMIT_SHA_VARIABLE] ?? '';
  const secretEntries = escrowedSecretKeys(set).map((name): readonly [string, string] => [
    name,
    env[name] ?? '',
  ]);

  const missing = [
    ...(runId === '' ? [RUN_ID_VARIABLE] : []),
    ...(commitSha === '' ? [COMMIT_SHA_VARIABLE] : []),
    ...secretEntries.filter(([, value]) => value === '').map(([name]) => name),
  ];
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    payload: {
      runId,
      commitSha,
      set,
      secrets: Object.fromEntries(secretEntries),
      fingerprints: Object.fromEntries(
        secretEntries.flatMap(([name, value]) => {
          const fingerprintOfValue = fingerprintFunctionFor(name);
          return fingerprintOfValue === undefined
            ? []
            : [[name, Buffer.from(fingerprintOfValue(value)).toString('hex')] as const];
        })
      ),
    },
  };
}

/**
 * Where one run's document is stored. The run id is a counter Actions publishes,
 * so the name carries no instant of its own.
 *
 * The production set keeps the bare prefix it was written under before any
 * other set existed; every other set takes a prefix of its own, so the copies a
 * drill already knows how to find stay where they are.
 */
export function escrowObjectKey(payload: EscrowPayload): string {
  const prefix = payload.set === PRODUCTION_SET ? 'escrow' : `escrow/${payload.set}`;
  return `${prefix}/${payload.runId}-${payload.commitSha}.json.age`;
}

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createOpaqueClient,
  deriveOpaqueKek,
  opaqueKekFingerprint,
  openServerMaterial,
  startLogin,
  startRegistration,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import * as deletion from '../account/deletion.js';
import * as login from './login.js';
import * as passwordChange from '../account/password-change.js';
import * as recovery from '../recovery/recovery.js';
import * as registration from './registration.js';
import * as twoFactorDisable from '../two-factor/disable.js';
import {
  MAX_KE_ARRAY_LENGTH,
  deserializeKe1,
  deserializeRegistrationRecord,
  deserializeRegistrationRequest,
  duplicateFreshHandshakeDefect,
  identitySecretsFromEnv,
  opaqueByteArray,
  opaqueProtocolError,
  requireEnumerationDecoySecret,
  requireOpaqueKek,
  requireTotpEncryptionSecret,
  runNewPasswordRegisterInit,
  throwIfOpaqueError,
} from './opaque.js';
import type { Result } from '../../../../lib/result/index.js';

/** Awaits a Result-producing call and unwraps its value; a failure throws. */
async function unwrap<T, E>(pending: PromiseLike<Result<T, E>>): Promise<T> {
  const result = await pending;
  return result._unsafeUnwrap();
}

describe('opaqueByteArray', () => {
  const schema = opaqueByteArray(MAX_KE_ARRAY_LENGTH);
  const filled = (length: number): number[] => Array.from({ length }, () => 0);

  it('accepts 0, the lowest byte value', () => {
    expect(schema.safeParse([0]).success).toBe(true);
  });

  it('rejects -1, one below the lowest byte value', () => {
    expect(schema.safeParse([-1]).success).toBe(false);
  });

  it('accepts 255, the highest byte value', () => {
    expect(schema.safeParse([255]).success).toBe(true);
  });

  it('rejects 256, one above the highest byte value', () => {
    expect(schema.safeParse([256]).success).toBe(false);
  });

  it('rejects a fractional element', () => {
    expect(schema.safeParse([3.7]).success).toBe(false);
  });

  it('accepts an array at the length cap', () => {
    expect(schema.safeParse(filled(MAX_KE_ARRAY_LENGTH)).success).toBe(true);
  });

  it('rejects an array one element past the length cap', () => {
    expect(schema.safeParse(filled(MAX_KE_ARRAY_LENGTH + 1)).success).toBe(false);
  });

  it('accepts a one-element array, the shortest legal length', () => {
    expect(schema.safeParse([1]).success).toBe(true);
  });

  it('rejects the empty array, one element below the shortest legal length', () => {
    expect(schema.safeParse([]).success).toBe(false);
  });

  it('accepts every byte a client-produced registration request contains', async () => {
    const { serialized } = await startRegistration(createOpaqueClient(), 'correct horse battery');
    expect(schema.safeParse(serialized).success).toBe(true);
  });

  it('accepts every byte a client-produced KE1 contains', async () => {
    const { ke1 } = await startLogin(createOpaqueClient(), 'correct horse battery');
    expect(schema.safeParse(ke1).success).toBe(true);
  });
});

const OPAQUE_BODY_MODULES: readonly Record<string, unknown>[] = [
  deletion,
  login,
  passwordChange,
  recovery,
  registration,
  twoFactorDisable,
];

/**
 * Every byte-array field of every exported `*BodySchema` in the given modules,
 * read off the schemas themselves rather than listed, so a wire array added to
 * one of those bodies is covered by the tests below without an edit here.
 */
function opaqueWireFields(
  modules: readonly Record<string, unknown>[]
): readonly (readonly [string, z.ZodType])[] {
  return modules.flatMap((module) =>
    Object.entries(module).flatMap(([exportName, exported]) => {
      if (!exportName.endsWith('BodySchema') || !(exported instanceof z.ZodObject)) return [];
      const body = exportName.replace(/BodySchema$/, '');
      return Object.entries(exported.shape).flatMap(([fieldName, field]) =>
        field instanceof z.ZodArray && field.element instanceof z.ZodNumber
          ? [[`${body}.${fieldName}`, field] as const]
          : []
      );
    })
  );
}

const WIRE_FIELDS = opaqueWireFields(OPAQUE_BODY_MODULES);

describe('opaqueWireFields', () => {
  it('derives a byte-array field a body schema gained without an entry here', () => {
    const grown = { grownBodySchema: z.object({ ke9: opaqueByteArray(MAX_KE_ARRAY_LENGTH) }) };

    expect(opaqueWireFields([grown])).toEqual([['grown.ke9', grown.grownBodySchema.shape.ke9]]);
  });

  it('ignores a body field that is not a byte array', () => {
    const mixed = { mixedBodySchema: z.object({ identifier: z.string() }) };

    expect(opaqueWireFields([mixed])).toEqual([]);
  });

  it('finds a wire field in every OPAQUE body module of the slice', () => {
    const perModule = OPAQUE_BODY_MODULES.map((module) => opaqueWireFields([module]).length);

    expect(perModule.every((count) => count > 0)).toBe(true);
  });
});

describe.each(WIRE_FIELDS)('OPAQUE wire field %s', (_name, field) => {
  it('rejects an array one element past the length cap', () => {
    const overCap = Array.from({ length: MAX_KE_ARRAY_LENGTH + 1 }, () => 0);
    expect(field.safeParse(overCap).success).toBe(false);
  });

  it('rejects an element one past the highest byte value', () => {
    expect(field.safeParse([256]).success).toBe(false);
  });

  it('rejects a negative element', () => {
    expect(field.safeParse([-1]).success).toBe(false);
  });

  it('accepts an array at the length cap', () => {
    const atCap = Array.from({ length: MAX_KE_ARRAY_LENGTH }, () => 255);
    expect(field.safeParse(atCap).success).toBe(true);
  });
});

describe('OPAQUE wire codecs', () => {
  it('accepts a client-produced registration request', async () => {
    const { serialized } = await startRegistration(createOpaqueClient(), 'correct horse battery');
    expect(deserializeRegistrationRequest(serialized).isOk()).toBe(true);
  });

  it('rejects garbage registration-request bytes as a validation error', () => {
    const result = deserializeRegistrationRequest([1, 2, 3]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects garbage registration-record bytes as a validation error', () => {
    const result = deserializeRegistrationRecord([9, 9, 9]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('accepts a client-produced KE1', async () => {
    const { ke1 } = await startLogin(createOpaqueClient(), 'correct horse battery');
    expect(deserializeKe1(ke1).isOk()).toBe(true);
  });

  it('rejects garbage KE1 bytes as a validation error', () => {
    expect(deserializeKe1([0])._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('throwIfOpaqueError', () => {
  it('passes a protocol value through unchanged', () => {
    const value = { ok: true };
    expect(throwIfOpaqueError(value)).toBe(value);
  });

  it('converts a library Error value into a throw', () => {
    expect(() => throwIfOpaqueError(new Error('bad KE1'))).toThrow('bad KE1');
  });
});

describe('opaqueProtocolError', () => {
  it('maps a rejection cause into the typed validation channel', () => {
    const error = opaqueProtocolError('OPAQUE authInit rejected the request')(
      new Error('protocol failure')
    );
    expect(error.code).toBe('validation');
  });
});

describe('duplicateFreshHandshakeDefect', () => {
  it('throws: a server-minted handshake id cannot be claimed twice', () => {
    expect(() => duplicateFreshHandshakeDefect()).toThrow(/server-minted handshake id/);
  });
});

const SECRET_ENV = {
  OPAQUE_KEK: 'kek-secret-at-least-32-characters-long!!', // gitleaks:allow
  TOTP_ENCRYPTION_SECRET: 'totp-secret-at-least-32-characters-long!', // gitleaks:allow
  ENUMERATION_DECOY_SECRET: 'decoy-secret-at-least-32-characters-long', // gitleaks:allow
};

describe.each([
  ['requireOpaqueKek', requireOpaqueKek, 'OPAQUE_KEK'],
  ['requireTotpEncryptionSecret', requireTotpEncryptionSecret, 'TOTP_ENCRYPTION_SECRET'],
  ['requireEnumerationDecoySecret', requireEnumerationDecoySecret, 'ENUMERATION_DECOY_SECRET'],
] as const)('%s', (_name, require, binding) => {
  it('returns the configured secret', () => {
    expect(require(SECRET_ENV)).toBe(SECRET_ENV[binding]);
  });

  it('fails fast when the binding is missing (deployment misconfiguration)', () => {
    expect(() => require({})).toThrow(new RegExp(binding));
  });

  it('fails fast when the binding is blank', () => {
    expect(() => require({ [binding]: '' })).toThrow(new RegExp(binding));
  });
});

describe('identitySecretsFromEnv', () => {
  it('derives the KEK from OPAQUE_KEK and carries the other two as bytes', () => {
    const secrets = identitySecretsFromEnv(SECRET_ENV);
    expect(secrets.opaqueKek).toEqual(deriveOpaqueKek(textEncoder.encode(SECRET_ENV.OPAQUE_KEK)));
    expect(secrets.totpEncryptionSecret).toEqual(
      textEncoder.encode(SECRET_ENV.TOTP_ENCRYPTION_SECRET)
    );
    expect(secrets.enumerationDecoySecret).toEqual(
      textEncoder.encode(SECRET_ENV.ENUMERATION_DECOY_SECRET)
    );
  });

  it('fails fast on the first missing binding', () => {
    expect(() => identitySecretsFromEnv({ OPAQUE_KEK: SECRET_ENV.OPAQUE_KEK })).toThrow(
      /TOTP_ENCRYPTION_SECRET/
    );
  });
});

describe('runNewPasswordRegisterInit', () => {
  it('mints fresh material sealed under the KEK for the credential identifier', async () => {
    const kek = deriveOpaqueKek(textEncoder.encode(SECRET_ENV.OPAQUE_KEK));
    const userId = crypto.randomUUID();
    const { serialized } = await startRegistration(createOpaqueClient(), 'correct horse battery');
    const request = deserializeRegistrationRequest(serialized)._unsafeUnwrap();

    const init = await unwrap(runNewPasswordRegisterInit(kek, userId, request));

    expect(init.kekFingerprint).toEqual(opaqueKekFingerprint(kek));
    expect(init.serverMaterial.subarray(0, 8)).toEqual(init.kekFingerprint);
    expect(init.registrationResponse.length).toBeGreaterThan(0);
    expect(() => openServerMaterial(kek, userId, init.serverMaterial)).not.toThrow();
  });

  it('seals each call under fresh material, so two inits never share a blob', async () => {
    const kek = deriveOpaqueKek(textEncoder.encode(SECRET_ENV.OPAQUE_KEK));
    const userId = crypto.randomUUID();
    const { serialized } = await startRegistration(createOpaqueClient(), 'correct horse battery');
    const request = deserializeRegistrationRequest(serialized)._unsafeUnwrap();

    const first = await unwrap(runNewPasswordRegisterInit(kek, userId, request));
    const second = await unwrap(runNewPasswordRegisterInit(kek, userId, request));

    expect(openServerMaterial(kek, userId, first.serverMaterial)).not.toEqual(
      openServerMaterial(kek, userId, second.serverMaterial)
    );
  });
});

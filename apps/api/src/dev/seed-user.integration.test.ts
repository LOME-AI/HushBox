import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  ledgerEntries,
  termsAcceptances,
  userAcquisition,
  users,
  wallets,
} from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  createAccount,
  createOpaqueClient,
  createOpaqueServer,
  decryptAndVerifyTotp,
  deriveOpaqueKek,
  finishRegistration,
  generateTotpCodeSync,
  generateTotpSecret,
  mintServerMaterial,
  opaqueKekFingerprint,
  openServerMaterial,
  startRegistration,
} from '@hushbox/crypto';
import {
  DEV_PASSWORD,
  GROWTH_DIRECT_CAMPAIGN,
  TERMS_OF_SERVICE_REVISION,
  normalizeUsername,
  textEncoder,
} from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { createBillingStores } from '../slices/billing/index.js';
import {
  applySelfReport,
  createIdentityStores,
  setAccountCreatedAt,
  setEmailVerified,
} from '../slices/identity/index.js';
import { mintSeedUser } from './seed-user.js';
import type { WelcomeEmailPort } from '../slices/billing/index.js';
import type { VerificationEmailPort } from '../slices/identity/index.js';
import type { MintSeedUserDeps, SeedCryptoProvider, SeedUserPersona } from './seed-user.js';

// The day a backdated account is dated to, and the day after it, on which that
// account answers the acquisition prompt.
const BACKDATED_DAY = TEST_DAY_START - 30 * DAY_MS;
const ANSWERED_DAY = BACKDATED_DAY + DAY_MS;

// Real infra: the OPAQUE handshake + Argon2 account derivation is genuinely
// slow, so every mint takes a couple of seconds.
const SLOW = 60_000;

// Fixed dev secrets: the KEK seals each persona's minted server material and
// the TOTP secret seals enrolled second factors — what `mintSeedUser` writes
// must open under the same values a real login / stored-secret decrypt holds.
const KEK = deriveOpaqueKek(textEncoder.encode('seed-user-test-kek-0123456789abcdef!!!!'));
const TOTP_SECRET = textEncoder.encode('seed-user-test-totp-0123456789abcdef!!!');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for seed-user integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

const welcomeEmail: WelcomeEmailPort = { sendWelcomeEmail: () => okAsync() };
const verificationEmail: VerificationEmailPort = { sendVerificationEmail: () => okAsync() };

const createdUserIds: string[] = [];

function suffix(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 10);
}

function makePersona(
  overrides: Partial<SeedUserPersona> & { readonly tag: string }
): SeedUserPersona {
  const s = suffix();
  const persona: SeedUserPersona = {
    userId: crypto.randomUUID(),
    email: `seed-${overrides.tag}-${s}@seed-user.test`,
    username: `s${overrides.tag}${s}`,
    password: DEV_PASSWORD,
    emailVerified: true,
    ...overrides,
  };
  createdUserIds.push(persona.userId);
  return persona;
}

let deps: MintSeedUserDeps;

beforeAll(() => {
  // Mirrors scripts/lib/seed/crypto-pool.ts generateOne — the same real
  // primitives the cached pool the seed orchestrator wires uses. apps/api
  // cannot import scripts/, so the test composes the crypto directly.
  const personaCrypto: SeedCryptoProvider = async ({ credentialIdentifier, password }) => {
    const serverMaterial = await mintServerMaterial();
    const opaqueServer = createOpaqueServer(serverMaterial, OPAQUE_SERVER_IDENTIFIER);
    const client = createOpaqueClient();
    const { serialized } = await startRegistration(client, password);
    const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
    const serverResult = await opaqueServer.registerInit(request, credentialIdentifier);
    if (serverResult instanceof Error) throw serverResult;
    const { record, exportKey } = await finishRegistration(
      client,
      serverResult.serialize(),
      OPAQUE_SERVER_IDENTIFIER
    );
    const account = await createAccount(new Uint8Array(exportKey));
    return {
      opaqueRegistration: new Uint8Array(record),
      serverMaterial,
      publicKey: account.publicKey,
      passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey: account.recoveryWrappedPrivateKey,
      recoveryPublicKey: account.recoveryPublicKey,
    };
  };

  deps = {
    db,
    stores: createIdentityStores(db),
    billingStores: createBillingStores(),
    opaqueKek: KEK,
    totpEncryptionSecret: TOTP_SECRET,
    personaCrypto,
    welcomeEmail,
    verificationEmail,
  };
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Delete BOTH welcome-credit legs (user + house) together so each
    // transaction stays zero-sum — the ledger balance trigger fires on DELETE.
    const welcomeKeys = createdUserIds.flatMap((id) => [
      `welcome:${id}:user`,
      `welcome:${id}:house`,
    ]);
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.idempotencyKey, welcomeKeys));
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    // verification_tokens cascade on the users delete.
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/**
 * The two store calls the E2E verify-email journey performs server-side: the
 * dev token read (`GET /dev/verify-token/:email`) and the token consume that
 * flips `users.emailVerified` (`POST /auth/verify-email`).
 */
async function verifyEmailThroughTokenPath(email: string): Promise<void> {
  const now = new Date();
  const tokenResult = await deps.stores.verification.findLatestVerificationToken(email, now);
  const token = tokenResult.unwrapOr(null);
  if (token === null) throw new Error('no verification token to consume');
  const consumed = await deps.stores.verification.consumeEmailVerification(token, now);
  const outcome = consumed.unwrapOr({ kind: 'invalid' as const });
  expect(outcome.kind).toBe('verified');
}

/** The per-persona seed step `scripts/seed.ts` runs for every test persona. */
async function seedPersona(persona: SeedUserPersona): Promise<void> {
  await mintSeedUser(deps, persona);
  await setEmailVerified(db, { email: persona.email, verified: persona.emailVerified });
}

async function readEmailVerified(userId: string): Promise<boolean | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  return rows[0]?.emailVerified;
}

describe('re-seeding a persona', () => {
  it(
    'restores the persona emailVerified flag after an earlier run verified it',
    async () => {
      const persona = makePersona({ tag: 'reseed', emailVerified: false });

      await seedPersona(persona);
      expect(await readEmailVerified(persona.userId)).toBe(false);

      await verifyEmailThroughTokenPath(persona.email);
      expect(await readEmailVerified(persona.userId)).toBe(true);

      await seedPersona(persona);
      expect(await readEmailVerified(persona.userId)).toBe(false);
    },
    SLOW
  );

  it('fails loudly when the persona to re-assert does not exist', async () => {
    await expect(
      setEmailVerified(db, { email: 'absent@seed-user.test', verified: false })
    ).rejects.toThrow('no user to set emailVerified');
  });
});

describe('mintSeedUser', () => {
  it(
    'registers a persona as a real user with the persona identity, verified flag, and two wallets',
    async () => {
      const persona = makePersona({ tag: 'v', emailVerified: true });

      const result = await mintSeedUser(deps, persona);

      expect(result).toEqual({ userId: persona.userId, created: true });

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      const row = rows[0];
      expect(row).toBeDefined();
      expect(row?.email).toBe(persona.email.toLowerCase());
      expect(row?.username).toBe(normalizeUsername(persona.username));
      expect(row?.emailVerified).toBe(true);

      const walletRows = await db.select().from(wallets).where(eq(wallets.userId, persona.userId));
      expect(walletRows).toHaveLength(2);
    },
    SLOW
  );

  it(
    'records the current Terms revision against the persona, as a real registration does',
    async () => {
      const persona = makePersona({ tag: 'terms', emailVerified: true });

      await mintSeedUser(deps, persona);

      const rows = await db
        .select({ revision: termsAcceptances.revision })
        .from(termsAcceptances)
        .where(eq(termsAcceptances.userId, persona.userId));
      expect(rows).toEqual([{ revision: TERMS_OF_SERVICE_REVISION }]);
    },
    SLOW
  );

  it(
    'seals the persona server material under the KEK with its fingerprint, so a real login can open it',
    async () => {
      const persona = makePersona({ tag: 'mat', emailVerified: true });

      await mintSeedUser(deps, persona);

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      const row = rows[0];
      expect(row?.opaqueKekFingerprint).toEqual(opaqueKekFingerprint(KEK));
      expect(() =>
        openServerMaterial(KEK, persona.userId, new Uint8Array(row?.opaqueServerMaterial ?? []))
      ).not.toThrow();
    },
    SLOW
  );

  it(
    'is idempotent — re-minting the same persona returns created:false and never duplicates',
    async () => {
      const persona = makePersona({ tag: 'i', emailVerified: true });

      const first = await mintSeedUser(deps, persona);
      expect(first.created).toBe(true);

      const second = await mintSeedUser(deps, persona);
      expect(second).toEqual({ userId: persona.userId, created: false });

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      expect(rows).toHaveLength(1);
    },
    SLOW
  );

  it(
    'enrolls TOTP so a code from the persona secret validates via the real verify path',
    async () => {
      const totpSecret = generateTotpSecret();
      const persona = makePersona({ tag: 't', emailVerified: false, totpSecret });

      const result = await mintSeedUser(deps, persona);
      expect(result.created).toBe(true);

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      const row = rows[0];
      expect(row?.totpEnabled).toBe(true);
      expect(row?.totpSecretEncrypted).not.toBeNull();

      const verdict = await decryptAndVerifyTotp({
        encryptionSecret: TOTP_SECRET,
        userId: persona.userId,
        encryptedSecret: new Uint8Array(row?.totpSecretEncrypted ?? new Uint8Array()),
        code: generateTotpCodeSync(totpSecret),
        now: new Date(),
      });
      expect(verdict.ok).toBe(true);
    },
    SLOW
  );

  it('throws when the existing-user lookup fails', async () => {
    const persona = makePersona({ tag: 'lookuperr', emailVerified: true });
    const failing: MintSeedUserDeps = {
      ...deps,
      stores: {
        ...deps.stores,
        users: { ...deps.stores.users, findById: () => errAsync(unavailableError('db down')) },
      },
    };
    await expect(mintSeedUser(failing, persona)).rejects.toThrow(/lookup existing user/);
  });

  it(
    'resolves created:false when registration finds the email already taken',
    async () => {
      const first = makePersona({ tag: 'race1', emailVerified: true });
      const minted = await mintSeedUser(deps, first);
      expect(minted.created).toBe(true);

      // A distinct userId (so the fast-path lookup misses) but the same email:
      // the registration settlement is the authoritative duplicate arbiter.
      const rival = makePersona({ tag: 'race2', emailVerified: true, email: first.email });
      const result = await mintSeedUser(deps, rival);
      expect(result).toEqual({ userId: rival.userId, created: false });
    },
    SLOW
  );

  it(
    'throws when a verified persona has no issued verification token',
    async () => {
      const persona = makePersona({ tag: 'notoken', emailVerified: true });
      const noToken: MintSeedUserDeps = {
        ...deps,
        stores: {
          ...deps.stores,
          verification: {
            ...deps.stores.verification,
            findLatestVerificationToken: () => okAsync(null),
          },
        },
      };
      await expect(mintSeedUser(noToken, persona)).rejects.toThrow(/no verification token/);
    },
    SLOW
  );

  it(
    'throws when the verification token does not verify',
    async () => {
      const persona = makePersona({ tag: 'badverify', emailVerified: true });
      const unverifiable: MintSeedUserDeps = {
        ...deps,
        stores: {
          ...deps.stores,
          verification: {
            ...deps.stores.verification,
            consumeEmailVerification: () => okAsync({ kind: 'invalid' as const }),
          },
        },
      };
      await expect(mintSeedUser(unverifiable, persona)).rejects.toThrow(/did not verify/);
    },
    SLOW
  );

  it(
    'throws when TOTP is already enabled for the persona',
    async () => {
      const persona = makePersona({
        tag: 'totpdup',
        emailVerified: false,
        totpSecret: generateTotpSecret(),
      });
      const alreadyEnabled: MintSeedUserDeps = {
        ...deps,
        stores: {
          ...deps.stores,
          users: { ...deps.stores.users, enableTotp: () => okAsync('already-enabled' as const) },
        },
      };
      await expect(mintSeedUser(alreadyEnabled, persona)).rejects.toThrow(
        /totp was already enabled/
      );
    },
    SLOW
  );
});

describe('the account-side growth seam', () => {
  it(
    'writes the acquisition row through registration when the persona carries a stamp',
    async () => {
      const persona = makePersona({
        tag: 'acq',
        emailVerified: true,
        acquisition: { campaign: GROWTH_DIRECT_CAMPAIGN, platform: 'web' },
      });

      await mintSeedUser(deps, persona);

      const rows = await db
        .select()
        .from(userAcquisition)
        .where(eq(userAcquisition.userId, persona.userId));
      expect(rows[0]?.campaign).toBe(GROWTH_DIRECT_CAMPAIGN);
      expect(rows[0]?.platform).toBe('web');
    },
    SLOW
  );

  it(
    'leaves an account carrying no stamp without an acquisition row',
    async () => {
      const persona = makePersona({ tag: 'noacq', emailVerified: true });

      await mintSeedUser(deps, persona);

      const rows = await db
        .select()
        .from(userAcquisition)
        .where(eq(userAcquisition.userId, persona.userId));
      expect(rows).toHaveLength(0);
    },
    SLOW
  );

  it(
    'dates a minted account back to the instant the cohort it belongs to was created at',
    async () => {
      const persona = makePersona({ tag: 'backdate', emailVerified: true });
      await mintSeedUser(deps, persona);
      const createdAt = new Date(BACKDATED_DAY);

      await setAccountCreatedAt(db, { email: persona.email, createdAt });

      const rows = await db.select().from(users).where(eq(users.id, persona.userId));
      expect(rows[0]?.createdAt.toISOString()).toBe(createdAt.toISOString());
    },
    SLOW
  );

  it('fails loudly when the account to date back does not exist', async () => {
    await expect(
      setAccountCreatedAt(db, {
        email: 'absent@seed-user.test',
        createdAt: new Date(BACKDATED_DAY),
      })
    ).rejects.toThrow('no account to date back');
  });

  it(
    'records the answered channel through the prompt the account itself answers',
    async () => {
      const persona = makePersona({
        tag: 'channel',
        emailVerified: true,
        acquisition: { campaign: GROWTH_DIRECT_CAMPAIGN, platform: 'web' },
      });
      await mintSeedUser(deps, persona);

      const applied = await applySelfReport(
        { store: deps.stores.users, db, userId: persona.userId },
        { action: 'answer', channel: 'podcast', context: 'post_signup' },
        new Date(ANSWERED_DAY)
      );
      expect(applied.isOk()).toBe(true);

      const rows = await db
        .select()
        .from(userAcquisition)
        .where(eq(userAcquisition.userId, persona.userId));
      expect(rows[0]?.selfReportedChannel).toBe('podcast');
      expect(rows[0]?.selfReportedContext).toBe('post_signup');
    },
    SLOW
  );
});

import { describe, expect, it } from 'vitest';
import {
  deriveOpaqueKek,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  opaqueKekFingerprint,
  sealServerMaterial,
  mintServerMaterial,
  openServerMaterial,
  decryptTotpSecret,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import {
  identityResealStore,
  resealServerKeys,
  rotationRefusal,
  secretsFromEnv,
} from './reseal-server-keys.js';
import type { ResealRow, ResealStore, ResealWriteOutcome } from './reseal-server-keys.js';
import type { IdentityUsersStore } from '@hushbox/api/identity';

const CURRENT_KEK = 'reseal-current-kek-thirty-two-chars-min';
const NEXT_KEK = 'reseal-next-kek-thirty-two-chars-minimum';
const CURRENT_TOTP = 'reseal-current-totp-thirty-two-chars-min';
const NEXT_TOTP = 'reseal-next-totp-thirty-two-chars-minimum';

const SECRETS = {
  opaqueKek: CURRENT_KEK,
  opaqueKekNext: NEXT_KEK,
  totpEncryptionSecret: CURRENT_TOTP,
  totpEncryptionSecretNext: NEXT_TOTP,
};

const currentKek = deriveOpaqueKek(textEncoder.encode(CURRENT_KEK));
const nextKek = deriveOpaqueKek(textEncoder.encode(NEXT_KEK));
const currentTotpKey = deriveTotpEncryptionKey(textEncoder.encode(CURRENT_TOTP));
const nextTotpKey = deriveTotpEncryptionKey(textEncoder.encode(NEXT_TOTP));
/** A key the run holds neither half of: a blob under it opens under nothing. */
const foreignTotpKey = deriveTotpEncryptionKey(
  textEncoder.encode('reseal-foreign-totp-thirty-two-chars!!')
);

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
/** The secret a re-enrolment mints, so its blob is not the one the pass read. */
const RE_ENROLLED_SECRET = 'AAAABBBBCCCCDDDD';

/** An in-memory table the pass reads and writes exactly as the store does. */
class FakeStore implements ResealStore {
  readonly rows: ResealRow[] = [];
  reads = 0;

  async addUser(options: {
    readonly withTotp: boolean;
    /** Defaults to whether the row carries a blob; false is the cleared state. */
    readonly totpEnabled?: boolean;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const material = await mintServerMaterial();
    this.rows.push({
      id,
      opaqueServerMaterial: sealServerMaterial(currentKek, id, material),
      opaqueKekFingerprint: opaqueKekFingerprint(currentKek),
      totpSecretEncrypted: options.withTotp
        ? encryptTotpSecret(currentTotpKey, id, TOTP_SECRET)
        : null,
      totpEnabled: options.totpEnabled ?? options.withTotp,
    });
    this.rows.sort((a, b) => a.id.localeCompare(b.id));
    return id;
  }

  readBatch(afterId: string | null, limit: number): Promise<readonly ResealRow[]> {
    this.reads += 1;
    const remaining =
      afterId === null ? this.rows : this.rows.filter((row) => row.id.localeCompare(afterId) > 0);
    return Promise.resolve(remaining.slice(0, limit));
  }

  private index(userId: string): number {
    return this.rows.findIndex((row) => row.id === userId);
  }

  resealMaterial(
    userId: string,
    observed: Uint8Array,
    next: Uint8Array,
    fingerprint: Uint8Array
  ): Promise<ResealWriteOutcome> {
    const at = this.index(userId);
    const row = this.rows[at];
    if (row === undefined || !sameBytes(row.opaqueServerMaterial, observed)) {
      return Promise.resolve('already-done');
    }
    this.rows[at] = { ...row, opaqueServerMaterial: next, opaqueKekFingerprint: fingerprint };
    return Promise.resolve('resealed');
  }

  resealTotp(userId: string, observed: Uint8Array, next: Uint8Array): Promise<ResealWriteOutcome> {
    const at = this.index(userId);
    const row = this.rows[at];
    if (row?.totpSecretEncrypted == null || !sameBytes(row.totpSecretEncrypted, observed)) {
      return Promise.resolve('already-done');
    }
    this.rows[at] = { ...row, totpSecretEncrypted: next };
    return Promise.resolve('resealed');
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function envInput(
  overrides: Readonly<Record<string, string | undefined>> = {}
): Readonly<Record<string, string | undefined>> {
  return {
    OPAQUE_KEK: CURRENT_KEK,
    OPAQUE_KEK_NEXT: NEXT_KEK,
    TOTP_ENCRYPTION_SECRET: CURRENT_TOTP,
    TOTP_ENCRYPTION_SECRET_NEXT: NEXT_TOTP,
    ...overrides,
  };
}

describe('rotationRefusal', () => {
  it('proceeds when both next values differ from their live one', () => {
    expect(rotationRefusal(envInput())).toBeNull();
  });

  it('proceeds when only the KEK next value repeats the live one', () => {
    expect(rotationRefusal(envInput({ OPAQUE_KEK_NEXT: CURRENT_KEK }))).toBeNull();
  });

  it('proceeds when only the TOTP next value repeats the live one', () => {
    expect(rotationRefusal(envInput({ TOTP_ENCRYPTION_SECRET_NEXT: CURRENT_TOTP }))).toBeNull();
  });

  it('refuses when both next values repeat their live one', () => {
    const refusal = rotationRefusal(
      envInput({ OPAQUE_KEK_NEXT: CURRENT_KEK, TOTP_ENCRYPTION_SECRET_NEXT: CURRENT_TOTP })
    );
    expect(refusal).toContain('names a new value');
  });

  it('refuses when a next value is absent', () => {
    expect(rotationRefusal(envInput({ OPAQUE_KEK_NEXT: undefined }))).toContain('OPAQUE_KEK_NEXT');
  });

  it('refuses when a next value is empty', () => {
    expect(rotationRefusal(envInput({ TOTP_ENCRYPTION_SECRET_NEXT: '' }))).toContain(
      'TOTP_ENCRYPTION_SECRET_NEXT'
    );
  });

  it('refuses when a live value is absent', () => {
    expect(rotationRefusal(envInput({ OPAQUE_KEK: undefined }))).toContain('OPAQUE_KEK');
  });
});

describe('secretsFromEnv', () => {
  it('maps the four runner env names onto the pass inputs', () => {
    expect(secretsFromEnv(envInput())).toEqual({
      opaqueKek: CURRENT_KEK,
      opaqueKekNext: NEXT_KEK,
      totpEncryptionSecret: CURRENT_TOTP,
      totpEncryptionSecretNext: NEXT_TOTP,
    });
  });
});

describe('resealServerKeys', () => {
  it('leaves every row on the next fingerprint, openable under the next key', async () => {
    const store = new FakeStore();
    const ids = [
      await store.addUser({ withTotp: false }),
      await store.addUser({ withTotp: false }),
      await store.addUser({ withTotp: false }),
    ];

    const counts = await resealServerKeys({ store, secrets: SECRETS, batchSize: 2 });

    expect(counts.materialResealed).toBe(3);
    expect(counts.remaining).toBe(0);
    for (const id of ids) {
      const row = store.rows.find((candidate) => candidate.id === id);
      if (row === undefined) throw new Error('row vanished');
      expect(row.opaqueKekFingerprint).toEqual(opaqueKekFingerprint(nextKek));
      expect(() => openServerMaterial(nextKek, id, row.opaqueServerMaterial)).not.toThrow();
    }
  });

  it('re-keys a stored TOTP secret alongside, preserving the secret it holds', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true });

    const counts = await resealServerKeys({ store, secrets: SECRETS });

    expect(counts.totpResealed).toBe(1);
    const row = store.rows[0];
    if (row?.totpSecretEncrypted == null) throw new Error('the TOTP blob vanished');
    expect(decryptTotpSecret(nextTotpKey, id, row.totpSecretEncrypted)).toBe(TOTP_SECRET);
  });

  it('reports zero remaining and re-seals nothing on a second pass', async () => {
    const store = new FakeStore();
    await store.addUser({ withTotp: true });
    await store.addUser({ withTotp: false });
    await resealServerKeys({ store, secrets: SECRETS });

    const second = await resealServerKeys({ store, secrets: SECRETS });

    expect(second.materialResealed).toBe(0);
    expect(second.materialSkipped).toBe(2);
    expect(second.totpResealed).toBe(0);
    expect(second.totpSkipped).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it('completes the table when a killed pass is resumed', async () => {
    const store = new FakeStore();
    for (let index = 0; index < 5; index += 1) await store.addUser({ withTotp: false });
    let batches = 0;
    const killed: ResealStore = {
      readBatch: async (afterId, limit) => {
        batches += 1;
        if (batches > 2) throw new Error('killed mid-pass');
        return store.readBatch(afterId, limit);
      },
      resealMaterial: (userId, observed, next, fingerprint) =>
        store.resealMaterial(userId, observed, next, fingerprint),
      resealTotp: (userId, observed, next) => store.resealTotp(userId, observed, next),
    };
    await expect(
      resealServerKeys({ store: killed, secrets: SECRETS, batchSize: 1 })
    ).rejects.toThrow('killed mid-pass');

    const resumed = await resealServerKeys({ store, secrets: SECRETS, batchSize: 2 });

    expect(resumed.remaining).toBe(0);
    expect(resumed.materialResealed + resumed.materialSkipped).toBe(5);
    expect(resumed.materialSkipped).toBeGreaterThan(0);
  });

  it('counts a row another writer changed under it as already done and leaves it alone', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: false });
    const racing: ResealStore = {
      readBatch: (afterId, limit) => store.readBatch(afterId, limit),
      resealTotp: (userId, observed, next) => store.resealTotp(userId, observed, next),
      resealMaterial: async (userId, observed, next, fingerprint) => {
        // The row moves between the read and the compare-and-swap.
        const at = store.rows.findIndex((row) => row.id === userId);
        const row = store.rows[at];
        if (row !== undefined) {
          store.rows[at] = { ...row, opaqueServerMaterial: new Uint8Array([255, 254]) };
        }
        return store.resealMaterial(userId, observed, next, fingerprint);
      },
    };

    const counts = await resealServerKeys({ store: racing, secrets: SECRETS });

    expect(counts.materialResealed).toBe(0);
    expect(counts.materialSkipped).toBe(1);
    // Already-done to the pass, still on the old key in the table: the read-back
    // is what makes the run's exit code say so.
    expect(counts.remaining).toBe(1);
    const row = store.rows.find((candidate) => candidate.id === id);
    expect(row?.opaqueServerMaterial).toEqual(new Uint8Array([255, 254]));
  });

  it('aborts naming the counts, and no user id, when a row will not open under the live key', async () => {
    const store = new FakeStore();
    await store.addUser({ withTotp: false });
    const stranger = crypto.randomUUID();
    const material = await mintServerMaterial();
    const foreignKek = deriveOpaqueKek(textEncoder.encode('reseal-foreign-kek-thirty-two-chars!!'));
    store.rows.push({
      id: stranger,
      opaqueServerMaterial: sealServerMaterial(foreignKek, stranger, material),
      opaqueKekFingerprint: opaqueKekFingerprint(foreignKek),
      totpSecretEncrypted: null,
      totpEnabled: false,
    });
    store.rows.sort((a, b) => a.id.localeCompare(b.id));

    const failure = await resealServerKeys({ store, secrets: SECRETS }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/1 row/);
    expect(message).not.toContain(stranger);
  });

  it('aborts naming the TOTP secret when a stored blob will not open under the live key', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true });
    const row = store.rows[0];
    if (row === undefined) throw new Error('the fixture row vanished');
    store.rows[0] = {
      ...row,
      totpSecretEncrypted: encryptTotpSecret(foreignTotpKey, id, TOTP_SECRET),
    };

    const failure = await resealServerKeys({ store, secrets: SECRETS }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('TOTP_ENCRYPTION_SECRET');
    expect(message).not.toContain(id);
  });

  it('skips an unreadable blob whose second factor is cleared, counting it apart', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true, totpEnabled: false });
    const row = store.rows[0];
    if (row === undefined) throw new Error('the fixture row vanished');
    const stranded = encryptTotpSecret(foreignTotpKey, id, TOTP_SECRET);
    store.rows[0] = { ...row, totpSecretEncrypted: stranded };

    const counts = await resealServerKeys({ store, secrets: SECRETS });

    expect(counts.totpClearedUnreadable).toBe(1);
    expect(counts.totpResealed).toBe(0);
    expect(counts.remaining).toBe(0);
    expect(store.rows[0].totpSecretEncrypted).toEqual(stranded);
  });

  it('still aborts on an unreadable blob whose second factor is enabled', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true });
    const row = store.rows[0];
    if (row === undefined) throw new Error('the fixture row vanished');
    store.rows[0] = {
      ...row,
      totpSecretEncrypted: encryptTotpSecret(foreignTotpKey, id, TOTP_SECRET),
    };

    const failure = await resealServerKeys({ store, secrets: SECRETS }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('TOTP_ENCRYPTION_SECRET');
  });

  it('re-seals a cleared row whose blob still opens under the live key', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true, totpEnabled: false });

    const counts = await resealServerKeys({ store, secrets: SECRETS });

    expect(counts.totpResealed).toBe(1);
    expect(counts.totpClearedUnreadable).toBe(0);
    const blob = store.rows[0]?.totpSecretEncrypted;
    if (blob == null) throw new Error('the TOTP blob vanished');
    expect(decryptTotpSecret(nextTotpKey, id, blob)).toBe(TOTP_SECRET);
  });

  it('counts a TOTP row another writer changed under it as already done', async () => {
    const store = new FakeStore();
    await store.addUser({ withTotp: true });
    const racing: ResealStore = {
      readBatch: (afterId, limit) => store.readBatch(afterId, limit),
      resealMaterial: (userId, observed, next, fingerprint) =>
        store.resealMaterial(userId, observed, next, fingerprint),
      resealTotp: async (userId, observed, next) => {
        const at = store.rows.findIndex((row) => row.id === userId);
        const row = store.rows[at];
        if (row !== undefined) {
          // Another pass re-keys the row between this pass's read and its write.
          store.rows[at] = {
            ...row,
            totpSecretEncrypted: encryptTotpSecret(nextTotpKey, userId, TOTP_SECRET),
          };
        }
        return store.resealTotp(userId, observed, next);
      },
    };

    const counts = await resealServerKeys({ store: racing, secrets: SECRETS });

    expect(counts.totpResealed).toBe(0);
    expect(counts.totpSkipped).toBe(1);
    expect(counts.remaining).toBe(0);
  });

  it('counts a TOTP row left on the live key by another writer as still remaining', async () => {
    const store = new FakeStore();
    await store.addUser({ withTotp: true });
    const racing: ResealStore = {
      readBatch: (afterId, limit) => store.readBatch(afterId, limit),
      resealMaterial: (userId, observed, next, fingerprint) =>
        store.resealMaterial(userId, observed, next, fingerprint),
      resealTotp: async (userId, observed, next) => {
        const at = store.rows.findIndex((row) => row.id === userId);
        const row = store.rows[at];
        if (row !== undefined) {
          // A re-enrolment under the live key lands between this pass's read and
          // its write, so the write misses and the row is still on the old key.
          store.rows[at] = {
            ...row,
            totpSecretEncrypted: encryptTotpSecret(currentTotpKey, userId, RE_ENROLLED_SECRET),
          };
        }
        return store.resealTotp(userId, observed, next);
      },
    };

    const counts = await resealServerKeys({ store: racing, secrets: SECRETS });

    expect(counts.totpSkipped).toBe(1);
    expect(counts.remaining).toBe(1);
  });

  it('rethrows a material blob failure that is not a foreign key id', async () => {
    const store = new FakeStore();
    await store.addUser({ withTotp: false });
    const row = store.rows[0];
    if (row === undefined) throw new Error('the fixture row vanished');
    // The live key's id at the head, garbage behind it: the key is known and
    // the bytes are not a seal.
    store.rows[0] = {
      ...row,
      opaqueServerMaterial: new Uint8Array([...opaqueKekFingerprint(currentKek), 7, 7, 7]),
    };

    const failure = await resealServerKeys({ store, secrets: SECRETS }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('Re-seal aborted');
  });

  it('rethrows a TOTP blob failure that is not a foreign key id', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true });
    const row = store.rows[0];
    if (row === undefined) throw new Error('the fixture row vanished');
    store.rows[0] = {
      ...row,
      totpSecretEncrypted: new Uint8Array([...totpKeyFingerprint(currentTotpKey), 7, 7, 7]),
    };

    const failure = await resealServerKeys({ store, secrets: SECRETS }).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('Re-seal aborted');
    expect((failure as Error).message).not.toContain(id);
  });

  it('leaves the TOTP blobs untouched when only the KEK is rotating', async () => {
    const store = new FakeStore();
    const id = await store.addUser({ withTotp: true });
    const before = store.rows[0]?.totpSecretEncrypted;

    const counts = await resealServerKeys({
      store,
      secrets: { ...SECRETS, totpEncryptionSecretNext: CURRENT_TOTP },
    });

    expect(counts.totpResealed).toBe(0);
    expect(store.rows[0]?.totpSecretEncrypted).toEqual(before);
    expect(store.rows[0]?.opaqueKekFingerprint).toEqual(opaqueKekFingerprint(nextKek));
    expect(id).toBe(store.rows[0]?.id);
  });

  it('leaves the material untouched when only the TOTP key is rotating', async () => {
    const store = new FakeStore();
    await store.addUser({ withTotp: true });
    const before = store.rows[0]?.opaqueServerMaterial;

    const counts = await resealServerKeys({
      store,
      secrets: { ...SECRETS, opaqueKekNext: CURRENT_KEK },
    });

    expect(counts.materialResealed).toBe(0);
    expect(counts.remaining).toBe(0);
    expect(store.rows[0]?.opaqueServerMaterial).toEqual(before);
    expect(counts.totpResealed).toBe(1);
  });
});

describe('identityResealStore', () => {
  const row: ResealRow = {
    id: 'row-id',
    opaqueServerMaterial: new Uint8Array([1]),
    opaqueKekFingerprint: new Uint8Array([2]),
    totpSecretEncrypted: null,
    totpEnabled: false,
  };

  /** The shape of the store's Result channel: `match` over a value or an error. */
  function ok<T>(value: T): { match: (onValue: (value: T) => unknown) => Promise<unknown> } {
    return { match: (onValue) => Promise.resolve(onValue(value)) };
  }

  function failing(): {
    match: (onValue: unknown, onError: (error: unknown) => unknown) => Promise<unknown>;
  } {
    return { match: (_onValue, onError) => Promise.resolve(onError(new Error('store down'))) };
  }

  it('passes the cursor and limit through to the identity store', async () => {
    const calls: (readonly [string | null, number])[] = [];
    const store = identityResealStore({
      readServerMaterialBatch: (afterId: string | null, limit: number) => {
        calls.push([afterId, limit]);
        return ok([row]);
      },
    } as unknown as IdentityUsersStore);

    expect(await store.readBatch('cursor', 25)).toEqual([row]);
    expect(calls).toEqual([['cursor', 25]]);
  });

  it('forwards a material re-seal and answers with its outcome', async () => {
    const store = identityResealStore({
      resealServerMaterial: () => ok('resealed' as const),
    } as unknown as IdentityUsersStore);

    expect(
      await store.resealMaterial('u', new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]))
    ).toBe('resealed');
  });

  it('forwards a TOTP re-seal and answers with its outcome', async () => {
    const store = identityResealStore({
      resealTotpSecret: () => ok('already-done' as const),
    } as unknown as IdentityUsersStore);

    expect(await store.resealTotp('u', new Uint8Array([1]), new Uint8Array([2]))).toBe(
      'already-done'
    );
  });

  it('aborts the run when the identity store fails, naming no row', async () => {
    const store = identityResealStore({
      readServerMaterialBatch: () => failing(),
    } as unknown as IdentityUsersStore);

    await expect(store.readBatch(null, 10)).rejects.toThrow('Re-seal aborted');
  });

  it("names the store error's code and message, and carries no cause", async () => {
    const cause = new Error('relation users does not exist');
    const store = identityResealStore({
      readServerMaterialBatch: () => ({
        match: (_onValue: unknown, onError: (error: unknown) => unknown) =>
          Promise.resolve(
            onError({ code: 'unavailable', message: 'identity store query failed', cause })
          ),
      }),
    } as unknown as IdentityUsersStore);

    const failure = await store.readBatch(null, 10).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('unavailable: identity store query failed');
    // The driver error can quote the bytes a failing statement carried.
    expect((failure as Error).cause).toBeUndefined();
  });

  it('names an unrecognized store failure without reading it', async () => {
    const store = identityResealStore({
      readServerMaterialBatch: () => failing(),
    } as unknown as IdentityUsersStore);

    await expect(store.readBatch(null, 10)).rejects.toThrow('unknown error');
  });

  it('names a store failure that is not an object at all', async () => {
    const store = identityResealStore({
      readServerMaterialBatch: () => ({
        match: (_onValue: unknown, onError: (error: unknown) => unknown) =>
          Promise.resolve(onError('store down')),
      }),
    } as unknown as IdentityUsersStore);

    await expect(store.readBatch(null, 10)).rejects.toThrow('unknown error');
  });
});

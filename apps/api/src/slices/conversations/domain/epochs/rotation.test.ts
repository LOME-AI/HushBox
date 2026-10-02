import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { applyRotation, epochRowId, planEpochWraps } from './rotation.js';
import { fakeStores } from '../test-fixtures.js';
import type { RotationBody } from '../schemas.js';

describe('planEpochWraps', () => {
  const visibility = new Map([
    ['keyA', 1],
    ['keyB', 3],
  ]);

  it('plans one wrap row per active member with the server-enforced visibility', () => {
    const plan = planEpochWraps(visibility, [
      { memberPublicKey: 'keyA', wrap: 'wrapA' },
      { memberPublicKey: 'keyB', wrap: 'wrapB' },
    ]);
    expect(plan).toEqual([
      { memberPublicKey: 'keyA', wrap: 'wrapA', visibleFromEpoch: 1 },
      { memberPublicKey: 'keyB', wrap: 'wrapB', visibleFromEpoch: 3 },
    ]);
  });

  it('rejects a wrap set missing an active member', () => {
    expect(planEpochWraps(visibility, [{ memberPublicKey: 'keyA', wrap: 'wrapA' }])).toBeNull();
  });

  it('rejects a wrap set naming a non-member key', () => {
    expect(
      planEpochWraps(visibility, [
        { memberPublicKey: 'keyA', wrap: 'wrapA' },
        { memberPublicKey: 'keyX', wrap: 'wrapX' },
      ])
    ).toBeNull();
  });

  it('rejects duplicate wraps for one member key', () => {
    expect(
      planEpochWraps(visibility, [
        { memberPublicKey: 'keyA', wrap: 'wrapA' },
        { memberPublicKey: 'keyA', wrap: 'wrapA2' },
        { memberPublicKey: 'keyB', wrap: 'wrapB' },
      ])
    ).toBeNull();
  });

  it('rejects a duplicate that masks a missing member at equal counts', () => {
    expect(
      planEpochWraps(visibility, [
        { memberPublicKey: 'keyA', wrap: 'wrapA' },
        { memberPublicKey: 'keyA', wrap: 'wrapA2' },
      ])
    ).toBeNull();
  });
});

const B64 = toBase64(new Uint8Array([1, 2, 3]));
const rotation: RotationBody = {
  expectedEpoch: 1,
  epochPublicKey: B64,
  confirmationHash: B64,
  chainLink: B64,
  memberWraps: [{ memberPublicKey: B64, wrap: B64 }],
  encryptedTitle: B64,
};

/**
 * Both defect arms assert invariants the conversation lock already
 * guarantees, so they are stageable only with fakes.
 */
describe('rotation defect arms', () => {
  it('treats a lost rotation claim under the conversation lock as a defect', async () => {
    const stores = fakeStores({ conversations: { claimRotation: () => okAsync(false) } });
    await expect(
      applyRotation(stores, {
        conversationId: 'c1',
        rotation,
        plan: [],
        writeTitle: true,
        predecessorEpochId: 'e1',
      })
    ).rejects.toThrow(/rotation claim lost/);
  });

  it('treats a missing current epoch row as a defect', async () => {
    const stores = fakeStores({ epochs: { byNumber: () => okAsync(null) } });
    await expect(epochRowId(stores, 'c1', 1)).rejects.toThrow(/current epoch row missing/);
  });
});

describe('epochRowId', () => {
  it('answers the row id of the named epoch', async () => {
    const stores = fakeStores({ epochs: { byNumber: () => okAsync({ id: 'e7' }) } });
    const id = await epochRowId(stores, 'c1', 7);
    expect(id._unsafeUnwrap()).toBe('e7');
  });
});

describe('applyRotation writes', () => {
  interface Recorded {
    claims: (Uint8Array | null)[];
    calls: string[];
    exceptKeys: Uint8Array[][];
    forKeys: Uint8Array[][];
    deleteScopes: string[];
    previousEpochIds: (string | null)[];
  }

  function recordingStores(recorded: Recorded): ReturnType<typeof fakeStores> {
    return fakeStores({
      conversations: {
        claimRotation: ({ encryptedTitle }) => {
          recorded.claims.push(encryptedTitle);
          recorded.calls.push('claim');
          return okAsync(true);
        },
      },
      epochs: {
        deleteWrapsExceptKeys: (conversationId, keys) => {
          recorded.deleteScopes.push(conversationId);
          recorded.exceptKeys.push([...keys]);
          recorded.calls.push('deleteExcept');
          return okAsync();
        },
        deleteWrapsForKeys: (conversationId, keys) => {
          recorded.deleteScopes.push(conversationId);
          recorded.forKeys.push([...keys]);
          recorded.calls.push('deleteFor');
          return okAsync();
        },
        insert: ({ previousEpochId }) => {
          recorded.previousEpochIds.push(previousEpochId);
          recorded.calls.push('insertEpoch');
          return okAsync({ id: 'e2' });
        },
        insertWraps: () => {
          recorded.calls.push('insertWraps');
          return okAsync();
        },
      },
    });
  }

  function recorder(): Recorded {
    return {
      claims: [],
      calls: [],
      exceptKeys: [],
      forKeys: [],
      deleteScopes: [],
      previousEpochIds: [],
    };
  }

  const keyA = toBase64(new Uint8Array([10]));
  const keyB = toBase64(new Uint8Array([11]));
  const plan = [
    { memberPublicKey: keyA, wrap: B64, visibleFromEpoch: 1 },
    { memberPublicKey: keyB, wrap: B64, visibleFromEpoch: 2 },
  ];

  it('claims the rotation with the body title when the write is allowed', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c1',
      rotation,
      plan: [],
      writeTitle: true,
      predecessorEpochId: 'e1',
    });
    expect(rotated._unsafeUnwrap()).toEqual({ newEpochNumber: 2 });
    expect(recorded.claims).toEqual([fromBase64(B64)]);
  });

  it('claims the rotation with no title when the write is not allowed', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c1',
      rotation,
      plan: [],
      writeTitle: false,
      predecessorEpochId: 'e1',
    });
    expect(rotated._unsafeUnwrap()).toEqual({ newEpochNumber: 2 });
    expect(recorded.claims).toEqual([null]);
  });

  it('chains the new epoch to the predecessor it is given', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c1',
      rotation,
      plan,
      writeTitle: true,
      predecessorEpochId: 'e-predecessor',
    });
    expect(rotated.isOk()).toBe(true);
    expect(recorded.previousEpochIds).toEqual(['e-predecessor']);
  });

  it('deletes every wrap of a key outside the plan', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c1',
      rotation,
      plan,
      writeTitle: true,
      predecessorEpochId: 'e1',
    });
    expect(rotated.isOk()).toBe(true);
    expect(recorded.exceptKeys).toEqual([[fromBase64(keyA), fromBase64(keyB)]]);
  });

  it('deletes the older wraps of only the keys this rotation seats', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c1',
      rotation,
      plan,
      writeTitle: true,
      predecessorEpochId: 'e1',
    });
    expect(rotated.isOk()).toBe(true);
    expect(recorded.forKeys).toEqual([[fromBase64(keyB)]]);
  });

  it('scopes both deletions to the rotating conversation', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c-rotating',
      rotation,
      plan,
      writeTitle: true,
      predecessorEpochId: 'e1',
    });
    expect(rotated.isOk()).toBe(true);
    expect(recorded.deleteScopes).toEqual(['c-rotating', 'c-rotating']);
  });

  it('deletes before it writes the new wraps', async () => {
    const recorded = recorder();
    const rotated = await applyRotation(recordingStores(recorded), {
      conversationId: 'c1',
      rotation,
      plan,
      writeTitle: true,
      predecessorEpochId: 'e1',
    });
    expect(rotated.isOk()).toBe(true);
    expect(recorded.calls).toEqual([
      'claim',
      'deleteExcept',
      'deleteFor',
      'insertEpoch',
      'insertWraps',
    ]);
  });
});

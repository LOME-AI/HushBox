import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { rotateEpoch } from './rotate.js';
import { conversationRecord, fakeStores, memberRecord } from '../test-fixtures.js';
import type { RotateEpochBody } from '@hushbox/shared';

/**
 * The defect arm no route can reach: an active member row whose `users` row
 * is gone cannot exist under the conversation lock, because account deletion
 * stamps every membership left before it deletes the user.
 */

const B64 = toBase64(new Uint8Array([1, 2, 3]));

const recoveryBody: RotateEpochBody = {
  expectedEpoch: 2,
  predecessorEpoch: 1,
  epochPublicKey: B64,
  confirmationHash: B64,
  chainLink: B64,
  memberWraps: [{ memberPublicKey: B64, wrap: B64 }],
  encryptedTitle: B64,
};

describe('rotateEpoch defect arms', () => {
  it('treats an active member without a users row as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ currentEpoch: 2 })) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      rotateEpoch(stores, { conversationId: 'c1', callerUserId: 'owner', body: recoveryBody })
    ).rejects.toThrow(/users row missing for an active member/);
  });
});

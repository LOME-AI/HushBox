import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage, EpochIntegrityPage, readKeyChain } from '../pages/index.js';
import { requireEnv } from '../helpers/env.js';
import { idempotentPost } from '../helpers/idempotent-request.js';
import { expectOkResponse } from '../helpers/ok-response.js';
import { personaEmail } from '../helpers/personas.js';
import { withRequestRetry } from '../helpers/resilient-request.js';
import { TIMEOUTS } from '../config/timeouts.js';
import type { APIRequestContext } from '../fixtures.js';
import type { MessageResponse, RotateEpochBody, RotateEpochOutcome } from '@hushbox/shared';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

const apiUrl = requireEnv('VITE_API_URL');

/** Long enough to stand for a wrap or chain link; its bytes are never meant to open. */
const JUNK_BLOB_BYTES = 96;
const KEY_BYTES = 32;

/**
 * A group of the owner and three members: Bob, Dave, and Charlie. Charlie never
 * signs in; his seat is there so that every rotation must wrap to a member no
 * open page holds, beside the one who departs and the one who submits it.
 */
async function seatGroup(request: APIRequestContext, firstMessage: string): Promise<string> {
  const aliceEmail = personaEmail('test-alice');
  const response = await idempotentPost(request, '/dev/group-chat', {
    data: {
      ownerEmail: aliceEmail,
      memberEmails: [
        personaEmail('test-bob'),
        personaEmail('test-dave'),
        personaEmail('test-charlie'),
      ],
      messages: [{ senderEmail: aliceEmail, content: firstMessage, senderType: 'user' }],
    },
  });
  await expectOkResponse(response, 'dev group-chat creation');
  return ((await response.json()) as { conversationId: string }).conversationId;
}

async function leave(request: APIRequestContext, url: string): Promise<void> {
  const response = await idempotentPost(request, url, { data: {} });
  await expectOkResponse(response, 'leave');
}

function junkBase64(byteLength: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(byteLength))).toString('base64');
}

/**
 * A rotation whose every byte is random, submitted by a member. The server
 * holds no key, so it can check only the wrap set against the live seats, and
 * accepts it; each member's client must find that the new epoch's key does not
 * open. Random wraps need no private key, which is what lets a request context
 * stand in for a hostile client.
 */
async function postJunkRotation(
  request: APIRequestContext,
  conversationId: string,
  expectedEpoch: number
): Promise<RotateEpochOutcome> {
  const keys = await request.get(`/conversations/${conversationId}/member-keys`);
  await expectOkResponse(keys, 'member-keys read');
  const { members } = (await keys.json()) as { members: { publicKey: string }[] };
  const body: RotateEpochBody = {
    expectedEpoch,
    epochPublicKey: junkBase64(KEY_BYTES),
    confirmationHash: junkBase64(KEY_BYTES),
    chainLink: junkBase64(JUNK_BLOB_BYTES),
    memberWraps: members.map((member) => ({
      memberPublicKey: member.publicKey,
      wrap: junkBase64(JUNK_BLOB_BYTES),
    })),
    encryptedTitle: junkBase64(JUNK_BLOB_BYTES),
  };
  const response = await idempotentPost(request, `/conversations/${conversationId}/epochs`, {
    data: body,
  });
  await expectOkResponse(response, 'junk rotation');
  return (await response.json()) as RotateEpochOutcome;
}

async function readMessages(
  request: APIRequestContext,
  conversationId: string
): Promise<MessageResponse[]> {
  const response = await request.get(`/conversations/${conversationId}/messages`);
  await expectOkResponse(response, 'conversation messages read');
  return ((await response.json()) as { messages: MessageResponse[] }).messages;
}

test.describe('Epoch rotation', SPEC_MATRIX, () => {
  test("a member's departure waits for the owner's client to rotate it out", async ({
    authenticatedPage,
    authenticatedRequest,
    testBobRequest,
  }) => {
    const conversationId = await seatGroup(authenticatedRequest, 'Before the departure');
    const seated = await readKeyChain(authenticatedRequest, conversationId);

    await test.step('Bob leaves without rotating anything', async () => {
      await leave(testBobRequest, `/conversations/${conversationId}/leave`);
      const afterLeave = await readKeyChain(authenticatedRequest, conversationId);
      expect(afterLeave.currentEpoch).toBe(seated.currentEpoch);
      expect(afterLeave.rotationPending).toBe(true);
    });

    const chatPage = new ChatPage(authenticatedPage);
    const keyState = new EpochIntegrityPage(authenticatedPage);
    const releaseRotation = await keyState.holdRotations(conversationId);

    await test.step("the owner's open shows the pause while its rotation is in flight", async () => {
      await chatPage.gotoConversation(conversationId);
      await keyState.waitForState('pending');
      await expect(keyState.banner).toBeVisible();
    });

    await test.step("the owner's rotation lands", async () => {
      releaseRotation();
      await keyState.waitForState('verified');
      const rotated = await readKeyChain(authenticatedRequest, conversationId);
      expect(rotated.currentEpoch).toBe(seated.currentEpoch + 1);
      expect(rotated.rotationPending).toBe(false);
    });

    await test.step('the owner sends under the new epoch', async () => {
      await chatPage.waitForConversationLoaded();
      const aiToggle = chatPage.getAiToggleButton();
      await aiToggle.click();
      await expect(aiToggle).toHaveAttribute('aria-pressed', 'false');

      const before = await readMessages(authenticatedRequest, conversationId);
      const text = `After the rotation ${crypto.randomUUID()}`;
      await chatPage.sendFollowUpMessage(text);
      await chatPage.expectMessageVisible(text);

      // The bubble can render before the send's write returns, so the count is
      // polled rather than read once.
      await expect
        .poll(
          async () => {
            const messages = await readMessages(authenticatedRequest, conversationId);
            return messages.length;
          },
          { timeout: TIMEOUTS.ASSERT }
        )
        .toBe(before.length + 1);
      const after = await readMessages(authenticatedRequest, conversationId);
      const newestSequence = Math.max(...after.map((message) => message.sequenceNumber));
      const newest = after.find((message) => message.sequenceNumber === newestSequence);
      expect(newest?.senderType).toBe('user');
      expect(newest?.epochNumber).toBe(seated.currentEpoch + 1);
    });
  });

  test("an owner's client recovers the conversation from a member's junk rotation", async ({
    authenticatedPage,
    authenticatedRequest,
    testBobRequest,
    testDavePage,
  }) => {
    const preAttackMessage = 'Written before the attack';
    const conversationId = await seatGroup(authenticatedRequest, preAttackMessage);
    const seated = await readKeyChain(authenticatedRequest, conversationId);

    await test.step('Dave leaves', async () => {
      // A page-derived context carries the preview server's base URL, so the
      // API origin is named in the path.
      await leave(
        withRequestRetry(testDavePage.request),
        `${apiUrl}/conversations/${conversationId}/leave`
      );
    });

    await test.step('Bob answers the pending departure with a junk rotation', async () => {
      const outcome = await postJunkRotation(testBobRequest, conversationId, seated.currentEpoch);
      expect(outcome).toEqual({ rotated: true, newEpochNumber: seated.currentEpoch + 1 });
    });

    const chatPage = new ChatPage(authenticatedPage);
    const keyState = new EpochIntegrityPage(authenticatedPage);
    const releaseRecovery = await keyState.holdRotations(conversationId);

    await test.step("the owner's open raises the alert while its recovery is in flight", async () => {
      await chatPage.gotoConversation(conversationId);
      await keyState.waitForState('bad');
      await expect(keyState.banner).toBeVisible();
    });

    await test.step('the recovery chains a new epoch to the last one that verified', async () => {
      releaseRecovery();
      await keyState.waitForState('verified');
      const recovered = await readKeyChain(authenticatedRequest, conversationId);
      expect(recovered.currentEpoch).toBe(seated.currentEpoch + 2);
      expect(recovered.rotationPending).toBe(false);
      const current = recovered.epochs.find(
        (epoch) => epoch.epochNumber === recovered.currentEpoch
      );
      expect(current?.previousEpochNumber).toBe(seated.currentEpoch);
    });

    await test.step('after a reload the pre-attack message reads', async () => {
      await authenticatedPage.reload({ waitUntil: 'domcontentloaded' });
      await keyState.waitForState('verified');
      await chatPage.waitForConversationLoaded();
      await chatPage.expectMessageVisible(preAttackMessage);
      await expect(keyState.invalidKeysNotices).toHaveCount(0);
    });
  });
});

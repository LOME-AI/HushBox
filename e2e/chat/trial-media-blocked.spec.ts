import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { createInviteLink } from '../helpers/invite-link.js';
import { requireEnv } from '../helpers/env.js';
import { expectSharedConversationLoaded } from '../helpers/link-assertions.js';
import { TIMEOUTS } from '../config/timeouts.js';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * Lane 9 #3: server-side rejection of media generation for non-authenticated
 * tiers. Two contracts are locked:
 *
 *   1. Unauthenticated POST `/api/chat/{id}/stream` with `modality: 'image'`
 *      is rejected before billing/model resolution.
 *   2. A link-guest with a write-privileged invite link (i.e. a session that
 *      passes the privilege middleware) is rejected with `MEDIA_TRIAL_BLOCKED`
 *      / 403 — the rule at `chat.ts:1095-1097` blocking media for any link
 *      guest regardless of privilege.
 */
test.describe('Trial / Link-Guest Media Blocked', () => {
  test('unauthenticated POST to /api/chat/:id/stream with image modality is rejected', async ({
    unauthenticatedPage,
    testConversation,
  }) => {
    // testConversation is owned by Alice — but we're posting from a context with
    // empty cookies, so the session middleware must reject the request before
    // it can reach the modality dispatch.
    const response = await unauthenticatedPage.request.post(
      `${apiUrl}/api/chat/${testConversation.id}/stream`,
      {
        data: {
          modality: 'image',
          models: ['google/imagen-4.0-generate-001'],
          userMessage: {
            id: '11111111-1111-4111-8111-111111111111',
            content: 'Trial image attempt',
          },
          messagesForInference: [{ role: 'user', content: 'Trial image attempt' }],
          fundingSource: 'personal_balance',
          imageConfig: { aspectRatio: '1:1' },
        },
      }
    );

    // The route is gated by ironSession + sessionMiddleware. Without a session
    // cookie and without an X-Link-Public-Key header, requirePrivilege returns
    // 401 NOT_AUTHENTICATED — the media-trial-blocked branch never runs.
    expect(response.status()).toBe(401);
  });

  test('link-guest write-privileged session is rejected with MEDIA_TRIAL_BLOCKED on image stream', async ({
    authenticatedPage,
    groupConversation,
    createPage,
  }) => {
    test.slow();

    // Owner sets up a write-privileged invite link with full history. The
    // existing fixture already gives us a group conversation with members.
    const ownerChat = new ChatPage(authenticatedPage);
    await ownerChat.gotoConversation(groupConversation.id);
    await ownerChat.waitForConversationLoaded();

    const sidebar = new MemberSidebarPage(authenticatedPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    const { url: inviteUrl } = await createInviteLink(authenticatedPage, sidebar, {
      privilege: 'write',
      withHistory: true,
      closeMethod: 'escape',
      extractLinkId: false,
    });
    expect(inviteUrl).toContain('/share/c/');

    // Guest joins via the invite URL. The /share/c route runs the link-key
    // derivation and stashes the public key in module-level state via
    // setLinkGuestAuth(). Once the page is loaded, frontend API requests
    // automatically attach the `X-Link-Public-Key` header.
    const guest = await createPage();

    // Capture the link public key by sniffing the first request the frontend
    // makes against the API (typically `/api/conversations/...` or members).
    // This is more robust than reaching into the module's internals across
    // Vite's bundler boundary.
    let linkPublicKey: string | null = null;
    guest.on('request', (request) => {
      if (linkPublicKey !== null) return;
      if (!request.url().startsWith(apiUrl)) return;
      const value = request.headers()['x-link-public-key'];
      if (value) linkPublicKey = value;
    });

    await guest.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
    await expectSharedConversationLoaded(guest);

    // Wait until the guest page has fired at least one API request that
    // carried the link-public-key header.
    await expect.poll(() => linkPublicKey, { timeout: TIMEOUTS.CONVERSATION_LOAD }).not.toBeNull();
    expect(linkPublicKey, 'guest page should have set the link public key').toBeTruthy();

    const response = await guest.request.post(`${apiUrl}/api/chat/${groupConversation.id}/stream`, {
      headers: { 'X-Link-Public-Key': linkPublicKey! },
      data: {
        modality: 'image',
        models: ['google/imagen-4.0-generate-001'],
        userMessage: {
          id: '22222222-2222-4222-8222-222222222222',
          content: 'Link guest image attempt',
        },
        messagesForInference: [{ role: 'user', content: 'Link guest image attempt' }],
        fundingSource: 'owner_balance',
        imageConfig: { aspectRatio: '1:1' },
      },
    });

    // The route resolves the link guest, then hits the trial-block branch.
    expect(response.status()).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('MEDIA_TRIAL_BLOCKED');
  });
});

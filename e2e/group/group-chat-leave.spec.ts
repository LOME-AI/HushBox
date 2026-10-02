import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { setupConversationWithSidebar } from '../helpers/group-test-setup.js';
import {
  ChatPage,
  EpochIntegrityPage,
  MemberSidebarPage,
  SidebarPage,
  readKeyChain,
} from '../pages/index.js';
import { waitForAppStable } from '../helpers/page-signals.js';
import { gotoToleratingBounce } from '../helpers/navigation.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/** The title the owner sets before a member departs, and reads back after. */
const OWNER_TITLE = 'Owner set this title';

// Navigating back into a conversation the user just left or destroyed re-mounts
// realtime before the members refetch marks access revoked, so the socket
// attempts one handshake the server rejects. The browser logs the rejected
// upgrade; the app drops the socket once access resolves.
const WS_HANDSHAKE_REJECTED_AFTER_LEAVE =
  /WebSocket connection to .* failed: The server did not accept the WebSocket handshake/;

// After a member leaves, the client briefly prefetches now-inaccessible
// per-conversation resources for the just-left conversation id, and re-mounts
// realtime once before access resolves. Backend routes are bare (no `/api/`
// prefix) with the subresource after the id. Reads of the conversation and its
// messages/members/links/keychain/budgets 404 (gone or access revoked), and the
// rejected websocket upgrade for the just-left id 404s the same way (one
// browser-timing-dependent attempt, then the app drops the socket); the
// membership-gated budgets read can also 403 for a non-owner. Scoped to these
// exact conversation-subresource reads and the observed statuses so an
// unexpected error elsewhere still fails the test.
const POST_LEAVE_PREFETCH_404 =
  /404 Not Found GET .*\/conversations\/[0-9a-f-]+(?:\/(?:messages|members|links|keychain|budgets|websocket))?(?=\?|\s|$)/;
const POST_LEAVE_BUDGETS_403 =
  /403 Forbidden GET .*\/conversations\/[0-9a-f-]+\/budgets(?=\?|\s|$)/;

test.describe('Group Chat Leave', SPEC_MATRIX, () => {
  // Each test is destructive (leaving a conversation), so each gets its own groupConversation fixture
  test('non-owner leave navigates to /chat', async ({ testBobPage, groupConversation }) => {
    // Deliberate: after Bob leaves and navigates back to the conversation
    // URL, the router prefetches per-conversation resources Bob has now
    // lost access to — the conversation reads 404 and the budgets read 403.
    expectApiErrors(testBobPage, [POST_LEAVE_PREFETCH_404, POST_LEAVE_BUDGETS_403]);
    expectConsoleErrors(testBobPage, [
      /Failed to load resource: the server responded with a status of 404/,
      /Failed to load resource: the server responded with a status of 403/,
      WS_HANDSHAKE_REJECTED_AFTER_LEAVE,
    ]);
    // Verify message visibility BEFORE opening sidebar — on mobile the sidebar
    // is a modal Sheet that covers the chat, making messages invisible.
    const chatPage = new ChatPage(testBobPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectMessageVisible('Hello from Alice');

    const sidebar = new MemberSidebarPage(testBobPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    await test.step('trigger leave and verify warning', async () => {
      const bobMemberId = await sidebar.getMemberIdByUsername('test_bob');
      await sidebar.openMemberActions(bobMemberId);
      await sidebar.clickLeave();

      const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
      await expect(modal).toBeVisible();
      await expect(testBobPage.getByTestId(TEST_IDS.leaveConfirmationWarning)).toBeVisible();
    });

    await test.step('confirm leave navigates away', async () => {
      await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
      await expect(testBobPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    await test.step('navigating back to conversation redirects', async () => {
      // The access guard client-redirects a non-member to /chat, which can
      // interrupt this navigation before it commits — that bounce is the proof.
      await gotoToleratingBounce(testBobPage, `/chat/${groupConversation.id}`);
      // Should redirect away since Bob is no longer a member
      await expect(testBobPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: TIMEOUTS.ROUTE,
      });
    });
  });

  test('owner leave shows deletion warning and destroys conversation', async ({
    authenticatedPage,
    groupConversation,
  }) => {
    test.slow();
    // Deliberate: after the owner leaves, the conversation is destroyed.
    // The post-leave `goto` then prefetches resources that no longer
    // exist for anyone — the conversation and its subresources read 404.
    expectApiErrors(authenticatedPage, [POST_LEAVE_PREFETCH_404, POST_LEAVE_BUDGETS_403]);
    expectConsoleErrors(authenticatedPage, [
      /Failed to load resource: the server responded with a status of 404/,
      /Failed to load resource: the server responded with a status of 403/,
      WS_HANDSHAKE_REJECTED_AFTER_LEAVE,
    ]);
    const { sidebar } = await setupConversationWithSidebar(authenticatedPage, groupConversation.id);

    await test.step('trigger leave and verify owner-specific warning', async () => {
      const aliceMemberId = await sidebar.getMemberIdByUsername('test_alice');
      await sidebar.openMemberActions(aliceMemberId);
      await sidebar.clickLeave();

      const modal = authenticatedPage.getByTestId(TEST_IDS.leaveConfirmationModal);
      await expect(modal).toBeVisible();

      // Owner gets a stronger warning about deleting the conversation
      const warning = authenticatedPage.getByTestId(TEST_IDS.leaveConfirmationWarning);
      await expect(warning).toBeVisible();
    });

    await test.step('confirm leave navigates away', async () => {
      await authenticatedPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
      await expect(authenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    await test.step('conversation no longer accessible', async () => {
      // The post-destroy redirect to /chat can interrupt this navigation before
      // it commits — that interruption is the proof the conversation is gone.
      await gotoToleratingBounce(authenticatedPage, `/chat/${groupConversation.id}`);
      await expect(authenticatedPage).not.toHaveURL(new RegExp(groupConversation.id), {
        timeout: TIMEOUTS.ROUTE,
      });
    });
  });

  test("a non-owner's sidebar leave defers the key rotation to the owner's open", async ({
    authenticatedPage,
    authenticatedRequest,
    testBobPage,
    groupConversation,
  }) => {
    // Deliberate: after Bob leaves and `goto`s back to the conversation,
    // the prefetch for per-conversation resources he can no longer access
    // reads 404 for the conversation and 403 for the membership-gated budgets.
    expectApiErrors(testBobPage, [POST_LEAVE_PREFETCH_404, POST_LEAVE_BUDGETS_403]);
    expectConsoleErrors(testBobPage, [
      /Failed to load resource: the server responded with a status of 404/,
      /Failed to load resource: the server responded with a status of 403/,
      WS_HANDSHAKE_REJECTED_AFTER_LEAVE,
    ]);
    // The keychain is read by the owner throughout: the departing member loses
    // the conversation with their seat.
    const beforeLeave = await readKeyChain(authenticatedRequest, groupConversation.id);
    expect(beforeLeave.rotationPending).toBe(false);

    const chatPage = new ChatPage(testBobPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectMessageVisible('Hello from Alice');

    await test.step('Bob leaves from the sidebar dropdown', async () => {
      const sidebar = new SidebarPage(testBobPage);
      await sidebar.openMoreMenu(groupConversation.id);
      await testBobPage.getByRole('menuitem', { name: 'Leave' }).click();

      const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
      await expect(modal).toBeVisible();

      await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();

      // Leaving the active conversation redirects to /chat, and the redirect
      // follows the leave mutation resolving, so the departure has committed.
      await expect(testBobPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });

    await test.step('the departure leaves the epoch in place, pending a rotation', async () => {
      const afterLeave = await readKeyChain(authenticatedRequest, groupConversation.id);
      expect(afterLeave.currentEpoch).toBe(beforeLeave.currentEpoch);
      expect(afterLeave.rotationPending).toBe(true);
    });

    await test.step("the owner's open rotates the departed member out", async () => {
      const ownerChat = new ChatPage(authenticatedPage);
      await ownerChat.gotoConversation(groupConversation.id);
      // The keychain the owner loads is pending, so a verified verdict can only
      // come from the rotation the owner's client submits and then re-reads.
      await new EpochIntegrityPage(authenticatedPage).waitForState('verified');

      const rotated = await readKeyChain(authenticatedRequest, groupConversation.id);
      expect(rotated.currentEpoch).toBe(beforeLeave.currentEpoch + 1);
      expect(rotated.rotationPending).toBe(false);
    });

    await test.step('Bob can no longer open the conversation', async () => {
      // The non-member redirect to /chat can interrupt this navigation before
      // it commits; that bounce is expected.
      await gotoToleratingBounce(testBobPage, `/chat/${groupConversation.id}`);
      await expect(testBobPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });
  });

  test('leave from sidebar of a non-active chat leaves URL unchanged', async ({
    testBobPage,
    groupConversation,
  }) => {
    // Bob lands on /chat (no conversation active) and leaves the group from the
    // sidebar dropdown. The URL must NOT change to /chat — only the active
    // chat's Leave should redirect.
    await testBobPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(testBobPage);

    const sidebar = new SidebarPage(testBobPage);
    await sidebar.openMoreMenu(groupConversation.id);
    await testBobPage.getByRole('menuitem', { name: 'Leave' }).click();

    const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

    // URL stays at /chat (the listing dashboard) — no forced redirect.
    await expect(testBobPage).toHaveURL('/chat');

    // And the conversation is gone from Bob's sidebar.
    await expect(sidebar.getChatLink(groupConversation.id)).not.toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
  });

  test("a member's leave leaves the owner's title readable", async ({
    authenticatedPage,
    testBobPage,
    groupConversation,
  }) => {
    // A departure changes no key, and nobody opens the conversation here to
    // rotate it, so the title stays wrapped under the epoch it was set at. The
    // owner must still read it back once the member has gone.
    const ownerSidebar = new SidebarPage(authenticatedPage);
    await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(authenticatedPage);
    await ownerSidebar.renameConversation(groupConversation.id, OWNER_TITLE);

    await testBobPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(testBobPage);
    const bobSidebar = new SidebarPage(testBobPage);
    await bobSidebar.openMoreMenu(groupConversation.id);
    await testBobPage.getByRole('menuitem', { name: 'Leave' }).click();
    await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
    await expect(bobSidebar.getChatLink(groupConversation.id)).not.toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });

    // Re-read from the server rather than from the owner's in-memory cache.
    await authenticatedPage.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppStable(authenticatedPage);
    await ownerSidebar.ensureSidebarExpanded();
    await expect(ownerSidebar.getChatLink(groupConversation.id)).toContainText(OWNER_TITLE, {
      timeout: TIMEOUTS.ASSERT,
    });
  });

  test('cancel leave keeps user in conversation', async ({ testBobPage, groupConversation }) => {
    // Verify message visibility BEFORE opening sidebar — on mobile the sidebar
    // is a modal Sheet that covers the chat, making messages invisible.
    const chatPage = new ChatPage(testBobPage);
    await chatPage.gotoConversation(groupConversation.id);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectMessageVisible('Hello from Alice');

    const sidebar = new MemberSidebarPage(testBobPage);
    await sidebar.openViaFacepile();
    await sidebar.waitForLoaded();

    const bobMemberId = await sidebar.getMemberIdByUsername('test_bob');
    await sidebar.openMemberActions(bobMemberId);
    await sidebar.clickLeave();

    const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
    await expect(modal).toBeVisible();

    await testBobPage.getByTestId(TEST_IDS.leaveConfirmationCancel).click();
    // Radix Dialog close is CSS-animation only; give it the modal budget to
    // finish unmounting on slow webkit.
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

    // Close sidebar so message list is accessible on mobile
    await sidebar.closeSidebar();

    await expect(testBobPage).toHaveURL(new RegExp(groupConversation.id));
    await chatPage.assertMessageVisible('Hello from Alice');
  });
});

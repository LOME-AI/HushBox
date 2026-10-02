import { TEST_IDS } from '@hushbox/shared';
import { test as base, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { ChatPage, SettingsPage, TwoFactorSetupModal } from '../pages';
import { navigateToSettings } from '../helpers/auth.js';
import { idempotentDelete } from '../helpers/idempotent-request.js';
import { expectOkResponse, type CheckedResponse } from '../helpers/ok-response.js';
import { captureChatRoutePayload } from '../helpers/route-payload.js';
import { TIMEOUTS } from '../config/timeouts.js';

const SPEC_MATRIX = matrix({ engine: 'engine-matrix', formFactor: 'either' });

/**
 * The instruction saved through the modal and then asserted on the outbound
 * turn. Its length (50) is quoted literally by the character-counter
 * assertions below — editing this string means editing those too.
 */
const INSTRUCTIONS = 'Always respond in bullet points. Never use emojis.';

/**
 * Auto-fixture whose teardown always clears the account instruction this file
 * saves. The value is never read (`null` — Playwright requires a defined type).
 *
 * GLOBAL STATE: a saved instruction lives server-side on the worker's pooled
 * persona, which a fresh browser context does not reset. The window between the
 * save and the in-test clear spans a document load, a send and a streamed
 * response, so a failure anywhere in it would leave the instruction set — and
 * the first step's "Not set" badge assertion would then fail deterministically
 * on any retry landing on the same worker slot, replacing the original failure
 * with a bogus one and denying the retry its chance to reproduce. Clearing in
 * teardown covers the failure path; the suite bans `afterEach` in specs, so a
 * fixture is the instrument. `DELETE /account/instructions` is naturally
 * idempotent (clearing an absent instruction is a no-op success) and touches no
 * ciphertext, so teardown needs neither the device key nor an encrypt.
 *
 * It reuses `authenticatedRequest` rather than minting its own context: that
 * fixture already resolves the worker's pooled persona, and the resolver is
 * module-private to `fixtures.ts` — a spec-local rebuild would be a second copy
 * of the persona-path rule. Depending on it also orders the teardowns, since a
 * fixture is torn down before the fixtures it depends on.
 */
const test = base.extend<{ clearInstructionsAutoHook: null }>({
  clearInstructionsAutoHook: [
    async ({ authenticatedRequest }, use) => {
      // The clear runs in `finally`; `no-unsafe-finally` forbids throwing from
      // inside it, so a failed clear is raised after the block and stays loud.
      let clearResponse: CheckedResponse;
      try {
        await use(null);
      } finally {
        clearResponse = await idempotentDelete(authenticatedRequest, '/account/instructions');
      }
      await expectOkResponse(clearResponse, 'custom-instructions teardown clear');
    },
    { auto: true },
  ],
});

test.describe('Custom Instructions', SPEC_MATRIX, () => {
  test('settings page renders all sections, custom instructions lifecycle', async ({
    authenticatedPage,
  }) => {
    test.slow();

    await test.step('settings page renders correctly', async () => {
      await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await navigateToSettings(authenticatedPage);
      const settingsPage = new SettingsPage(authenticatedPage);

      await expect(settingsPage.changePasswordButton).toBeVisible();
      await expect(settingsPage.twoFactorButton).toBeVisible();
      await expect(settingsPage.recoveryPhraseButton).toBeVisible();
      await expect(settingsPage.customInstructionsButton).toBeVisible();
      await settingsPage.expectCustomInstructionsBadge('Not set');
    });

    await test.step('needs attention lists both account gaps; Turn on opens two-factor setup', async () => {
      // The seeded persona never saves a recovery phrase and never enables
      // two-factor, so it opens the page as a fresh account does.
      const settingsPage = new SettingsPage(authenticatedPage);
      const group = settingsPage.needsAttention;
      await expect(group.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
      await expect(group.getByText('Recovery phrase not saved', { exact: true })).toBeVisible();
      await expect(group.getByRole('button', { name: 'Save phrase' })).toBeVisible();
      await expect(
        group.getByText('Two-factor authentication is off', { exact: true })
      ).toBeVisible();

      await group.getByRole('button', { name: 'Turn on' }).click();
      const setupModal = new TwoFactorSetupModal(authenticatedPage);
      await expect(setupModal.modal).toBeVisible();
      await expect(setupModal.getStartedButton).toBeVisible();

      // Closed before Get Started, which is the first step that writes anything.
      await authenticatedPage.keyboard.press('Escape');
      await expect(setupModal.modal).toBeHidden();
    });

    await test.step('modal opens with empty state', async () => {
      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.openCustomInstructions();

      const modal = authenticatedPage.getByTestId(TEST_IDS.customInstructionsModal);
      await expect(modal).toBeVisible();

      const textarea = modal.getByRole('textbox');
      await expect(textarea).toBeVisible();
      await expect(textarea).toHaveValue('');

      await expect(modal.getByText(/0 \/ 5,000/)).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Save' })).toBeVisible();
    });

    await test.step('save custom instructions', async () => {
      const modal = authenticatedPage.getByTestId(TEST_IDS.customInstructionsModal);
      const textarea = modal.getByRole('textbox');

      await textarea.fill(INSTRUCTIONS);
      await expect(modal.getByText(/50 \/ 5,000/)).toBeVisible();

      await modal.getByRole('button', { name: 'Save' }).click();
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.expectCustomInstructionsBadge('Active');
    });

    await test.step('reopen modal shows saved instructions', async () => {
      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.openCustomInstructions();

      const modal = authenticatedPage.getByTestId(TEST_IDS.customInstructionsModal);
      await expect(modal).toBeVisible();

      const textarea = modal.getByRole('textbox');
      await expect(textarea).toHaveValue(INSTRUCTIONS);
    });

    await test.step('saved instructions ride the next chat turn', async () => {
      const chatPage = new ChatPage(authenticatedPage);
      // A full document load, not a client-side transition: the auth store is
      // rebuilt from /me, so the instruction that rides the turn below is the
      // one the server stored and the device key decrypted — not the value the
      // save left in memory.
      await chatPage.goto();
      await chatPage.expectNewChatPageVisible();

      const captured = await captureChatRoutePayload(authenticatedPage);
      const prompt = `Instructions on the wire ${String(Date.now())}`;
      await chatPage.sendNewChatMessage(prompt);
      await chatPage.waitForConversation();

      await expect.poll(captured.get, { timeout: TIMEOUTS.ASSERT }).toBeDefined();
      expect(captured.get()).toMatchObject({ customInstructions: INSTRUCTIONS });

      // Liveness only: the send schema strips unknown keys rather than refusing
      // them, so a completed turn is no evidence about the field. What the step
      // pins is the assertion above and the round-trip that fed it.
      await chatPage.waitForAIResponse(prompt);
    });

    await test.step('clear custom instructions', async () => {
      await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await navigateToSettings(authenticatedPage);
      const settingsPage = new SettingsPage(authenticatedPage);
      await settingsPage.openCustomInstructions();

      const modal = authenticatedPage.getByTestId(TEST_IDS.customInstructionsModal);
      await expect(modal).toBeVisible();

      const textarea = modal.getByRole('textbox');
      await textarea.clear();
      await expect(modal.getByText(/0 \/ 5,000/)).toBeVisible();

      await modal.getByRole('button', { name: 'Save' }).click();
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });

      await settingsPage.expectCustomInstructionsBadge('Not set');
    });
  });
});

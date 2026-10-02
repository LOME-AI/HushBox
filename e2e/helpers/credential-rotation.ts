import { expect } from './expect.js';
import { loginViaUI, navigateToSettings, signUpAndVerify } from './auth.js';
import { pinTextTurnShape } from './text-turn-shape.js';
import { TIMEOUTS } from '../config/timeouts.js';
import {
  ChatPage,
  RecoveryPhraseModal,
  RegenerateConfirmModal,
  SettingsPage,
} from '../pages/index.js';
import type { APIRequestContext, Page } from '@playwright/test';

/** The email and username a fresh account is registered with, and the password it starts on. */
export interface SeedAccount {
  readonly email: string;
  readonly username: string;
  readonly password: string;
}

/** The turn written before the credential changed, and where to read it back. */
export interface Canary {
  readonly conversationId: string;
  readonly text: string;
}

/**
 * Leave one encrypted turn in a fresh conversation for whoever is logged in,
 * and say where to read it back. The turn is the thing a botched re-wrap would
 * silently make unreadable, so it is written before any credential moves.
 */
export async function seedConversationCanary(page: Page, text: string): Promise<Canary> {
  const chatPage = new ChatPage(page);
  await chatPage.goto();
  await chatPage.waitForAppStable();
  await pinTextTurnShape(chatPage);
  await chatPage.sendNewChatMessage(text);
  const conversationId = await chatPage.waitForConversation();
  await chatPage.waitForAIResponse(text);

  return { conversationId, text };
}

/**
 * Register a fresh account, acknowledge its recovery phrase behind the password
 * step-up, and leave one encrypted turn in a conversation. The returned phrase
 * is what a reset journey drives with: once the password is gone it is the only
 * key to the account.
 */
export async function seedAccountWithConversation(
  page: Page,
  request: APIRequestContext,
  account: SeedAccount,
  text: string
): Promise<{ phrase: string[]; canary: Canary }> {
  await signUpAndVerify(page, request, account);

  const phrase = await saveRecoveryPhrase(page, account.password);
  const canary = await seedConversationCanary(page, text);

  return { phrase, canary };
}

/**
 * Drive the recovery-phrase modal from the words it shows to the saved state,
 * through the password step-up that gates the save, and return the words.
 * `regenerate` says which of the two entries this is rather than probing the
 * DOM for it: an already-acknowledged account interposes a confirmation modal,
 * and a read taken before either has rendered would answer for neither.
 */
export async function saveRecoveryPhrase(
  page: Page,
  currentPassword: string,
  regenerate = false
): Promise<string[]> {
  await navigateToSettings(page);
  const settingsPage = new SettingsPage(page);
  await settingsPage.openRecoveryPhrase();

  if (regenerate) await new RegenerateConfirmModal(page).confirm();

  const modal = new RecoveryPhraseModal(page);
  await expect(modal.wordGrid).toBeVisible({ timeout: TIMEOUTS.ASSERT });

  const words = await modal.getWords();
  expect(words).toHaveLength(12);

  await modal.proceedToVerify();
  await modal.fillVerificationWords(words);
  await modal.clickVerify();
  await modal.confirmPassword(currentPassword);
  await modal.expectSuccess();
  await modal.doneButton.click();

  return words;
}

/**
 * The whole point of the gate: log in on the credential that is now current and
 * read the conversation written before it changed. `waitForConversationLoaded`
 * gates on the app's own decrypted-count signal, which excludes rows whose
 * envelope would not open, so a re-wrap that lost the account key fails here
 * rather than rendering placeholder text nobody asserts on.
 */
export async function expectConversationStillReadable(
  page: Page,
  credentials: { email: string; password: string },
  canary: Canary
): Promise<void> {
  await loginViaUI(page, credentials);
  const chatPage = new ChatPage(page);
  await chatPage.gotoConversation(canary.conversationId);
  await chatPage.waitForConversationLoaded();
  await chatPage.expectMessageVisible(canary.text);
  await chatPage.expectAssistantMessageContains('Echo:');
}

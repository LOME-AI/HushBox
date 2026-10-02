import { requireEnv } from '../../helpers/env.js';
import { idempotentPost } from '../../helpers/idempotent-request.js';
import { expectOkResponse } from '../../helpers/ok-response.js';
import type { APIRequestContext } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * Fresh-id admin-op target minting via `POST /dev/admin-targets`: every call
 * creates its own mutable rows (unique uuids/emails), so parallel specs
 * mutate private targets instead of racing over the fixed seeded set. Minted
 * users go through the real registration settlement (two wallets + welcome
 * credit + verified email) but are deliberately NOT OPAQUE-loginable.
 *
 * Dev routes need no admin JWT — any request context works; pass one of the
 * harness's retry-wrapped contexts (the base `request` fixture or an
 * `adminApi` context) so transient saturation drops are retried.
 */

type AdminTargetKind =
  | 'lockedUser'
  | 'deadJob'
  | 'discardedJob'
  | 'revokedShare'
  | 'awaitingWebhookPayment';

interface MintedLockedUser {
  readonly userId: string;
  readonly email: string;
}

interface MintedJob {
  readonly jobId: string;
}

interface MintedRevokedShare {
  readonly linkId: string;
  readonly conversationId: string;
}

interface MintedAwaitingWebhookPayment {
  readonly paymentId: string;
  readonly userId: string;
  readonly email: string;
  /** The captured amount the row carries, as a NanoUSD string — the only
   * sanctioned source for what the money ops must move (rule 1.6). */
  readonly amountNanoUsd: string;
}

interface MintedAdminTargets {
  readonly lockedUser?: MintedLockedUser;
  readonly deadJob?: MintedJob;
  readonly discardedJob?: MintedJob;
  readonly revokedShare?: MintedRevokedShare;
  readonly awaitingWebhookPayment?: MintedAwaitingWebhookPayment;
}

/** Mint the requested target kinds; throws on any non-201 so a broken seed
 * fails at setup, never mid-assertion. */
export async function mintAdminTargets(
  request: APIRequestContext,
  kinds: readonly AdminTargetKind[]
): Promise<MintedAdminTargets> {
  const response = await idempotentPost(request, `${API_BASE}/dev/admin-targets`, {
    data: { kinds },
  });
  await expectOkResponse(response, `mintAdminTargets(${kinds.join(',')})`, 201);
  return (await response.json()) as MintedAdminTargets;
}

/** A disposable locked user with two freshly-settled wallets nobody else
 * touches — the standard mutable target for wallet-op specs. */
export async function mintLockedUser(request: APIRequestContext): Promise<MintedLockedUser> {
  const minted = await mintAdminTargets(request, ['lockedUser']);
  if (minted.lockedUser === undefined) {
    throw new Error('mintAdminTargets returned 201 without a lockedUser');
  }
  return minted.lockedUser;
}

/**
 * A disposable user holding one captured-but-uncredited payment: the state
 * the reconciler cannot resolve and the operator's payment ops exist to
 * repair. The wallet carries only the registration welcome credit, so the
 * row's amount is the whole of what a force-complete may move.
 */
export async function mintAwaitingWebhookPayment(
  request: APIRequestContext
): Promise<MintedAwaitingWebhookPayment> {
  const minted = await mintAdminTargets(request, ['awaitingWebhookPayment']);
  if (minted.awaitingWebhookPayment === undefined) {
    throw new Error('mintAdminTargets returned 201 without an awaitingWebhookPayment');
  }
  return minted.awaitingWebhookPayment;
}

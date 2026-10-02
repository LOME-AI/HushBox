import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { expect } from './expect.js';
import type { Locator, Page } from '@playwright/test';
import type { BudgetHelper } from './budget.js';

/** Nano-USD in one micro-USD (a millionth of a dollar). */
const NANO_USD_PER_MICRO = 1000n;

/** Fraction digits in a nano-USD amount written as a decimal dollar string. */
const NANO_FRACTION_DIGITS = 9;

/**
 * Half the cost badge's own quantum. The badge renders through `toFixed(8)`
 * (`packages/shared/src/utils/formatting.ts:72`), so it carries a tile's cost rounded
 * to 10 nano-USD and can sit up to 5 nano either side of it.
 *
 * Every charge the E2E mock produces is a whole multiple of 10 nano — inference
 * is 1150 (a 1000-nano inline cost marked up 15%), text storage is 300/char —
 * so this term is zero for every caller today. It is not zero for media, whose
 * storage is 18 nano/byte, and it is not zero if the markup rate ever stops
 * landing on a multiple of 10. The term exists so neither turns a display
 * rounding artifact into a red suite.
 */
const BADGE_ROUNDING_NANO_USD = 5n;

/**
 * The truth side's quantum. `BudgetHelper.getConversationChargedMicros` rounds
 * the server's exact nano-USD total to whole micros (`e2e/helpers/budget.ts:199`),
 * so the charged figure arrives quantized to 1000 nano and can sit up to 500
 * nano either side of the real debit. This dominates the window; tightening it
 * means widening that helper's return to nano-USD.
 */
const SERVER_MICRO_ROUNDING_NANO_USD = 500n;

/**
 * A badge's dollar text as exact nano-USD, by integer string math — never
 * `parseFloat` scaled into a unit, which is what previously destroyed the
 * quantity being measured (a 1150-nano tile became "1 micro").
 *
 * Text with no digits at all contributes 0, which now moves the sum away from
 * the charged total and fails the comparison rather than quietly shrinking it.
 */
function badgeNanoUsd(text: string): bigint {
  const match = /(\d+)(?:\.(\d+))?/.exec(text);
  if (match === null) return 0n;
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '')
    .padEnd(NANO_FRACTION_DIGITS, '0')
    .slice(0, NANO_FRACTION_DIGITS);
  return whole * 10n ** BigInt(NANO_FRACTION_DIGITS) + BigInt(fraction);
}

/**
 * Sum the per-message cost badges in exact nano-USD, with the badge count the
 * caller needs to size its rounding allowance.
 *
 * Nano-USD is the unit the money path itself uses end to end, so the sum loses
 * nothing: settled per-tile costs are sub-cent (1150 nano for one mock
 * generation), and every coarser unit quantizes them into noise — cents collapse
 * a whole tile to zero, and micros still lose 13% of one.
 *
 * The badge text is always `$`-prefixed: `MessageCost` is the only renderer of
 * this test id (`apps/web/src/components/chat/message/message-cost.tsx:31`) and
 * it formats through `formatNanoUsdCost`, which always emits the sign.
 */
async function sumDisplayedMessageCost(
  scope: Locator | Page
): Promise<{ totalNanoUsd: bigint; badgeCount: number }> {
  const costElements = scope.getByTestId(TEST_IDS.messageCost);
  const badgeCount = await costElements.count();
  let totalNanoUsd = 0n;
  for (let index = 0; index < badgeCount; index++) {
    totalNanoUsd += badgeNanoUsd((await costElements.nth(index).textContent()) ?? '');
  }
  return { totalNanoUsd, badgeCount };
}

/** The status meaning the two sides agree; anything else is the diagnosis. */
const CHARGE_MATCHES_DISPLAY = 'charge matches display';

/**
 * One comparison of the charged total against the displayed total, reported as
 * a status string so the polling caller's failure output carries the numbers.
 *
 * Every read happens here, inside the retried body: both the charge and the
 * badges must be re-read together, since comparing a fresh figure against a
 * stale one is the bug this shape exists to avoid.
 */
async function compareChargeToDisplay(
  budgetHelper: BudgetHelper,
  conversationId: string,
  messageList: Locator | Page
): Promise<string> {
  const chargedMicros = await budgetHelper.getConversationChargedMicros(conversationId);
  const chargedNanoUsd = BigInt(chargedMicros) * NANO_USD_PER_MICRO;
  const { totalNanoUsd: displayedNanoUsd, badgeCount } = await sumDisplayedMessageCost(messageList);

  // A conversation that settled nothing satisfies any window at 0 == 0. Before
  // settlement commits this is simply "not yet", so it is polled rather than
  // failed; if it never becomes non-zero the poll reports this line.
  if (chargedNanoUsd === 0n) return 'the conversation has been charged nothing at all';

  const windowNanoUsd =
    SERVER_MICRO_ROUNDING_NANO_USD + BADGE_ROUNDING_NANO_USD * BigInt(badgeCount);
  const drift = chargedNanoUsd - displayedNanoUsd;
  const magnitude = drift < 0n ? -drift : drift;
  if (magnitude <= windowNanoUsd) return CHARGE_MATCHES_DISPLAY;

  return (
    `charged ${String(chargedNanoUsd)} nano-USD vs displayed ${String(displayedNanoUsd)} nano-USD ` +
    `across ${String(badgeCount)} badges — drift ${String(magnitude)} exceeds the ${String(windowNanoUsd)} nano-USD window`
  );
}

/**
 * Assert that what a conversation actually charged equals what its per-message
 * badges display, to within the two sides' rounding quanta and nothing more.
 *
 * **What this proves.** Settlement writes the debit legs (`usage_records`) and
 * the denormalized display column (`content_items.cost`) in one transaction,
 * from the same charge list and through the same content anchor, so
 * `Σ content_items.cost == Σ usage_records.cost` holds by construction
 * (`anchorChargeKey`, `apps/api/src/slices/workflows/domain/engine/settlement.ts`).
 * What this witnesses is that identity surviving everything downstream of the
 * commit, none of which the anchor covers:
 *
 * - a writer that produces one side without the other — settlement writes both
 *   atomically, but a dev seed or factory can write a content item's cost with
 *   no `usage_records` row, and that is invisible to every server-side test
 *   that reads only one of the two;
 * - the read path to the badge: the API's content-item shape, client-side
 *   decryption, `sumCost`'s summing, and the badge's own formatting — a cost
 *   dropped, mis-serialized, double-counted or misrounded anywhere along it
 *   moves the displayed side alone;
 * - a badge that fails to render at all, which subtracts its whole tile;
 * - deletion accounting: a deleted tile must leave both sides together (the
 *   charge via `usage_records.contentItemId` going null, the display with the
 *   row), so a stale tile keeping a cost, or a charge outliving its content,
 *   diverges.
 *
 * **What it does not prove — and this is the larger half.** An error in the
 * run's own charge set is invisible here. The debit path and the display column
 * iterate the same `request.charges` and resolve the same `anchorChargeKey`
 * with the same skip rule, and a charge that persisted no content of its own
 * anchors onto the run's first persisted content instead. So a failed sibling
 * billed anyway, a re-charged survivor, or a charge that should never have been
 * collected lands in `usage_records` AND in that tile's displayed cost: both
 * sides move by the same amount and this assertion stays green. Catching those
 * needs a discriminating server-side read, not this comparison. A uniform
 * pricing error — wrong markup, wrong storage rate — passes for the same
 * reason; price correctness is proven by the shared estimator's own tests.
 *
 * **Why the comparison can be near-exact.** The mock provider bills a fixed
 * inline cost (`MOCK_GENERATION_COST_USD`, 1000 nano before markup), so every
 * charge in an E2E conversation is a deterministic integer rather than a
 * provider-dependent one. Nothing needs a tolerance for price variance; the
 * only spread is the two unit conversions each side already performs, which is
 * what the window is made of and all it is made of.
 *
 * The charge is summed from `usage_records` scoped to one conversation — not a
 * global wallet-balance delta, which concurrent charges on the shared
 * per-project user would corrupt.
 *
 * The whole comparison is polled, not read once. At a 510-nano window both
 * sides are load-bearing the instant they are read: a badge that has not yet
 * acquired its cost drifts by an entire tile, and a charge read before
 * settlement commits reads zero. Neither is a failure, both are "not yet", and
 * a point-in-time read cannot tell them apart from the real thing.
 */
export async function expectConversationChargeMatchesDisplay(
  budgetHelper: BudgetHelper,
  conversationId: string,
  messageList: Locator | Page
): Promise<void> {
  await expect
    .poll(async () => compareChargeToDisplay(budgetHelper, conversationId, messageList), {
      timeout: TIMEOUTS.ASSERT,
      message: 'the conversation charge should match the sum of its displayed cost badges',
    })
    .toBe(CHARGE_MATCHES_DISPLAY);
}

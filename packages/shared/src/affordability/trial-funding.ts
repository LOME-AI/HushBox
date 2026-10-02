/**
 * The funding snapshot of the one payer with NO funding door: the trial.
 *
 * §Affordability 8 fixes it at a small effective balance rather than nothing —
 * a zero here reads as poverty and refuses the whole unauthenticated funnel,
 * while the server admits those turns on quota. The ceiling comes from the
 * shared tier authority, so there is exactly one definition of it.
 *
 * It is produced here rather than composed by each surface because composing it
 * is what put a money figure in a client: the caller then holds the tier, the
 * balance and the hold as separate values and can pass a different combination
 * of them. A link guest is deliberately NOT expressible through this — it HAS a
 * door of its own and is owner-funded, so it reads the payer's served figures
 * like anyone else (§Funding, §User Tiers).
 */

import { nanoUSD } from './money/nano-usd.ts';
import { getEffectiveBalanceNano } from './estimate/pre-adapters.ts';
import type { FundingSnapshot } from './turn/turn-types.ts';

export function trialFundingSnapshot(): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(getEffectiveBalanceNano('trial', 0n, 0n)),
    heldNanoUsd: nanoUSD(0n),
    payerTier: 'trial',
    payer: 'self',
  };
}

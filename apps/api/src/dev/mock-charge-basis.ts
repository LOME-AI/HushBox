import { providerUsdToBillableNanoUsd } from '../slices/billing/index.js';
import { MOCK_ECHO_AFFIXES, MOCK_GENERATION_COST_USD } from '../slices/models/index.js';

/**
 * What the dev/E2E mock provider DECLARES it will charge and echo, served so an
 * out-of-process money assertion can derive an expected charge instead of
 * restating one as a literal.
 *
 * The echo affixes are here because the persisted assistant text drives the
 * turn's additive text-storage fee. For a turn that makes no web search, that
 * text is `echoPrefix + prompt + echoSuffix`, reproducible from the prompt
 * alone, which is what lets a derivation be exact rather than approximate. A
 * mock search turn's text is not: it also carries the turn's search record and
 * the source its answer names, and the turn bills two generations, one per step.
 */
export interface MockChargeBasis {
  /**
   * One mock generation's BILLABLE charge (canonical integer NanoUSD string).
   * Converted here, at the ModelProvider port's own markup seam, because the
   * fee helpers are confined to that seam — a consumer applies no markup of its
   * own and therefore cannot drift from what settlement charges.
   */
  readonly generationChargeNanoUsd: string;
  readonly echoPrefix: string;
  readonly echoSuffix: string;
}

/** The mock's declared charge basis. Pure: no request, no database, no clock. */
export function mockChargeBasis(): MockChargeBasis {
  return {
    generationChargeNanoUsd: providerUsdToBillableNanoUsd(MOCK_GENERATION_COST_USD).toString(),
    echoPrefix: MOCK_ECHO_AFFIXES.prefix,
    echoSuffix: MOCK_ECHO_AFFIXES.suffix,
  };
}

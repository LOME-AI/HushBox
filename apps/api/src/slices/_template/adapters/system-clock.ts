import type { Clock } from '../ports/index.js';

/**
 * Example adapter: `adapters/` is where a slice's infra clients live. Which
 * layers are refused them is stated in
 * `packages/config/eslint-extensions/boundaries.config.mjs`.
 */
export const systemClock: Clock = {
  now: (): Date => new Date(),
};

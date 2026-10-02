import { GROWTH_BEACON_PATH } from './beacon.ts';
import { GROWTH_SCROLL_EVENTS } from './enums.ts';

/**
 * Recognises the growth beacon inside a source file or a built artifact.
 *
 * The anonymous half of growth measurement lives on the marketing pages and
 * nowhere else. The signed-in app carries no beacon at all, so that a session
 * can never contribute to the anonymous aggregates — which are set
 * cardinalities kept forever, with no per-row identity anything could filter a
 * mistake back out of. Two layers prove it and both call this function, so
 * neither can drift into recognising something the other does not: a unit test
 * sweeps the app's own sources on every run, and `scripts/verify-bundle.ts`
 * reads the built artifact after tree-shaking, which no source-level check can.
 *
 * The path is matched only as a whole string literal. It is two characters
 * long, so a substring search would hit the inside of every path in the app,
 * and a prefix search would hit every longer path beginning with it.
 */
export function growthBeaconReferencesIn(source: string): string[] {
  return [
    ...(beaconPathLiteral.test(source) ? [GROWTH_BEACON_PATH] : []),
    ...GROWTH_SCROLL_EVENTS.filter((name) => source.includes(name)),
  ];
}

/** Every quote a bundler may emit, since minified output is as much an input here as source is. */
const beaconPathLiteral = new RegExp(`(['"\`])${GROWTH_BEACON_PATH}\\1`, 'u');

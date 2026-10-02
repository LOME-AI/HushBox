/**
 * The generated-input settings every property test in this repository runs
 * under, and the observation that proves they are in force.
 *
 * Test-only, reached through the `@hushbox/shared/property-tests` subpath. The
 * module that applies them is `packages/shared/src/testing/property-tests.setup.ts`,
 * which no test imports, so a test observing these values observes what its own
 * runner was configured with rather than what its own imports did.
 */

/**
 * The library, as the package under test resolves it. The settings are applied
 * to one instance, so a package whose own resolution yields a second copy
 * generates from an unconfigured one — which is what passing it in exposes.
 */
type PropertyRunner = typeof import('fast-check').default;

/**
 * The seed every property run draws from. Unseeded randomness is banned in
 * specs because a failure has to reproduce exactly, and the library seeds each
 * run off the clock when none is configured.
 */
export const PROPERTY_TEST_SEED = 0x5f_2d_11_a3;

/**
 * Cases per property, and the count a property that declares none of its own
 * runs at. It sits well above the library's own default of 100, so inheriting
 * it is the safe choice and naming a count is a decision about cost: a property
 * whose generator is dear states a smaller one at its own call site, and a
 * cheap one says nothing and runs at this.
 */
export const PROPERTY_TEST_RUNS = 1500;

/** The inputs one property run draws, in the order it drew them. */
export function observePropertyRun(runner: PropertyRunner): readonly number[] {
  const inputs: number[] = [];
  runner.assert(
    runner.property(runner.integer(), (value: number) => {
      inputs.push(value);
      return true;
    })
  );
  return inputs;
}

/**
 * Applies the generated-input settings declared in
 * `packages/shared/src/testing/property-tests.ts` to the whole runner.
 *
 * A seed passed per call site is one a new property can forget, and forgetting
 * it costs a reproducible failure; a count passed per call site is one a
 * migration can leave at the library's default, which examines less than the
 * loop it replaced while the run still reports green. Every runner that
 * generates inputs loads this file, so neither is a decision a test makes.
 */

import fc from 'fast-check';

import { PROPERTY_TEST_RUNS, PROPERTY_TEST_SEED } from './property-tests.ts';

fc.configureGlobal({ seed: PROPERTY_TEST_SEED, numRuns: PROPERTY_TEST_RUNS });

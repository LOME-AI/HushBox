import type { ModelsData } from '@/hooks/models/models';

/**
 * The trimmed `useModels()` return a test stub serves: `data` and nothing
 * else of the query envelope.
 *
 * Its rows reach the wire contract through the hook's own published payload
 * type, so a stub annotated with this checks its fixtures against `Model`
 * instead of against a per-file restatement of the payload. An unannotated
 * stub infers `models: never[]` from its empty default, which erases the
 * contract for every fixture in the file at once — the pressure that produced
 * a cast at each of those fixtures.
 *
 * A type rather than a value, deliberately: the stubs it annotates are built
 * inside `vi.hoisted` and `vi.mock` factories, which run before this module's
 * imports are evaluated. An annotation is erased; a value reference would
 * throw there.
 *
 * `data` is optional in the same way the real query result's is, so a test
 * that drives the absent-catalog branch annotates with this type too.
 */
export interface UseModelsStub {
  data: ModelsData | undefined;
}

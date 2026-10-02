import { describe, expectTypeOf, it } from 'vitest';

// A Worker-types release that declares `process` or `Buffer` as `any` wins the global merge
// with Node's declarations silently under `skipLibCheck`; these assertions make it a type error.
describe('Node globals keep their Node types', () => {
  it('types process', () => {
    expectTypeOf<typeof process>().not.toBeAny();
  });

  it('types Buffer', () => {
    expectTypeOf<typeof Buffer>().not.toBeAny();
  });
});

import { rand } from './rand.js';

/** The first `count` values `rand(key)` yields. */
export function firstOutputs(key: string, count: number): number[] {
  const next = rand(key);
  return Array.from({ length: count }, () => next());
}

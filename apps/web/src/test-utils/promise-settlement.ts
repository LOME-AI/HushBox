export const PENDING = Symbol('pending');

// Drains the microtask queue, then reports whether `promise` is still in
// flight. Anything that never waited on a real async round trip has settled by
// then, so a PENDING result is proof the caller is genuinely still waiting.
export async function settlementOf<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
  return await Promise.race([promise, Promise.resolve(PENDING)]);
}

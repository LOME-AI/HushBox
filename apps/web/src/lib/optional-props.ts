/**
 * Returns a new object with all `undefined` entries removed.
 *
 * Designed for spreading optional component props under
 * `exactOptionalPropertyTypes` — `{...omitUndefined({a, b, c})}` is equivalent
 * to `{...(a !== undefined && { a }), ...(b !== undefined && { b }), ...}`
 * without the repetition. `null` is preserved; only `undefined` is dropped.
 *
 * The return type uses `Partial<{ [K]: Exclude<T[K], undefined> }>` so that
 * spreading the result against a target with strict optional props
 * (`exactOptionalPropertyTypes`) doesn't reintroduce `| undefined` on each
 * field — it's either present with a defined value or absent.
 */
export function omitUndefined<T extends Record<string, unknown>>(
  object: T
): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<{ [K in keyof T]: Exclude<T[K], undefined> }>;
}

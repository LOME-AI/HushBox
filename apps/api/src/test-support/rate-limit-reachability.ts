/**
 * # The published-surface walk behind the posture-fragment leak tests
 *
 * Every value reachable from `root` by own-key property access on an object
 * or a function — less the keys {@link intrinsicsOf} names, and less `null`
 * and `undefined`. It follows `Reflect.ownKeys`, so symbol-keyed and
 * non-enumerable properties count; a closure's captured variables do not
 * appear, because JavaScript exposes no reflection over them. That absence is
 * the property a bound counting capability rests on.
 *
 * ## The heuristic a caller has to keep in mind
 *
 * Asking "is a cap or a window reachable?" can only be a VALUE MATCH: a cap
 * is a number, and the walk answers with values, never with the paths it took
 * to them. So such a check collides with any equal number reachable on the
 * object — a list's element count is as good a `2` as a definition's
 * `maxAttempts`. A caller meeting such a collision should suspect a
 * coincidence of values before it suspects a leak.
 *
 * ## Why the two skips are narrow, and must stay so
 *
 * Each hides only keys that describe the SHAPE of a value rather than anything
 * the value carries:
 *
 * - a function's own `length` and `name` follow from its signature whatever it
 *   closes over;
 * - an array's own `length` counts a route's declared layers.
 *
 * Beyond those, no own key is skipped. A function's other own keys — its
 * `prototype` among them, which is a fresh mutable object and not a fact about
 * the signature — are followed, and an array's indices are followed, so a cap
 * hung off a published callable or parked in a published list is still found.
 * The colocated test holds both of those cases as matched controls, because a
 * walk that stopped at either would answer "no cap reachable" for a cap that
 * is.
 */

/** Own keys intrinsic to being a function rather than to what it holds. */
const FUNCTION_INTRINSICS: ReadonlySet<PropertyKey> = new Set(['length', 'name']);

/** Own keys intrinsic to being an array rather than to what it holds. */
const ARRAY_INTRINSICS: ReadonlySet<PropertyKey> = new Set(['length']);

const NO_INTRINSICS: ReadonlySet<PropertyKey> = new Set();

function intrinsicsOf(value: object): ReadonlySet<PropertyKey> {
  if (typeof value === 'function') return FUNCTION_INTRINSICS;
  return Array.isArray(value) ? ARRAY_INTRINSICS : NO_INTRINSICS;
}

/** Everything one value holds directly, less the intrinsics named above. */
function ownValues(value: object): unknown[] {
  const intrinsics = intrinsicsOf(value);
  return Reflect.ownKeys(value)
    .filter((key) => !intrinsics.has(key))
    .map((key): unknown => Reflect.get(value, key));
}

export function reachableFrom(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const found: unknown[] = [];
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value === null || value === undefined || seen.has(value)) continue;
    seen.add(value);
    found.push(value);
    if (typeof value === 'object' || typeof value === 'function') queue.push(...ownValues(value));
  }
  return found;
}

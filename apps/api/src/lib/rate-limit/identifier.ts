/**
 * The identifiers a counter is keyed on, minted here so that a slice's own
 * domain can mint one: the pipeline stage's resolvers live in middleware,
 * which `domain/` may not import, and a flow-counted layer is keyed by the
 * domain that spends it.
 */

const encoder = new TextEncoder();

/**
 * SHA-256 hex of a rate-limit identifier: one fixed width whatever the
 * identifier measures. What keeps an identifier out of a Redis key name is the
 * keyed digest `rateLimitKey` takes of whatever it is handed, this included.
 * It does not make an identifier non-rotatable. A link
 * credential is caller-presented and rotatable, which is why `callerIdentity`
 * (`middleware/rate-limit.ts`) anchors it to `trustedCallerIpId` instead of
 * keying on it alone, and the client IP never comes here at all — that
 * resolver collapses it onto its /64 first, because hashing the address as
 * presented is what let a caller rotate its own window. Only an admin's Access
 * email arrives already fixed.
 */
export async function hashRateLimitId(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(identifier));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * One identifier standing for several claims at once — the layer that counts a
 * named account within one network keys on such a pair.
 *
 * Width is the point. `rateLimitKey` refuses an identifier past
 * `MAX_IDENTIFIER_LENGTH` (`lib/rate-limit/consume.ts`), and the identity
 * values a boundary schema admits already run to 254 characters, so composing
 * two of them by concatenation answers a validation error rather than a
 * counter. Every result here is one digest wide whatever the parts measure.
 *
 * Each part is digested before the parts are joined, which is what makes the
 * mapping injective: the fields are then fixed-width and carry no separator,
 * so no two different part lists can be rearranged into one message. Joining
 * the parts themselves would need a byte no part can contain, which is a
 * promise about every future caller's input rather than a property of this
 * function.
 */
export async function compositeRateLimitId(
  parts: readonly [string, string, ...string[]]
): Promise<string> {
  const fields = await Promise.all(parts.map((part) => hashRateLimitId(part)));
  return hashRateLimitId(fields.join(':'));
}

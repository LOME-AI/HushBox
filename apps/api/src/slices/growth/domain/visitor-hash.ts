import { canonicalCallerIp } from '../../../lib/redis/index.js';

/**
 * The anonymous visitor identity every marketing count is a set membership of.
 *
 * It exists in Redis and nowhere else, as a member of the counting sets. How
 * long a set holds it is `addUnderCeiling`'s to say
 * (`apps/api/src/slices/growth/domain/ceiling-gate.ts`). No table in this
 * design has a column for it, and nothing logs it: point-in-time recovery would
 * make a "pruned nightly" table recoverable for days, so keeping it out of
 * Postgres entirely is the only version of deletion that means anything here.
 *
 * Two properties do the work:
 *
 * - **Keyed, not salted.** An unkeyed `SHA-256(day ‖ ip ‖ ua)` over IPv4 times
 *   the common user agents is on the order of 10^13 digests — hours on
 *   commodity hardware — so a leaked set of hashes would be reversible into
 *   addresses. Under a per-day key derived from a registry secret, the same
 *   table buys nothing without the key.
 * - **Rotation at UTC midnight.** The day label goes into the key derivation,
 *   so a visitor's identity is unlinkable across days by construction rather
 *   than by a retention promise. Local midnight would need a client-supplied
 *   timezone, which is spoofable, and would produce overlapping windows.
 *
 * The address is reduced by the shared caller-IP canonicalisation rather than
 * by a copy of it, so this hash and the rate limiters stand for the same
 * population: an IPv6 address collapses to its /64, an IPv4-mapped address to
 * the IPv4 address it is.
 *
 * That reduction bounds the address input and no other: the user agent is the
 * sender's to vary without limit, so the number of identities one address can
 * produce is not bounded here at all — it is bounded where the counts are
 * written, by the write script's per-address daily mint ceiling.
 *
 * Known bias, shared with every cookieless tool and stated rather than tuned
 * around: an office behind one egress address collapses to one visitor, and
 * carrier-grade NAT plus user-agent reduction collapses mobile users on one OS
 * version. IPv6 /64 mostly restores households.
 */

/*
 * A DELIBERATE EXCEPTION to crypto segregation, recorded so it is not
 * re-litigated. `packages/crypto`'s own header states that every keyed
 * operation lives inside it; the derivation below uses the platform's
 * WebCrypto directly instead. The package DOES hold an HKDF helper, but its
 * barrel does not publish it, and it exposes no general-purpose HMAC at all —
 * so composing this from what that package offers is not currently possible
 * without widening its public surface. Two keyed WebCrypto call sites already
 * stand in this app for the same reason: the push collapse alias and the Web
 * Push content encryption. Publishing the pair from `packages/crypto` and
 * moving this onto it is the resolution whenever that package is next opened.
 */

const encoder = new TextEncoder();

/** Bytes of digest kept. 16 is 128 bits — far past collision relevance for a per-day set of visitors, and half the width to hold in Redis. */
const HASH_BYTES = 16;

/**
 * Separates the message's fields with a byte none of them can contain, so no
 * two different (address, user agent) pairs can be rearranged into one
 * message. Without it `('1.2.3.4a', 'b')` and `('1.2.3.4', 'ab')` are one
 * visitor.
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * Binds the digest to this application. A second system deriving a hash the
 * same way from the same inputs would produce a different value, so a hash
 * from elsewhere can never be matched against these sets.
 */
const APPLICATION_LABEL = 'hushbox.ai';

/** Distinguishes this derivation from any other use of the same registry secret. */
const VISITOR_DERIVATION_LABEL = 'growth-visitor:';

/**
 * The address-keyed sets, each under a derivation of its own. One shared
 * identity would let a reader holding no secret join a registration start to
 * the mint key that files that address's visitor codes, and so to its path.
 */
const ADDRESS_DERIVATION_LABELS = {
  mint: 'growth-mint:',
  mintCapped: 'growth-mint-capped:',
  started: 'growth-started:',
} as const;

export type DailyAddressSet = keyof typeof ADDRESS_DERIVATION_LABELS;

/** The day's HMAC key for one derivation, from the registry secret and the UTC day label. */
async function dayKey(secret: string, label: string, day: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encoder.encode(`${label}${day}`),
    },
    material,
    256
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function lowercaseHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * This visitor's identity for `day`, as 32 lowercase hex characters.
 *
 * `day` is the UTC day the request arrived on, derived server-side: a
 * client-supplied instant would let a caller pick which day's key its hash was
 * minted under, and so which day's aggregates it lands in.
 */
export async function visitorHash(args: {
  readonly secret: string;
  readonly address: string;
  readonly userAgent: string;
  readonly day: string;
}): Promise<string> {
  const message = [canonicalCallerIp(args.address), args.userAgent, APPLICATION_LABEL].join(
    FIELD_SEPARATOR
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    await dayKey(args.secret, VISITOR_DERIVATION_LABEL, args.day),
    encoder.encode(message)
  );
  return lowercaseHex(new Uint8Array(mac).slice(0, HASH_BYTES));
}

/**
 * One address's identity in one of the address-keyed sets for `day`, as 64
 * lowercase hex characters: the whole HMAC, under that set's own derivation of
 * the day key, over the shared caller-IP reduction of the address.
 *
 * Keyed for the reason the visitor hash is: an unkeyed digest of an address
 * reverses by enumerating IPv4. The reduction is the one the rate limiters
 * use, so the mint ceiling bounds the population the throttle bounds.
 */
export async function dailyAddressId(args: {
  readonly secret: string;
  readonly address: string;
  readonly day: string;
  readonly set: DailyAddressSet;
}): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await dayKey(args.secret, ADDRESS_DERIVATION_LABELS[args.set], args.day),
    encoder.encode([canonicalCallerIp(args.address), APPLICATION_LABEL].join(FIELD_SEPARATOR))
  );
  return lowercaseHex(new Uint8Array(mac));
}

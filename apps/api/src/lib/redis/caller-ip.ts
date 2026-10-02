/**
 * This caller's IP identity — the one implementation every rate-limit key in
 * the Worker derives its IP component from. It resolves the address, collapses
 * IPv6 onto its /64 network prefix, and hashes, in a single call: a limiter
 * that hashed the resolved address itself would key on something the caller
 * rotates, and two such implementations drifted apart once already.
 *
 * A raw address is never a rate-limit key. `resolveClientIp` exists only for
 * the surfaces that must record or forward the literal address, where a
 * collapsed value would be wrong.
 */

import type { EnvUtilities } from '@hushbox/shared';

const encoder = new TextEncoder();

/**
 * The IPv6 prefix width the identity keys on. A /64 — the upper 64 bits, 4 of
 * the 8 hextets — is the standard delegation to a single subscriber, so the
 * lower 64 host bits are the caller's to choose and a limiter keyed on the full
 * address bounds nothing. Zeroing those host bits before hashing collapses the
 * whole subnet onto one identity, the IPv6 analogue of the per-IPv4 counter.
 * The cost is that everything behind one /64 shares a window — a residential
 * line is one subscriber, but a /64 per VLAN is a whole floor.
 */
const IPV6_PREFIX_HEXTETS = 4;
const IPV6_HEXTETS = 8;

/**
 * The sentinel for a caller whose address no trusted header carries. Loopback
 * rather than a word, because the recording surfaces write it into
 * `newsletter_subscribers.consent_ip`, a Postgres `inet` column with no
 * representation for one. It therefore shares a rate-limit identity with a
 * caller that genuinely presents loopback — the same machine either way.
 */
const UNKNOWN_ADDRESS = '127.0.0.1';

/**
 * The caller's literal address, or null when nothing here may be believed:
 * `cf-connecting-ip` answers first everywhere, and in production it is the only
 * header read, so a request reaching us without it resolves to no address at
 * all. Outside production the first `x-forwarded-for` hop then `x-real-ip`
 * follow it, and exhausting them answers the shared sentinel.
 *
 * The two callers below split on exactly that null. A surface recording what is
 * known keeps the sentinel; a limiter keying a window refuses, because the
 * sentinel is one identity every caller behind the same fault would share.
 *
 * Those two fallbacks answer almost nothing over local HTTP: miniflare's entry
 * worker, which fronts the app in the local Worker runtime, injects
 * `cf-connecting-ip` (the socket peer — loopback for a local client) into
 * every request that arrives without a non-empty one — its
 * guard is truthiness, so an empty sent value is replaced too — and leaves any
 * other client-sent value alone. So a local caller presents an address by writing that
 * header itself; the fallbacks are left for an in-process caller (the app
 * invoked directly, as this package's tests do), which has no runtime in front
 * of it to inject anything.
 *
 * The production gate is not belt-and-braces. Cloudflare APPENDS its hop to a
 * client-sent `x-forwarded-for`, so the first entry — the one this reads — is
 * whatever the caller wrote; honouring it anywhere the edge is live would let a
 * caller pick its own rate-limit window, and pick a new one per request.
 * Rejected alternative: reading the LAST hop instead, which also defeats the
 * spoof but leaves the fallback live in production, where `cf-connecting-ip` is
 * always present and strictly better evidence.
 *
 * Never a rate-limit key — `callerIpId` is.
 */
function believedClientIp(
  header: (name: string) => string | undefined,
  envUtilities: EnvUtilities
): string | null {
  const cfIp = header('cf-connecting-ip');
  if (cfIp !== undefined && cfIp !== '') return cfIp;
  if (envUtilities.isProduction) return null;
  const forwarded = header('x-forwarded-for');
  if (forwarded !== undefined) {
    const firstHop = forwarded.split(',')[0]?.trim();
    if (firstHop !== undefined && firstHop !== '') return firstHop;
  }
  const realIp = header('x-real-ip');
  if (realIp !== undefined && realIp !== '') return realIp;
  return UNKNOWN_ADDRESS;
}

/**
 * The address for a surface that records what is known about the caller rather
 * than deciding anything from it — one where the sentinel is an honest value
 * and a refusal would not be, so absence answers the sentinel. A window that
 * must bound something takes `trustedCallerIpId` instead, which refuses on the
 * same absence.
 */
export function resolveClientIp(
  header: (name: string) => string | undefined,
  envUtilities: EnvUtilities
): string {
  return believedClientIp(header, envUtilities) ?? UNKNOWN_ADDRESS;
}

/** Parse a dotted-quad into its four octets, or null if it is not a valid IPv4. */
function ipv4Octets(text: string): readonly number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Parse one colon-delimited token into the hextet(s) it contributes: a plain
 *  hex token yields one hextet; a trailing dotted-quad (IPv4-in-IPv6) yields two.
 *  Null on any malformed token. */
function parseHextetToken(token: string, isLast: boolean): number[] | null {
  if (token.includes('.')) {
    // A dotted-quad may appear only as the trailing token (the IPv4-in-IPv6 form).
    if (!isLast) return null;
    const octets = ipv4Octets(token);
    if (octets === null) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    return [(a << 8) | b, (c << 8) | d];
  }
  if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
  return [Number.parseInt(token, 16)];
}

/** Parse a colon-run of an IPv6 address into hextets; an embedded dotted-quad
 *  tail (only valid as the final token) contributes its two 16-bit halves. */
function parseHextetRun(run: string): number[] | null {
  if (run === '') return [];
  const tokens = run.split(':');
  const hextets: number[] = [];
  for (const [index, token] of tokens.entries()) {
    const parsed = parseHextetToken(token, index === tokens.length - 1);
    if (parsed === null) return null;
    hextets.push(...parsed);
  }
  return hextets;
}

/** Expand a `::`-compressed address (the runs before and after the `::`) into
 *  eight hextets, zero-filling the elided middle, or null if the two runs are
 *  malformed or together exceed eight hextets. */
function expandCompressed(before: string, after: string): readonly number[] | null {
  const head = parseHextetRun(before);
  const tail = parseHextetRun(after);
  if (head === null || tail === null) return null;
  const fill = IPV6_HEXTETS - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/**
 * Parse an IPv6 literal into its eight 16-bit hextets, or null if it is not a
 * well-formed IPv6 address (a plain IPv4 address returns null — it is hashed
 * verbatim). Handles `::` zero-compression and an embedded IPv4 tail.
 */
function ipv6Hextets(ip: string): readonly number[] | null {
  if (!ip.includes(':')) return null;
  const address = ip.replace(/%.*$/, ''); // drop any zone id (fe80::1%eth0)
  const compress = address.indexOf('::');

  if (compress === -1) {
    const hextets = parseHextetRun(address);
    return hextets?.length === IPV6_HEXTETS ? hextets : null;
  }
  if (address.includes('::', compress + 1)) return null; // a second '::' is illegal
  return expandCompressed(address.slice(0, compress), address.slice(compress + 2));
}

/** Canonical /64 network prefix: the first four hextets, zero-padded lowercase. */
function ipv6PrefixKey(hextets: readonly number[]): string {
  return hextets
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((hextet) => hextet.toString(16).padStart(4, '0'))
    .join(':');
}

/** `::ffff:0:0/96` — five zero hextets then the `ffff` marker. */
const IPV4_MAPPED_ZERO_HEXTETS = 5;
const IPV4_MAPPED_MARKER = 0xff_ff;

/**
 * The dotted quad carried by an IPv4-mapped address (`::ffff:a.b.c.d`, RFC 4291
 * §2.5.5.2), or null if these hextets are not that form. Such an address IS the
 * IPv4 address, so it must take the IPv4 identity: /64 logic would otherwise
 * bucket every mapped address onto the `::` network, which is one global
 * counter rather than the per-delegation bound a real /64 gives.
 */
function ipv4MappedQuad(hextets: readonly number[]): string | null {
  const zeros = hextets.slice(0, IPV4_MAPPED_ZERO_HEXTETS).every((hextet) => hextet === 0);
  if (!zeros || hextets[IPV4_MAPPED_ZERO_HEXTETS] !== IPV4_MAPPED_MARKER) return null;
  return hextets
    .slice(IPV4_MAPPED_ZERO_HEXTETS + 1)
    .flatMap((hextet) => [hextet >> 8, hextet & 0xff])
    .join('.');
}

/**
 * The address reduced to the population it stands for: an IPv6 address becomes
 * its /64 network prefix, except an IPv4-mapped one, which becomes the IPv4
 * address it is; IPv4 (and any unparseable value) stands unchanged.
 *
 * Exported because a second keyed identifier is derived from the same
 * reduction — the growth beacon's daily visitor hash — and a second
 * implementation of it would key two mechanisms on two different populations
 * while both claim to key on one address. It is never itself an identifier:
 * it answers the caller's literal network prefix, so only a digest of it
 * (below) may be stored or keyed on.
 */
export function canonicalCallerIp(address: string): string {
  const hextets = ipv6Hextets(address);
  return hextets === null ? address : (ipv4MappedQuad(hextets) ?? ipv6PrefixKey(hextets));
}

/**
 * The rate-limit identity of an address already in hand: the SHA-256 of
 * {@link canonicalCallerIp}'s reduction, as lowercase hex.
 */
export async function callerIpIdForAddress(address: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalCallerIp(address)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** This caller's IP identity: resolve, collapse to the /64, hash — one call. */
export async function callerIpId(
  header: (name: string) => string | undefined,
  envUtilities: EnvUtilities
): Promise<string> {
  return callerIpIdForAddress(resolveClientIp(header, envUtilities));
}

/**
 * This caller's IP identity for a window that must bound something, or null
 * when production carries no address to derive one from. Null is answered as a
 * REFUSAL rather than as a sentinel identity, because the sentinel would be a
 * single window shared by every caller reaching a Worker whose edge stopped
 * setting `cf-connecting-ip`, so a limiter keyed on it caps the whole fault at
 * one caller's allowance instead of capping anyone. What the REQUEST earns on
 * that refusal is the route's own declared failure posture: 503 where the route
 * declares `closed`, admitted uncounted and reported where it declares `open`.
 * In production the edge sets that header on every request that reaches us, so
 * the null arm is a deployment or edge fault rather than anything a caller can
 * present its way into — which is what lets a route declare either value
 * without handing anybody a self-service bypass. Local modes resolve through
 * the fallback chain and never answer null.
 */
export async function trustedCallerIpId(
  header: (name: string) => string | undefined,
  envUtilities: EnvUtilities
): Promise<string | null> {
  const address = believedClientIp(header, envUtilities);
  return address === null ? null : callerIpIdForAddress(address);
}

/**
 * The abuse bounds the growth counting scripts enforce before they add
 * anything: the beacon's, which is held to all three, and the registration
 * start's, which writes one set family and is held to `set`.
 *
 * Each bounds something the others leave open. `set` bounds how many members
 * any one set may hold in a bucket. `index` bounds how many distinct dimension
 * values a family may open in that bucket; without it, every attacker-chosen
 * referrer host or path was a new set and, under retention forever, a permanent
 * row. `mint` bounds how many distinct visitor identities one address may
 * produce in a day; without it, the identity — a keyed hash over the address
 * and the user agent — was unbounded within a single address, because the user
 * agent is the sender's to vary, so one address could fill the day's visitor
 * set on its own.
 *
 * Past `set` the member is refused and the set's overflow flag is raised, which
 * the rollup copies onto the row so the dashboard can say `100,000+`. Past an
 * `index` ceiling the value folds into a catch-all the column checks still
 * accept, so a fold never blocks the rollup. Past `mint` a beacon under an
 * identity the address has not already minted is dropped rather than folded: a
 * fold would file a real page view under a made-up identity, and no partial
 * write is worth more than the count it corrupts.
 *
 * The families with no entry are bounded by the built page and event allowlists
 * instead, which is a tighter bound than a number would be.
 */
export const GROWTH_CEILINGS = {
  set: 100_000,
  /**
   * Distinct visitor identities one address may mint in a day.
   *
   * Sized from both sides. Above real traffic: the address is fixed in the
   * derivation, so what this counts is distinct user agents behind one address
   * — a handful for a household, and for the fat tail (an office egress, a
   * carrier-grade NAT pool) a count of device-model × OS-version × browser-major
   * strings rather than of people. An address delivering a thousand of those in
   * one day is delivering more traffic on its own than the whole site expects
   * in a day. Below the headline number it protects: the day's visitor set
   * ceiling is `set`, so a hundredth of it means an attacker needs a hundred
   * addresses to exhaust that number, which is the property the design claims
   * and this restores. The edge throttle bounds one address to two beacons a
   * second, so reaching even this ceiling takes a sustained nine minutes.
   *
   * What those addresses cost, so nobody sizing this reads them as scarce: an
   * address here is the shared caller-IP reduction's answer, so under IPv6 it
   * is the sender's network prefix, and prefixes at that granularity are
   * delegated in blocks rather than singly. What a block costs is delegation
   * practice rather than anything this system controls — one that costs
   * nothing is ordinary today, and practice is the half that moves, so read
   * the cost off practice of the day rather than off this sentence.
   * Prefixes also spend their budgets in parallel, each under its own
   * throttle, so the sustained stretch this ceiling costs one address is what
   * the whole attack costs rather than what each address adds to it. Read this
   * ceiling as a bound on one address, never as a bound on how many addresses
   * an attacker can reach.
   */
  mint: 1000,
  index: {
    paths: 500,
    referrers: 1000,
    geo: 1000,
    events: 2000,
    reach: 5000,
  },
} as const;

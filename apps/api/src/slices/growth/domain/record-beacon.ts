import { isbot } from 'isbot';
import {
  GROWTH_BEACON_MAX_BODY_BYTES,
  GROWTH_CEILINGS,
  beaconSchema,
  canonicalMarketingPath,
  isKnownEvent,
  isKnownMarketingPage,
} from '@hushbox/shared';
import { growthDayBucket } from '../../../lib/redis/index.js';
import { ResultAsync, err, ok, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { resolveCampaignTag } from './campaign-tag.js';
import { countBeacon } from './count-beacon.js';
import { deviceFamily, normaliseCountry, normaliseRegion } from './dimensions.js';
import { dailyAddressId, visitorHash } from './visitor-hash.js';
import type { BeaconWrite } from './count-beacon.js';
import type { BeaconBody, GrowthEventIndex } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { Variables } from '../../../lib/context/index.js';

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/**
 * What one beacon amounted to.
 *
 * Silence is the ordinary answer: every outcome but `refused` earns the 204 a
 * counted beacon earns, and that is the design rather than an economy — a
 * beacon naming a page or an event the site does not build is written off
 * without a word, because a 4xx would tell a sender which names exist and every
 * name it could mint would be a row kept forever.
 */
export type BeaconOutcome =
  | { readonly kind: 'dropped' }
  | { readonly kind: 'refused' }
  // The counting module's own answer, carried whole rather than restated: a
  // second spelling of those variants would have to be kept in step with it by
  // hand, and a field added to one side and forgotten on this one is invisible
  // to the caller that reads it.
  | BeaconWrite;

const DROPPED: BeaconOutcome = { kind: 'dropped' };

/**
 * A body that is not one. It rides the OUTCOME rather than the error channel
 * so that it stays distinguishable from an infrastructure failure: the two
 * earn opposite answers — a sender defect is worth saying out loud, and a
 * counter outage must look to the page exactly like a successful count.
 */
const REFUSED: BeaconOutcome = { kind: 'refused' };

export interface RecordBeaconArgs {
  readonly redis: RedisClient;
  /** The key the visitor hash and the mint family's address identities are derived under. */
  readonly secret: string;
  /** The raw request body, still unparsed — the size bound is on bytes, not on a parsed object. */
  readonly rawBody: string;
  readonly userAgent: string;
  /**
   * The caller's address as the shared resolver answered it. Reduced to its
   * network before it is hashed; the address itself is never written down.
   */
  readonly address: string;
  /** The marketing hostname for this mode, from the origin binding. A referrer matching it is an internal navigation. */
  readonly marketingHost: string;
  /** The edge's country and subdivision properties, each narrowed before it is read. */
  readonly country: unknown;
  readonly region: unknown;
  /** The built page-and-event index this deploy bundled. */
  readonly eventIndex: GrowthEventIndex;
  /** Reads the active campaign tags. Called only when the tag registry has expired. */
  readonly listActiveTags: () => ResultAsync<readonly string[], DomainError>;
  /** Server arrival time. Both buckets derive from it, so no sender can choose which hour it lands in. */
  readonly at: Date;
}

/**
 * The parsed body, or the reason it is not one.
 *
 * The size bound is on BYTES and is checked before anything is parsed: the
 * schema describes an object, and a body is what arrived on the wire.
 */
function readBody(raw: string): Result<BeaconBody, DomainError> {
  if (new TextEncoder().encode(raw).length > GROWTH_BEACON_MAX_BODY_BYTES) {
    return err(validationError('beacon body exceeds the size a sender may present'));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    return err(validationError('beacon body is not readable as JSON', error));
  }
  const parsed = beaconSchema.safeParse(decoded);
  return parsed.success
    ? ok(parsed.data)
    : err(validationError('beacon body failed the shared schema', parsed.error));
}

/**
 * Whether the beacon names something the site actually built: a page from the
 * built set, and for an event, a name that page's own markup derives.
 */
function namesSomethingBuilt(body: BeaconBody, index: GrowthEventIndex): boolean {
  if (!isKnownMarketingPage(body.p, Object.keys(index))) return false;
  if (body.t === 'v') return true;
  return body.n !== undefined && isKnownEvent(body.p, body.n, index);
}

/**
 * The referrer host worth counting, or nothing.
 *
 * A visitor moving between our own pages arrives with our own hostname as the
 * referrer, which is not a source of traffic — left in, our own domain becomes
 * the top referrer on the dashboard and every real source is buried under it.
 * The drop is server-side because that is the only side a lying sender cannot
 * bypass; the page has no reason to send it, and this does not rest on that.
 *
 * `ours` is the marketing host FOR THIS MODE, read from the same origin binding
 * the CORS stage answers this same question from. A hardcoded production host
 * would make the rule inert everywhere else — local development and the
 * end-to-end run would count an internal navigation as an external referrer,
 * which is precisely what this exists to prevent, and no end-to-end test could
 * ever assert it.
 */
function externalReferrer(host: string | undefined, ours: string): string | undefined {
  return host === undefined || host === ours ? undefined : host;
}

/**
 * Records one beacon, or decides there is nothing to record.
 *
 * The whole of the decision lives here rather than at the route seam, because
 * every step of it is a rule about the measurement: which senders count, which
 * names are real, which campaign a visit belongs to, and what identity the
 * count is a membership of. The route reads the request and maps the answer to
 * a status, and holds none of it.
 *
 * A malformed body is the one input that answers an error: it is a sender
 * defect rather than a visitor's problem, and saying so is what makes a broken
 * script visible instead of silently uncounted.
 */
export function recordBeacon(args: RecordBeaconArgs): ResultAsync<BeaconOutcome, DomainError> {
  if (isbot(args.userAgent)) return okAsync(DROPPED);

  // A malformed body is an OUTCOME rather than an error: the two channels earn
  // opposite answers, and only the outcome survives the route's own reading.
  const body = readBody(args.rawBody);
  if (body.isErr()) return okAsync(REFUSED);
  const beacon = body.value;
  if (!namesSomethingBuilt(beacon, args.eventIndex)) return okAsync(DROPPED);

  // ONE spelling of the page, decided here and used for every downstream
  // effect. Validating under a canonical path and counting under the submitted
  // one would write keys, index members and permanently-retained rows under a
  // spelling the built page set never contained, and split one page's counts
  // across two rows that nothing downstream could recognise as one page.
  const path = canonicalMarketingPath(beacon.p);
  const country = normaliseCountry(args.country);
  // Every derivation is a platform primitive over values already validated:
  // none has a failing input, so they are lifted WITHOUT an error mapper. A
  // mapper here would be an arm no test could ever reach, and it would turn a
  // WebCrypto defect — the only way one rejects — into a silent 204 instead
  // of the exception a defect is supposed to be.
  const day = growthDayBucket(args.at);
  const keyed = { secret: args.secret, address: args.address, day };
  const identities = ResultAsync.fromSafePromise(
    Promise.all([
      visitorHash({ ...keyed, userAgent: args.userAgent }),
      dailyAddressId({ ...keyed, set: 'mint' }),
      dailyAddressId({ ...keyed, set: 'mintCapped' }),
    ])
  );

  return resolveCampaignTag({
    redis: args.redis,
    listActiveTags: args.listActiveTags,
    tag: beacon.c,
  }).andThen((campaign) =>
    identities.andThen(([hash, mintId, mintCappedId]) =>
      countBeacon(args.redis, {
        kind: beacon.t === 'v' ? 'view' : 'event',
        path,
        referrerHost: externalReferrer(beacon.r, args.marketingHost),
        campaign,
        eventName: beacon.n,
        country,
        region: normaliseRegion(country, args.region),
        device: deviceFamily(args.userAgent),
        visitor: hash,
        mintId,
        mintCappedId,
        at: args.at,
        ceilings: GROWTH_CEILINGS,
      })
    )
  );
}

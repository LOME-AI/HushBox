import { growthDayBucket, growthHourBucket } from '@hushbox/shared';

// The growth key registry, imported rather than re-spelled. A key is the
// middle of everything this suite asserts on — a second spelling here would
// read sets the counting path never wrote and report nothing wrong, which is
// exactly the silent failure `docs/CODE-RULES.md` §One Implementation, Shared
// names. It is the product Worker's module because that is where the registry
// lives; nothing in this import reaches further than zod.
import { GROWTH_REDIS_KEYS } from '../../apps/api/src/lib/redis/growth-keys.js';
import { requireEnv } from './env.js';
import { expect } from './expect.js';
import { expectOkResponse } from './ok-response.js';
import { withProjectHeaders } from './project-headers.js';
import { withRequestRetry } from './resilient-request.js';
import type { APIRequest, APIRequestContext } from '@playwright/test';

const restUrl = requireEnv('UPSTASH_REDIS_REST_URL');
const restToken = requireEnv('UPSTASH_REDIS_REST_TOKEN');

/** One millisecond-precision hour, for walking the buckets a run spans. */
const HOUR_MS = 60 * 60 * 1000;

/** The Upstash REST envelope: one of the two fields is present. */
interface RedisReply {
  readonly result?: unknown;
  readonly error?: string;
}

/**
 * Direct access to the counting store the beacon writes, as the acceptance
 * asks for: the specification's own connection to the local
 * Serverless-Redis-HTTP container, on the same token the Worker holds, so what
 * it reads is what the Worker wrote.
 *
 * Reads only, with one exception stated at {@link GrowthStore.forgetActiveCampaigns}.
 */
export interface GrowthStore {
  members(key: string): Promise<readonly string[]>;
  value(key: string): Promise<string | null>;
  /**
   * Drops the cached active-campaign list so the next beacon reads the
   * campaigns table again.
   *
   * The list is cached for minutes, and a tag minted inside that window folds
   * to the unknown sentinel until it expires — so without this a freshly
   * minted tag counts under a name this specification never asserts on, for a
   * reason no assertion could name. Dropping it is safe for anything running
   * beside this: the refill reads Postgres, where every tag any concurrent
   * specification minted is already committed.
   */
  forgetActiveCampaigns(): Promise<void>;
  dispose(): Promise<void>;
}

function asMembers(result: unknown): readonly string[] {
  if (!Array.isArray(result)) return [];
  return result.map((member) => (typeof member === 'string' ? member : ''));
}

/** Opens the store connection. The caller owns disposal. */
export async function openGrowthStore(request: APIRequest): Promise<GrowthStore> {
  const context: APIRequestContext = withRequestRetry(
    await request.newContext({
      baseURL: restUrl,
      extraHTTPHeaders: withProjectHeaders({ authorization: `Bearer ${restToken}` }),
    })
  );

  const command = async (argv: readonly string[]): Promise<unknown> => {
    const response = await context.post('/', { data: argv });
    await expectOkResponse(response, `growth store: ${argv[0] ?? '?'}`);
    const reply = (await response.json()) as RedisReply;
    if (reply.error !== undefined) {
      throw new Error(`growth store: ${argv[0] ?? '?'} failed — ${reply.error}`);
    }
    return reply.result;
  };

  return {
    members: async (key) => asMembers(await command(['SMEMBERS', key])),
    value: async (key) => {
      const result = await command(['GET', key]);
      return typeof result === 'string' ? result : null;
    },
    forgetActiveCampaigns: async () => {
      await command(['DEL', GROWTH_REDIS_KEYS.activeCampaigns.buildKey()]);
    },
    dispose: () => context.dispose(),
  };
}

/**
 * The buckets a specification's beacons can have landed in, and the read
 * window covering them.
 *
 * The server stamps every beacon with its own arrival instant, so a run that
 * crosses an hour boundary files its first beacons under one hour bucket and
 * its last under the next. Nothing can pin that instant — `page.clock` moves
 * the browser's clock, never the Worker's — so the window is enumerated
 * instead, and every hour-grain assertion reads the union across it. One
 * bucket is the ordinary case.
 */
export interface BeaconWindow {
  /** Every hour bucket a beacon sent since the window opened can carry. */
  hours(): readonly string[];
  /** The UTC day every beacon of this run belongs to. */
  day(): string;
  /**
   * The half-open `[from, to)` the growth reads take, covering every bucket a
   * run's beacons can carry at BOTH grains.
   *
   * It opens at the run day's midnight rather than at the run's own hour: a
   * day-grain row is stamped with the day's start, so a window opening at the
   * current hour excludes every day row it was meant to read — the hour rows
   * land inside it and the day rows silently do not.
   */
  readWindow(): { readonly from: string; readonly to: string };
}

/**
 * Opens the window at the current instant.
 *
 * A run that crosses UTC midnight is refused by name rather than asserted
 * against: the visitor identity is keyed by day, so the beacons before and
 * after midnight belong to two different visitors and no membership claim
 * about "this visitor" holds across them.
 */
export function openBeaconWindow(): BeaconWindow {
  const opened = new Date();
  const hourStart = (at: Date): number =>
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours());
  const day = (): string => {
    const now = new Date();
    if (growthDayBucket(now) !== growthDayBucket(opened)) {
      throw new Error(
        'growth window: this run crossed UTC midnight, where the day-keyed visitor identity rotates — the counts on either side belong to two different visitors, so re-run it'
      );
    }
    return growthDayBucket(opened);
  };
  return {
    hours: () => {
      const buckets: string[] = [];
      for (let at = hourStart(opened); at <= hourStart(new Date()); at += HOUR_MS) {
        buckets.push(growthHourBucket(new Date(at)));
      }
      return buckets;
    },
    day,
    readWindow: () => ({
      from: new Date(
        Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth(), opened.getUTCDate())
      ).toISOString(),
      to: new Date(hourStart(new Date()) + HOUR_MS).toISOString(),
    }),
  };
}

/** The members one hour-grain set holds, across every bucket the run could have written it in. */
export async function membersAcrossHours(
  store: GrowthStore,
  window: BeaconWindow,
  key: (hour: string) => string
): Promise<readonly string[]> {
  const seen = new Set<string>();
  for (const hour of window.hours()) {
    for (const member of await store.members(key(hour))) seen.add(member);
  }
  return [...seen];
}

/**
 * The one member a campaign-keyed set holds, waited for and then read.
 *
 * Only a set whose key carries this run's own campaign tag may be read this
 * way: the tag is minted per project and worker slot, so one visitor identity
 * writes it and the sole member is that identity. `what` states the fact the
 * caller is establishing, so a set that never fills fails on the claim rather
 * than on a bare zero.
 */
export async function soleMemberAcrossHours(
  store: GrowthStore,
  window: BeaconWindow,
  key: (hour: string) => string,
  what: string
): Promise<string> {
  await expect
    .poll(
      async () => {
        const members = await membersAcrossHours(store, window, key);
        return members.length;
      },
      { message: what }
    )
    .toBe(1);
  const [member] = await membersAcrossHours(store, window, key);
  if (member === undefined) throw new Error(`${what}: the set emptied between two reads`);
  return member;
}

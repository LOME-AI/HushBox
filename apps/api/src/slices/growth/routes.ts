import { Hono } from 'hono';
import { ERROR_CODES, GROWTH_BEACON_PATH } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  FINGERPRINT_CODES,
  createErrorResponse,
  edgeGeography,
  idempotencyExempt,
  idempotent,
  recordBeacon,
  resolveClientIp,
  runMutation,
} from './domain/index.js';
import type { GrowthEventIndex } from '@hushbox/shared';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Bindings, GrowthStores, RecordBeaconArgs } from './domain/index.js';

/**
 * The origin binding this route reads, declared here as the CORS stage
 * declares its own: the registry defines it for every mode, and reading it is
 * what keeps the internal-referrer rule true outside production.
 */
interface GrowthBindings extends Bindings {
  MARKETING_URL?: string;
}

interface GrowthRouteDeps {
  readonly stores: GrowthStores;
  /** The built page-and-event index this deploy bundled. */
  readonly eventIndex: GrowthEventIndex;
}

/**
 * The anonymous half of growth measurement: one public write path, and the only
 * one there is.
 *
 * - **Same-origin.** A zone route puts it on the marketing hostname, and the
 *   `text/plain` body makes it a CORS simple request with no preflight to
 *   spend. It does not put the session cookie out of reach: cookies scope by
 *   host and ignore the port, so on a development stack, where every origin is
 *   `localhost`, the cookie is in scope and a sender that includes credentials
 *   makes it arrive. What keeps it away is the credential defence rather than
 *   the arrangement: the marketing script posts with credentials omitted
 *   (`packages/ui/src/components/growth/init-script.ts`), and in production the
 *   cookie is host-only on the API host. Only the first of those can be observed
 *   from here; the second rests on a declaration — `sessionCookieOptions` sets
 *   no `domain` — as does the hostname this path is served on, which
 *   `apps/api/wrangler.toml` claims and only a deploy applies. Same-origin's own
 *   contribution is narrower and real, and it composes with the host-only
 *   declaration: in production the post never lands on the host that holds the
 *   cookie. An arriving cookie is unsealed into the principal the pipeline
 *   resolves for every route, and this path never reads it.
 * - **It answers 204 to everything it accepts, and to every failure it meets.**
 *   A counter outage must never break a marketing page, so an unreachable Redis
 *   is one report on the error channel and an ordinary answer on the wire. The
 *   one exception is a malformed body, which is a sender defect rather than a
 *   visitor's problem and is worth saying out loud.
 * - **Every count is a set membership**, which is what makes the idempotency
 *   exemption below literally true: a duplicated delivery is a duplicate
 *   `SADD`, and it converges.
 * - **Nothing it writes can be joined to an account.** It resolves no
 *   principal, reads no session, and the identity it counts under exists in
 *   Redis and in no table; how long a counting set holds it is
 *   `addUnderCeiling`'s to say
 *   (`apps/api/src/slices/growth/domain/ceiling-gate.ts`).
 */
export function createGrowthManifest(deps: GrowthRouteDeps) {
  return defineSliceManifest({
    basePath: GROWTH_BEACON_PATH,
    routes: new Hono<AppEnv>().post(
      '/',
      routeClass('public'),
      idempotencyExempt('naturally-idempotent'),
      async (c) => {
        const env: GrowthBindings = c.env;
        const secret = env.GROWTH_HASH_SECRET;
        if (secret === undefined || secret === '') {
          throw new Error('GROWTH_HASH_SECRET is required to count a marketing beacon');
        }
        // A missing origin is a deploy misconfiguration rather than a state to
        // tolerate: without it every internal navigation would be counted as a
        // referrer, and our own domain would lead the dashboard.
        if (env.MARKETING_URL === undefined || env.MARKETING_URL === '') {
          throw new Error('MARKETING_URL is required to tell an internal referrer from a source');
        }

        const header = (name: string): string | undefined => c.req.header(name);
        const geography = edgeGeography(c.req.raw);
        const args: RecordBeaconArgs = {
          redis: c.var.redis,
          secret,
          rawBody: await c.req.text(),
          userAgent: header('user-agent') ?? '',
          address: resolveClientIp(header, c.var.envUtils),
          marketingHost: new URL(env.MARKETING_URL).hostname,
          country: geography.country,
          region: geography.region,
          eventIndex: deps.eventIndex,
          listActiveTags: () => deps.stores.listActiveCampaignTags(c.var.db),
          at: new Date(),
        };
        const recorded = await runMutation(() => idempotent.byUpsert(() => recordBeacon(args)));

        return recorded.match(
          (outcome) => {
            if (outcome.kind === 'refused') {
              return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
            }
            // The beacon that FILLS an address's identity budget is counted
            // and the ones refused past it are dropped, and every one of them
            // answers the page the same 204 — so nothing on the wire says an
            // address stopped counting anyone new behind it, and this report is
            // what tells an operator. It reads both spellings because the
            // budget is reached on the counted one: a sender sized at exactly
            // the budget is refused nothing, and a report that waited for a
            // refusal would never see it. The store latches the two together,
            // so this fires once per address per day.
            //
            // The accepted false positive — a large shared egress that
            // really does put that many distinct visitors behind one address —
            // is stated at this code's entry in the fingerprint registry rather
            // than in the error raised here. An error's message never leaves
            // the process, so the code is the only prose an operator can reach
            // from what they are handed; text put in the message would be
            // written for nobody.
            const filledIdentityBudget =
              outcome.kind === 'counted'
                ? outcome.mintFilled
                : outcome.kind === 'capped' && outcome.firstToday;
            if (filledIdentityBudget) {
              c.var.logger.captureError(
                new Error('growth: an address reached its daily identity budget'),
                FINGERPRINT_CODES.growthVisitorMintCapped
              );
            }
            if (outcome.kind === 'counted') {
              for (const setName of outcome.overflowed) {
                c.var.logger.captureError(
                  new Error(`growth set reached its ceiling: ${setName}`),
                  FINGERPRINT_CODES.growthSetOverflowed
                );
              }
            }
            return c.body(null, 204);
          },
          () => {
            c.var.logger.captureError(
              new Error('growth beacon could not be counted'),
              FINGERPRINT_CODES.growthCounterUnavailable
            );
            return c.body(null, 204);
          }
        );
      }
    ),
  });
}

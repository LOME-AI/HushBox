import {
  growthEventsReadSchema,
  growthMarketingReadSchema,
  growthReachReadSchema,
} from '@hushbox/shared';

import { mintAdminApiContext } from './admin-api-context.js';
import { idempotentPost } from './idempotent-request.js';
import { expectOkResponse } from './ok-response.js';
import type {
  GrowthEventRowWire,
  GrowthGrain,
  GrowthMarketingRowWire,
  GrowthReachRowWire,
} from '@hushbox/shared';
import type { APIRequest, APIRequestContext } from '@playwright/test';

/**
 * The two dev actors this specification acts as, both admitted by the API's
 * dev-mode `ADMIN_ACTOR_ALLOWLIST`.
 *
 * The split is not decoration. The mint is a mutation, so it needs the
 * `operator` the contract names; every read additionally admits the read-only
 * role, which is the role the Growth screen is built for — so reading as the
 * viewer exercises the role that will do the reading, and keeps this
 * specification's four reads out of the operator's hourly operations budget,
 * which the admin suite spends heavily in the same run.
 */
export const GROWTH_ACTORS = {
  operator: 'admin@hushbox.test',
  reader: 'viewer@hushbox.test',
} as const;

export type GrowthActor = (typeof GROWTH_ACTORS)[keyof typeof GROWTH_ACTORS];

/** The reason every admin operation records; the contract requires one. */
const REASON = 'e2e marketing analytics';

/** A half-open read window, as every growth read takes one. */
export interface GrowthReadWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * Worker-direct admin API context as one of {@link GROWTH_ACTORS}, which is the
 * narrowing this wrapper carries over {@link mintAdminApiContext}. Caller owns
 * disposal.
 */
export function mintGrowthAdminContext(
  request: APIRequest,
  actor: GrowthActor
): Promise<APIRequestContext> {
  return mintAdminApiContext(request, actor);
}

/** The status the mint answers when an active campaign already holds the tag. */
const CONFLICT = 409;

/**
 * Mints the campaign the specification counts under, through the registered
 * operation an operator would use.
 *
 * A tag this run's identity already minted answers a conflict, which is
 * already-done rather than a failure: the tag is derived from the project and
 * worker slot, so a re-run inside the same slot meets its own earlier row.
 */
export async function mintCampaign(api: APIRequestContext, tag: string): Promise<void> {
  const response = await idempotentPost(api, '/admin/ops/growth.campaign.create/execute', {
    data: { input: { tag, label: `E2E ${tag}`, reason: REASON } },
  });
  await expectOkResponse(response, `growth.campaign.create for ${tag}`, [200, CONFLICT]);
}

/** What the forced rollup answers: the hour it reduced, and what became of it. */
interface RollupOutcome {
  readonly hour: string;
  readonly outcome: { readonly kind: string };
}

/**
 * Runs the hourly reduction for one hour through the dev trigger, so the rows
 * can be read without waiting for the schedule. The dev-server cron ticker is
 * off under the end-to-end mode, so this fire is the only one there is.
 */
export async function rollupHour(api: APIRequestContext, hour: string): Promise<string> {
  const response = await idempotentPost(api, '/dev/growth-rollup', { data: { hour } });
  await expectOkResponse(response, `growth rollup of ${hour}`);
  const { outcome } = (await response.json()) as RollupOutcome;
  return outcome.kind;
}

/** One read operation's `data` payload, unwrapped from the engine's run envelope. */
async function readOp(
  api: APIRequestContext,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const response = await idempotentPost(api, `/admin/ops/${name}/execute`, { data: { input } });
  await expectOkResponse(response, name, 200);
  const { data } = (await response.json()) as { data: unknown };
  return data;
}

/**
 * A panel's rows, or the panel's own failure raised by name. Every growth read
 * degrades per panel rather than failing its run, so an unavailable panel
 * arrives inside a 200 and would otherwise read here as "no rows" — a passing
 * absence assertion over a panel that never loaded.
 */
function panelRows<Row>(
  panel:
    | { readonly ok: true; readonly data: { readonly rows: readonly Row[] } }
    | { readonly ok: false; readonly error: string },
  name: string
): readonly Row[] {
  if (!panel.ok) throw new Error(`growth ${name} panel was unavailable: ${panel.error}`);
  return panel.data.rows;
}

/** Every marketing marginal in the window at one grain. */
export async function readMarketingRows(
  api: APIRequestContext,
  window: GrowthReadWindow,
  grain: GrowthGrain
): Promise<readonly GrowthMarketingRowWire[]> {
  const read = growthMarketingReadSchema.parse(
    await readOp(api, 'growth.marketing.read', { ...window, grain })
  );
  return panelRows(read.panels.marketing, 'marketing');
}

/** Every named-event row in the window under one campaign tag. */
export async function readEventRows(
  api: APIRequestContext,
  window: GrowthReadWindow,
  campaign: string
): Promise<readonly GrowthEventRowWire[]> {
  const read = growthEventsReadSchema.parse(
    await readOp(api, 'growth.events.read', { ...window, campaign, page: 0 })
  );
  return panelRows(read.panels.events, 'events');
}

/** Every landing-to-reached pair in the window. */
export async function readReachRows(
  api: APIRequestContext,
  window: GrowthReadWindow
): Promise<readonly GrowthReachRowWire[]> {
  const read = growthReachReadSchema.parse(await readOp(api, 'growth.reach.read', { ...window }));
  return panelRows(read.panels.reach, 'reach');
}

/**
 * Reads the cost the provider actually sent, out of the recording that carried
 * its response.
 *
 * The adapters extract cost from the SDK's `providerMetadata`, which the
 * provider package builds in memory from the wire — so a test holding only the
 * extracted number cannot tell a correct read from a field that moved and
 * parsed to `undefined` through a loose schema. Nothing in the provider exposes
 * its own response to a caller, and the cassette is that response persisted, so
 * it is the only place the wire value can be held beside the extracted one.
 *
 * The wire path read here (`usage.cost`) is deliberately not the extractors'
 * path (`openrouter.usage.cost` for a stream, `openrouter.cost` for a media
 * generation). The two are independent readings of the same fact and the seam
 * between them is what a comparison proves; sharing one reader would make that
 * comparison circular.
 */

import { z } from 'zod';
import { replayFromCassette } from './recording-fetch.js';
import type { CassetteStore } from './cassette-store.js';

const wireUsageSchema = z.looseObject({
  usage: z.looseObject({ cost: z.number().nullish() }).nullish(),
});

/** The wire `usage.cost` of one decoded payload; absent means the payload carried none. */
function wireCostOf(payload: unknown): number | undefined {
  const parsed = wireUsageSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const cost = parsed.data.usage?.cost;
  return typeof cost === 'number' ? cost : undefined;
}

/** The wire cost one recorded response body carries, if it carries one. */
type CostReader = (body: string) => number | undefined;

/**
 * The cost carried by the recording for `generationId`, whose body is replayed
 * through the same decoder the SDK is handed so the bytes read here are the
 * bytes it read.
 *
 * Identity is the run's own generation id rather than the request shape,
 * because a media flow records several exchanges (submit, poll, download) and a
 * suite records several exchanges against a single path, which a path match
 * could not tell apart. Carrying the id does not by itself single one out: the
 * provider declares `generation_id` on the submit response as well as the poll,
 * and the store enumerates in filesystem order, so a recording qualifies only
 * when it also yields a cost. That is what makes the answer independent of scan
 * order rather than dependent on the cost-free submit being reached second.
 */
async function recordedCostFor(
  store: CassetteStore,
  generationId: string,
  costOf: CostReader
): Promise<number | undefined> {
  for (const hash of store.list()) {
    const cassette = store.read(hash);
    // Unreadable, and exchange-less, are what the fetch wrapper treats as a
    // miss; replaying an exchange-less recording is its stated invariant break.
    if (cassette === undefined || cassette.exchanges.length === 0) continue;
    const body = await replayFromCassette(cassette).text();
    if (!body.includes(generationId)) continue;
    const cost = costOf(body);
    if (cost !== undefined) return cost;
  }
  return undefined;
}

/** The inline cost of the frame carrying `usage` in a recorded SSE stream. */
function streamCostOf(body: string): number | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') continue;
    const frame: unknown = JSON.parse(payload);
    const cost = wireCostOf(frame);
    if (cost !== undefined) return cost;
  }
  return undefined;
}

/** The inline cost of a recorded JSON response body. */
function jsonCostOf(body: string): number | undefined {
  const payload: unknown = JSON.parse(body);
  return wireCostOf(payload);
}

/**
 * The inline cost a recorded chat stream carried. One recording holds one
 * step's exchange, so the single frame carrying `usage` carries that step's
 * whole inline cost — which is what the language adapter bills for a
 * single-step run.
 */
export async function recordedStreamCostUsd(
  store: CassetteStore,
  generationId: string
): Promise<number | undefined> {
  return recordedCostFor(store, generationId, streamCostOf);
}

/**
 * The inline cost a recorded media generation carried: `usage.cost` of the JSON
 * response that carries both the generation id and a cost, which for video is
 * the completed poll.
 */
export async function recordedMediaCostUsd(
  store: CassetteStore,
  generationId: string
): Promise<number | undefined> {
  return recordedCostFor(store, generationId, jsonCostOf);
}

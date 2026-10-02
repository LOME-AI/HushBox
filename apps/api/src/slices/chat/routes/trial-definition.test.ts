import { describe, expect, it } from 'vitest';
import { trialTurnDefinitionOrRefusal } from './trial-definition.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { Context } from 'hono';

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

/**
 * A handle whose only use here is the catalog read, which builds its query and
 * awaits it — so a rejecting `from` is the whole failure. The read translates
 * the rejection into a typed `unavailable` rather than throwing, which is what
 * makes the failure observable as a status. Asserted for the same reason a
 * documented `any` is: the real handle is a Drizzle client no test can build.
 */
function rejectingDatabase(): Database {
  return {
    select: () => ({ from: () => Promise.reject(new Error('catalog read refused')) }),
  } as unknown as Database;
}

/**
 * The trial definition reads only `c.json`, `c.var.db` and `c.var.logger`, plus
 * `c.get` and `c.set`, through which the refusal tail reads the logger and
 * records an availability refusal's classification; a real `Context<AppEnv>`
 * carries the whole request pipeline — so the double is asserted, with the same
 * justification a documented `any` needs. Its `get` binds no logger, so the tail
 * captures nothing. The assertion is what keeps each case to the one failure
 * under test instead of a served request.
 */
function catalogFailureContext(): Context<AppEnv> {
  return {
    json: (body: unknown, status: number) => ({ body, status }),
    get: (): undefined => undefined,
    set: (): undefined => undefined,
    var: { db: rejectingDatabase(), logger: silentTelemetry },
  } as unknown as Context<AppEnv>;
}

describe('trialTurnDefinitionOrRefusal', () => {
  it('answers the typed unavailable when the Smart-slot build cannot read the catalog', async () => {
    const response = await trialTurnDefinitionOrRefusal(
      catalogFailureContext(),
      { turnSources: [{ kind: 'smart' }], prompt: 'hello' },
      []
    );

    expect(response).toMatchObject({ status: 503 });
  });

  it('answers the typed unavailable when a pinned send cannot read the catalog', async () => {
    const response = await trialTurnDefinitionOrRefusal(
      catalogFailureContext(),
      { turnSources: [{ kind: 'model', id: 'vendor/model' }], prompt: 'hello' },
      []
    );

    expect(response).toMatchObject({ status: 503 });
  });
});

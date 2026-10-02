/**
 * Firing the product Worker's `scheduled()` handler locally: the ticker
 * `pnpm dev` arms so the four deployed schedules run at their real cadence, and
 * `pnpm cron:fire <schedule>` for firing one on demand.
 *
 * The mechanism is Miniflare's own scheduled endpoint, which the local Worker
 * runtime exposes unconditionally — no flag, no bundle change. The request is
 * intercepted by the dev proxy before the Worker's `fetch` handler runs, so it
 * bypasses Hono routing, auth, the rate-limit posture and the cache stage, and
 * cannot collide with an application route.
 *
 * Two properties of that endpoint shape everything here:
 *
 *  - It passes the `cron` query value through to `scheduled()` verbatim and
 *    answers 200 whatever the handler makes of it. `cronEntriesFor` in
 *    `apps/api/src/scheduled.ts` resolves the expression to the schedule that
 *    registers it, so an expression no schedule registers produces a green
 *    response and no work. A 200 is therefore evidence the handler was
 *    reached, never evidence an entry ran.
 *  - It resolves only once the handler's promise and its `waitUntil` promises
 *    have settled, and answers 500 when the handler throws — which is what
 *    makes it awaitable from a test and what makes a construction fault visible.
 */
import { CRON_SCHEDULES } from '@hushbox/api/cron-schedules';
import { createEnvUtilities } from '@hushbox/shared';
import { isMainModule } from './lib/cli/is-main.js';
import { messageChain, runMain } from './lib/cli/run-main.js';
import type { EnvContext } from '@hushbox/shared';

// Re-exported so a caller names a schedule through this module alone rather
// than reaching past it for the map the Worker dispatches from.
export { CRON_SCHEDULES } from '@hushbox/api/cron-schedules';
export type { CronScheduleName } from '@hushbox/api/cron-schedules';

/**
 * Miniflare's scheduled-trigger endpoint. Miniflare v5 (wrangler 4.129.0) moved
 * its internal endpoints from `/cdn-cgi/handler/` to `/cdn-cgi/local/`; the old
 * spelling still resolves through a rewrite table in wrangler's dev proxy whose
 * permanence is undocumented, so the current path is named once here and every
 * caller takes it from this constant.
 */
export const SCHEDULED_TRIGGER_PATH = '/cdn-cgi/local/scheduled';

/** The schedule an argument names, or a throw listing the ones that exist. */
export function resolveScheduleName(name: string): string {
  const expression = (CRON_SCHEDULES as Record<string, string | undefined>)[name];
  if (expression === undefined) {
    throw new Error(
      `cron:fire: unknown schedule ${JSON.stringify(name)}. Known schedules: ${Object.keys(
        CRON_SCHEDULES
      ).join(', ')}`
    );
  }
  return expression;
}

/** The scheduled-trigger URL for one expression on a running dev server. */
export function scheduledTriggerUrl(baseUrl: string, cron: string): string {
  const origin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${origin}${SCHEDULED_TRIGGER_PATH}?cron=${encodeURIComponent(cron)}`;
}

interface FireCronResult {
  readonly status: number;
  readonly body: string;
}

/**
 * Fire one expression and wait for the handler to finish. The status is
 * returned rather than thrown on so a caller can distinguish a handler that
 * threw (500) from one that ran; neither says an entry matched.
 */
export async function fireCron(
  baseUrl: string,
  cron: string,
  fetchImpl: typeof globalThis.fetch
): Promise<FireCronResult> {
  const response = await fetchImpl(scheduledTriggerUrl(baseUrl, cron));
  return { status: response.status, body: await response.text() };
}

const CRON_FIELD_COUNT = 5;

const STEP_PREFIX = '*/';

/** A cron field's accepted forms: every value, a step, or one literal value. */
function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith(STEP_PREFIX)) {
    const divisor = Number(field.slice(STEP_PREFIX.length));
    if (!Number.isInteger(divisor) || divisor <= 0) {
      throw new Error(
        `cron field ${JSON.stringify(field)} does not step by a positive whole number`
      );
    }
    return value % divisor === 0;
  }
  if (/^\d+$/.test(field)) return Number(field) === value;
  throw new Error(
    `cron field ${JSON.stringify(field)} is not one of the forms this ticker evaluates: "*", "*/n", or a literal number`
  );
}

/**
 * Whether an expression selects the minute `at` falls in, read in UTC — the
 * zone Cloudflare's own triggers are evaluated in, so a developer's local zone
 * cannot shift when a schedule fires.
 *
 * Every field must hold, day-of-month and day-of-week included. Standard cron
 * instead ORs those two once both are restricted; the difference is invisible
 * while every registered expression leaves both as `*`, and an expression that
 * restricted one would need this rule revisited before it fired correctly.
 */
export function cronMatches(expression: string, at: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new Error(
      `cron expression ${JSON.stringify(expression)} does not carry five fields (minute hour day-of-month month day-of-week)`
    );
  }
  const values = [
    at.getUTCMinutes(),
    at.getUTCHours(),
    at.getUTCDate(),
    at.getUTCMonth() + 1,
    at.getUTCDay(),
  ];
  /* v8 ignore next -- the field count is checked above, so the index is always in range */
  return fields.every((field, index) => fieldMatches(field, values[index] ?? 0));
}

interface CronTicker {
  stop: () => void;
}

const MINUTE_MS = 60_000;

/**
 * How far past the minute boundary the tick lands. A timer that fires a few
 * milliseconds early would read the previous minute and evaluate the wrong
 * one; the offset is larger than any such skew and small enough that a
 * schedule still runs in the minute it names.
 */
const TICK_OFFSET_MS = 500;

function millisecondsToNextTick(nowMs: number): number {
  return MINUTE_MS - (nowMs % MINUTE_MS) + TICK_OFFSET_MS;
}

/**
 * Evaluate every expression once a minute and fire the ones the minute
 * selects. Firing is promptness, never delivery: a fire that fails is reported
 * and the ticker carries on, because the schedule comes round again and
 * nothing downstream depends on any single tick arriving.
 */
export function startCronTicker(deps: {
  readonly crons: readonly string[];
  readonly fire: (cron: string) => Promise<void>;
  readonly onFireFailed: (cron: string, error: unknown) => void;
}): CronTicker {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (): void => {
    const now = Date.now();
    timer = setTimeout(() => {
      const at = new Date(Date.now());
      for (const cron of deps.crons) {
        if (!cronMatches(cron, at)) continue;
        void (async (): Promise<void> => {
          try {
            await deps.fire(cron);
          } catch (error: unknown) {
            deps.onFireFailed(cron, error);
          }
        })();
      }
      if (!stopped) arm();
    }, millisecondsToNextTick(now));
    timer.unref();
  };

  arm();

  return {
    stop: (): void => {
      stopped = true;
      /* v8 ignore next -- arm() assigns the timer before the ticker is handed back, so stop always has one */
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Whether the dev server should arm the ticker. Off under E2E: a spec fires the
 * schedule it is about through the E2E helper and asserts on its effect, and a
 * ticker firing the same schedules underneath would run entries no spec asked
 * for, against the same database, at moments no spec controls.
 */
export function shouldStartCronTicker(env: EnvContext): boolean {
  return !createEnvUtilities(env).isE2E;
}

/** The dev server's own origin, from the port the stack assigned this worktree. */
function devApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const port = env['HB_API_PORT'];
  if (port === undefined || port === '') {
    throw new Error('cron:fire: HB_API_PORT is not set — run pnpm generate:env first');
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * The ticker `pnpm dev` arms, or `null` under E2E. The notice is printed
 * because wrangler's programmatic start, unlike its `dev` command, announces no
 * scheduled endpoint, so without this line the on-demand path has nothing
 * announcing it.
 */
export function startDevCronTicker(env: NodeJS.ProcessEnv): CronTicker | null {
  if (!shouldStartCronTicker(env)) return null;
  const baseUrl = devApiBaseUrl(env);
  console.warn(
    `cron: ${String(Object.keys(CRON_SCHEDULES).length)} schedules armed at their real cadence — fire one now with \`pnpm cron:fire <${Object.keys(CRON_SCHEDULES).join('|')}>\``
  );
  return startCronTicker({
    crons: Object.values(CRON_SCHEDULES),
    fire: async (cron) => {
      const { status, body } = await fireCron(baseUrl, cron, globalThis.fetch);
      if (status !== 200) {
        throw new Error(`scheduled endpoint answered ${String(status)}: ${body}`);
      }
    },
    onFireFailed: (cron, error) => {
      console.warn(`cron: firing ${cron} failed — ${messageChain(error)}`);
    },
  });
}

/** `pnpm cron:fire <schedule>`. */
export async function runFireCron(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof globalThis.fetch
): Promise<number> {
  const [name] = argv;
  if (name === undefined) {
    throw new Error(`cron:fire: Usage: pnpm cron:fire <${Object.keys(CRON_SCHEDULES).join('|')}>`);
  }
  const cron = resolveScheduleName(name);
  const baseUrl = devApiBaseUrl(env);
  const { status, body } = await fireCron(baseUrl, cron, fetchImpl);
  if (status !== 200) {
    console.error(`cron:fire: ${name} (${cron}) answered ${String(status)}: ${body}`);
    return 1;
  }
  console.warn(`cron:fire: ${name} (${cron}) completed.`);
  return 0;
}

/* v8 ignore start -- CLI entry point exercised via the cron:fire package script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runFireCron(process.argv.slice(2), process.env, globalThis.fetch));
}
/* v8 ignore stop */

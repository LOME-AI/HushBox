import {
  assertRequiredBindings,
  bindRequestValue,
  createRequestDb,
  createRequestRedis,
} from '../lib/context/index.js';
import { configureIdempotencyBodyHashSecret } from '../lib/idempotency/index.js';
import { createJobWakeCollector, dischargeJobWakes, grantJobWakes } from '../lib/jobs/index.js';
import { configureRateLimitBound, configureRateLimitKeySecret } from '../lib/rate-limit/index.js';
import { createRequestTelemetry } from '../lib/telemetry/index.js';
import { markPipelineHandler, readPipelineVariable } from './pipeline-markers.js';
import type { AppEnv } from '../lib/context/index.js';
import type { ExecutionContext, MiddlewareHandler } from 'hono';

/**
 * Builds the telemetry flush scheduler in a scope of its own, and that is the
 * whole reason this function exists rather than an inline arrow. V8 allocates
 * ONE context object per scope, holding every variable any closure created
 * there captures — so a thunk written beside the stage's teardown would reach
 * the teardown's `c` without ever naming it. The logger is reachable from the
 * request scope, and a `Context` reachable from there closes the retention
 * cycle `apps/api/src/lib/context/request-scope.ts` describes. Here the only
 * variable in reach is `ctx`, which leads to no response.
 *
 * Absence is a supported shape (vitest's `app.request` offers no
 * ExecutionContext), so the thunk is a no-op rather than a throw.
 */
function flushScheduler(ctx: ExecutionContext | undefined): (task: Promise<unknown>) => void {
  return (task) => {
    ctx?.waitUntil(task);
  };
}

/**
 * Pipeline stage: fail-fast binding validation + per-request DI. Every
 * binding the pipeline needs is asserted here in one place; downstream stages
 * and handlers consume the validated `c.var` surface (bindings, db, redis,
 * logger) and never touch raw `c.env`. Construction is per-request via
 * factories — no module-level singletons (serverless mindset).
 */
export function pipelineBindings(): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The envUtils type assumes the env stage ran; verify it, because the
    // session stage trusts this stage the same way and the chain is
    // load-bearing.
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (envUtilities === undefined) {
      throw new Error('pipeline order violated: pipelineBindings requires pipelineEnv first.');
    }
    const bindings = assertRequiredBindings(c.env);
    c.set('bindings', bindings);
    // The isolate's rate-limit bound and identifier key, put in force from the
    // mode's registry values at the top of the first request it serves. They
    // live at module scope rather than on the context because the counter is
    // reached from slice domains that carry no env, and an argument would
    // thread infrastructure configuration through every rate-limited domain
    // signature.
    configureRateLimitBound(c.env);
    configureRateLimitKeySecret(c.env);
    // The idempotency body-hash key, at module scope for the same reason: the
    // hash is computed in route and engine code that carries no env.
    configureIdempotencyBodyHashSecret(c.env);
    // Mint and discharge in one scope: a second grant on the same handle
    // would replace this collector rather than merge into it, so the two
    // halves stay together where nothing can come between them.
    const jobWakes = createJobWakeCollector();
    const db = grantJobWakes(createRequestDb(bindings, envUtilities), jobWakes);
    bindRequestValue(c, 'db', db);
    bindRequestValue(c, 'redis', createRequestRedis(bindings));
    // Post-response work registers here instead of on `executionCtx` directly,
    // so the teardown below can outlive it. Registration is the only way a
    // side-band's pool access is safe; see the `sideBand` contract on Variables.
    const sideBandTasks: Promise<unknown>[] = [];
    const registerSideBand = (task: Promise<unknown>): void => {
      sideBandTasks.push(task);
    };
    c.set('sideBand', registerSideBand);
    // The request's ExecutionContext, read through the guard ONCE and held as
    // a value: `c.executionCtx` throws where the runtime offers none (vitest's
    // `app.request`), and absence is a supported shape, so the read is guarded
    // rather than avoided. The value is passed to {@link flushScheduler}, whose
    // docblock says why the thunk cannot be built here.
    let executionContext: ExecutionContext | undefined;
    try {
      executionContext = c.executionCtx;
      // eslint-disable-next-line catch-swallow/no-silent-catch -- absence is a supported shape; both consumers below branch on it
    } catch {
      executionContext = undefined;
    }
    // Which sinks compose is the TELEMETRY_SINKS registry value (per-mode,
    // fail-fast), never a mode branch here. A flush rides `waitUntil` the
    // moment it is scheduled, so a captured defect outlives the response
    // independently of the teardown.
    bindRequestValue(
      c,
      'logger',
      createRequestTelemetry(c.env, { scheduleFlush: flushScheduler(executionContext) })
    );
    try {
      await next();
    } finally {
      // The per-request Neon pool holds a wsproxy WebSocket until idle GC, so it
      // is closed once the response is done — parity with every DO path
      // (dispatcher-bindings, realtime-room-bindings, scheduled), which all
      // `await db.$client.end()`. Request-path handlers return buffered
      // `c.json(...)` responses and never stream from this pool; chat/SSE
      // streaming runs inside the ConversationRoom DO on its OWN db. What DOES
      // still use this pool after `next()` is post-response side-band work
      // (push notifications, the mock provider's self-delivered webhook), so
      // the close waits on every registered task first — a drain, because a
      // side-band may register another. Failures are absorbed: the pool closes
      // whatever a best-effort side-band did. `waitUntil` keeps the isolate
      // alive for the whole teardown without delaying the response; vitest's
      // `app.request` has no ExecutionContext (its getter throws), so there the
      // teardown is awaited inline. Closed exactly once — a single teardown per
      // request, never double-closed.
      const teardown = async (): Promise<void> => {
        while (sideBandTasks.length > 0) {
          await Promise.allSettled(sideBandTasks.splice(0));
        }
        // After every committing transaction this request opened, before the
        // pool it borrowed is gone. Lossy by design: a wake that fails changes
        // nothing, because the dispatcher's alarm is the delivery guarantee.
        await dischargeJobWakes(c.env, jobWakes);
        await db.$client.end();
      };
      if (executionContext === undefined) {
        await teardown();
      } else {
        executionContext.waitUntil(teardown());
      }
    }
  });
}

import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './no-lossy-counter-gate.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const GATE_PATH = 'apps/api/src/slices/identity/domain/lockout.ts';

describe('no-lossy-counter-gate', () => {
  it('flags a read, compare and incremented write-back of one counter', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, id) {
        const stored = await redisGet(redis, loginAttempts, id);
        const count = (stored?.count ?? 0) + 1;
        if (count > MAX_ATTEMPTS) return refuse();
        await redisSet(redis, loginAttempts, { count, firstAttempt: Date.now() }, id);
        return admit();
      }\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: GATE_PATH });
    expect(violations[0]?.message).toMatch(/consume/);
  });

  it('flags the same shape written against the redis client directly', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const current = Number(await redis.get(key));
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the same shape whose receiver names Redis only earlier in its chain', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(deps, key) {
        const current = Number(await withClient(deps.redis).get(key));
        await withClient(deps.redis).set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter advanced with a postfix increment', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const state = await redisGet(redis, loginAttempts, key);
        state.count++;
        await redisSet(redis, loginAttempts, state, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter advanced with a compound assignment', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const state = await redisGet(redis, loginAttempts, key);
        state.count += 1;
        await redisSet(redis, loginAttempts, state, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a countdown gate that writes back the value it read minus one', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, id) {
        const state = await redisGet(redis, quotaWindow, id);
        const left = state.remaining - 1;
        if (left < 0) return refuse();
        await redisSet(redis, quotaWindow, { remaining: left, since: state.since }, id);
        return admit();
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a countdown advanced with a postfix decrement', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const state = await redisGet(redis, quotaWindow, key);
        state.remaining--;
        await redisSet(redis, quotaWindow, state, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a countdown advanced with a prefix decrement', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const state = await redisGet(redis, quotaWindow, key);
        --state.remaining;
        await redisSet(redis, quotaWindow, state, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a countdown advanced with a compound subtraction', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const state = await redisGet(redis, quotaWindow, key);
        let remaining = state.remaining;
        remaining -= 1;
        await redisSet(redis, quotaWindow, { remaining }, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose increment puts the constant first', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const current = Number(await redis.get(key));
        await redis.set(key, 1 + current);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('looks past calls whose callee is neither a name nor a member access', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key, handlers) {
        const current = Number(await redis.get(key));
        handlers['audit'](key);
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose increment sits one binding away from the read', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, id) {
        const stored = await redisGet(redis, loginAttempts, id);
        const previous = stored?.count ?? 0;
        const count = previous + 1;
        if (count > MAX_ATTEMPTS) return refuse();
        await redisSet(redis, loginAttempts, { count }, id);
        return admit();
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter advanced in place after the read is unpacked', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, id) {
        const stored = await redisGet(redis, loginAttempts, id);
        let attempts = stored?.count ?? 0;
        attempts += 1;
        await redisSet(redis, loginAttempts, { count: attempts }, id);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose read is hoisted onto its own line', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const raw = await redis.get(key);
        const current = Number(raw);
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose read is normalised with a null comparison', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const stored = await redisGet(redis, loginAttempts, key);
        const used = stored === null ? 0 : stored.count;
        if (used >= MAX_ATTEMPTS) return refuse();
        await redisSet(redis, loginAttempts, { count: used + 1 }, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter three bindings away from its read', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const stored = await redisGet(redis, loginAttempts, key);
        const window = stored ?? { count: 0 };
        const previous = window.count;
        const next = previous + 1;
        await redisSet(redis, loginAttempts, { count: next }, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter that reaches its increment through a reassignment', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        let count = 0;
        const stored = await redisGet(redis, loginAttempts, key);
        count = stored.count;
        count += 1;
        await redisSet(redis, loginAttempts, { count }, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose advance lands in a plain assignment', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        let count = 0;
        const stored = await redisGet(redis, loginAttempts, key);
        count = stored.count + 1;
        await redisSet(redis, loginAttempts, { count }, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose advanced value is carried to the write by a binding', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, id) {
        const stored = await redisGet(redis, throttleWindow, id);
        const attempts = (stored?.attempts ?? 0) + 1;
        const state = { attempts, since: stored?.since ?? Date.now() };
        await redisSet(redis, throttleWindow, state, id);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose advanced value reaches the write inside a spread payload', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, id) {
        const stored = await redisGet(redis, throttleWindow, id);
        const next = (stored?.attempts ?? 0) + 1;
        const payload = { ...stored, attempts: next };
        await redisSet(redis, throttleWindow, payload, id);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter renamed once more before the write', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const raw = await redis.get(key);
        const next = Number(raw) + 1;
        const value = next;
        await redis.set(key, value);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter carried to the write two bindings later', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const stored = await redisGet(redis, throttleWindow, key);
        const next = stored.attempts + 1;
        const entry = { attempts: next };
        const record = { ...entry, at: Date.now() };
        await redisSet(redis, throttleWindow, record, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose carrier is filled in by a later assignment', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        let payload = {};
        const stored = await redisGet(redis, throttleWindow, key);
        const next = stored.attempts + 1;
        payload = { attempts: next };
        await redisSet(redis, throttleWindow, payload, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter written back onto the object the read produced', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const stored = await redisGet(redis, throttleWindow, key);
        const next = stored.attempts + 1;
        stored.attempts = next;
        await redisSet(redis, throttleWindow, stored, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a read and an incremented write-back reached by index rather than by field', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const current = Number(await redis['get'](key));
        await redis['set'](key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter kept in a redis hash rather than a string', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const stored = await redis.hgetall(key);
        const attempts = Number(stored.attempts) + 1;
        await redis.hset(key, { attempts, firstAttempt: stored.firstAttempt });
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose read swaps the value in with getset', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const current = Number(await redis.getset(key, '0'));
        await redisSet(redis, throttleWindow, { attempts: current + 1 }, key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter kept in a hash the client names in camel case', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const stored = await redis.hGetAll(key);
        const attempts = Number(stored.attempts) + 1;
        await redis.hSet(key, { attempts, firstAttempt: stored.firstAttempt });
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a counter whose write-back swaps the value with getset', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(redis, key) {
        const current = Number(await redis.get(key));
        await redis.getset(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts an advanced value whose carrier chain stops short of the write', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, key) {
        const stored = await redisGet(redis, statsCache, key);
        const nextPage = stored.page + 1;
        const note = { nextPage };
        await report(note);
        await redisSet(redis, statsCache, stored, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a store command outside the watched read and write families', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, key) {
        const current = Number(await redis.lindex(key, 0));
        await redis.rpush(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a command named by a computed index the rule cannot read', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, key, get, set) {
        const current = Number(await redis[get](key));
        await redis[set](key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a subtraction that reflects the read rather than counting it down', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, key) {
        const stored = await redisGet(redis, statsCache, key);
        const headroom = 100 - stored.used;
        await redisSet(redis, statsCache, { used: stored.used, headroom }, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a read-then-write that folds a variable amount rather than one', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/trial-spend.ts',
      `export async function fold(redis, key, amountNanoUsd) {
        const stored = await redisGet(redis, trialDailySpend, key);
        const total = stored.total + amountNanoUsd;
        await redisSet(redis, trialDailySpend, { total }, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a compound assignment folding a variable amount rather than one', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/trial-spend.ts',
      `export async function fold(redis, key, amountNanoUsd) {
        const stored = await redisGet(redis, trialDailySpend, key);
        let total = stored.total;
        total += amountNanoUsd;
        await redisSet(redis, trialDailySpend, { total }, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a compound subtraction taking away a variable amount rather than one', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/trial-spend.ts',
      `export async function refund(redis, key, cost) {
        const stored = await redisGet(redis, trialDailySpend, key);
        let remaining = stored.remaining;
        remaining -= cost;
        await redisSet(redis, trialDailySpend, { remaining }, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an increment made inside a callback that carries it nowhere', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, key, ids) {
        const stored = await redisGet(redis, statsCache, key);
        ids.forEach(() => {
          report(stored.count + 1);
        });
        await redisSet(redis, statsCache, stored, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an increment written through a target reached by a call', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, key, getState) {
        const stored = await redisGet(redis, statsCache, key);
        getState(stored).count = stored.count + 1;
        await redisSet(redis, statsCache, stored, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an increment of a value that never derives from the read', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, db, key) {
        const cached = await redisGet(redis, statsCache, key);
        if (cached !== null) return cached;
        const page = Number(await readCursor(db));
        await redisSet(redis, statsCache, { page: page + 1 }, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a read-derived increment that never reaches the write', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, db, key) {
        const stored = await redisGet(redis, statsCache, key);
        const nextPage = stored.page + 1;
        await report(nextPage);
        await redisSet(redis, statsCache, stored, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an incremented write to a store that is not redis', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function admit(cache, key) {
        const current = Number(await cache.get(key));
        await cache.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a read and a write with no increment between them', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function refresh(redis, key) {
        const state = await redisGet(redis, membershipCacheKey, key);
        await redisSet(redis, membershipCacheKey, state, key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('reports the innermost function once rather than every enclosing scope', () => {
    const project = projectWith(
      GATE_PATH,
      `export function build(redis) {
        return {
          async admit(key) {
            const current = Number(await redis.get(key));
            await redis.set(key, current + 1);
          },
        };
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a read-through cache that writes a fetched value', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, db) {
        const cached = await redisGet(redis, statsCache, scope);
        if (cached !== null) return cached;
        const fresh = await readSnapshot(db);
        await redisSet(redis, statsCache, fresh, scope);
        return fresh;
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a read-through cache that stamps an expiry on the fetched value', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, db) {
        const cached = await redisGet(redis, statsCache, scope);
        if (cached !== null) return cached.value;
        const fresh = await readSnapshot(db);
        await redisSet(redis, statsCache, { value: fresh, expiresAt: Date.now() + 30_000 }, scope);
        return fresh;
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a read-through cache that builds a label with a compound assignment', () => {
    const project = projectWith(
      'apps/api/src/platform/stats/pipeline.ts',
      `export async function buildStats(redis, db, ids) {
        const cached = await redisGet(redis, statsCache, scope);
        if (cached !== null) return cached;
        let label = 'stats';
        for (const id of ids) label += id;
        const fresh = await readSnapshot(db, label);
        await redisSet(redis, statsCache, fresh, scope);
        return fresh;
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a read-and-compare gate over an amount accumulator that writes nothing', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/trial-spend.ts',
      `export function admitTrialSpend(deps, request) {
        return redisGet(deps.redis, BILLING_KEYS.trialDailySpend, utcDayKey(request.now)).map(
          (stored) => ({ admitted: (stored ?? 0n) < TRIAL_DAILY_SPEND_CAP_NANO_USD })
        );
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a write with no read of the counter', () => {
    const project = projectWith(
      GATE_PATH,
      `export async function seed(redis, key) {
        await redis.set(key, attempts + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the rate-limit primitive itself', () => {
    const project = projectWith(
      'apps/api/src/lib/rate-limit/consume.ts',
      `export async function seedWindow(redis, key) {
        const current = Number(await redis.get(key));
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/identity/domain/lockout.test.ts',
      `async function seedWindow(redis, key) {
        const current = Number(await redis.get(key));
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores spec files', () => {
    const project = projectWith(
      'apps/api/src/slices/identity/domain/lockout.spec.ts',
      `async function seedWindow(redis, key) {
        const current = Number(await redis.get(key));
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'packages/shared/src/notes.ts',
      `async function seedWindow(redis, key) {
        const current = Number(await redis.get(key));
        await redis.set(key, current + 1);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});

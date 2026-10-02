import { unavailableError, validationError } from '../errors/index.js';
import { errAsync, fromPromise, okAsync } from '../result/index.js';
import type { Redis } from '@upstash/redis';
import type { z } from 'zod';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';
import type { RedisKeyDefinition } from './define-key.js';

export function redisGet<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<z.infer<TSchema> | null, DomainError> {
  return fromPromise(redis.get(definition.buildKey(...args)), (cause) =>
    unavailableError('redis get failed', cause)
  ).andThen((stored) => {
    if (stored === null) return okAsync(null);
    const parsed = definition.schema.safeParse(stored);
    return parsed.success
      ? okAsync(parsed.data)
      : errAsync(validationError('redis stored value failed schema validation', parsed.error));
  });
}

/**
 * Atomic single-use read: Redis `GETDEL` returns the value and removes the
 * key in one operation, so two concurrent callers on the same key can never
 * both observe it — exactly one wins the value, the other reads null. This is
 * the primitive a first-delivery claim on ephemeral state (an OPAQUE
 * handshake) is built on; a `GET`-then-`DEL` pair could let both win.
 */
export function redisGetDel<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<z.infer<TSchema> | null, DomainError> {
  return fromPromise(redis.getdel(definition.buildKey(...args)), (cause) =>
    unavailableError('redis getdel failed', cause)
  ).andThen((stored) => {
    if (stored === null) return okAsync(null);
    const parsed = definition.schema.safeParse(stored);
    return parsed.success
      ? okAsync(parsed.data)
      : errAsync(validationError('redis stored value failed schema validation', parsed.error));
  });
}

/**
 * A single key resolved for a multi-get: its built key plus the schema its
 * stored value is parsed through. Constructed with `redisMGetEntry` so the
 * key comes from the typed registry (never a raw string) and the schema is
 * captured alongside it.
 */
interface RedisMGetEntry<TSchema extends z.ZodType> {
  readonly key: string;
  readonly schema: TSchema;
}

/**
 * Resolves a registry key definition and its arguments into a `RedisMGetEntry`,
 * binding the buildKey arguments type-safely and carrying the schema so
 * `redisMGet` can parse the value it fetches.
 */
export function redisMGetEntry<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): RedisMGetEntry<TSchema> {
  return { key: definition.buildKey(...args), schema: definition.schema };
}

type RedisMGetValues<TEntries extends readonly RedisMGetEntry<z.ZodType>[]> = {
  -readonly [K in keyof TEntries]: z.infer<TEntries[K]['schema']> | null;
};

/**
 * Fetches several registry keys in ONE Redis round-trip (`MGET`), parsing each
 * returned value through its own entry's schema and preserving order. A missing
 * key yields `null` (Upstash returns null for absent members); a stored value
 * that fails its schema surfaces a validation error; an unreachable Redis fails
 * closed with an unavailable error — matching `redisGet`'s per-value contract,
 * only collapsed into a single request.
 */
export function redisMGet<const TEntries extends readonly RedisMGetEntry<z.ZodType>[]>(
  redis: Redis,
  entries: TEntries
): ResultAsync<RedisMGetValues<TEntries>, DomainError> {
  const keys = entries.map((entry) => entry.key);
  return fromPromise(redis.mget<unknown[]>(...keys), (cause) =>
    unavailableError('redis mget failed', cause)
  ).andThen((stored) => {
    const values: unknown[] = [];
    for (const [index, entry] of entries.entries()) {
      const raw = stored[index];
      if (raw === null) {
        values.push(null);
        continue;
      }
      const parsed = entry.schema.safeParse(raw);
      if (!parsed.success) {
        return errAsync(
          validationError('redis mget stored value failed schema validation', parsed.error)
        );
      }
      values.push(parsed.data);
    }
    return okAsync(values as RedisMGetValues<TEntries>);
  });
}

export function redisSet<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  value: z.infer<TSchema>,
  ...args: TArgs
): ResultAsync<void, DomainError> {
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return errAsync(validationError('redis value failed schema validation', parsed.error));
  }
  return fromPromise(
    redis.set(definition.buildKey(...args), parsed.data, { ex: definition.ttlSeconds }),
    (cause) => unavailableError('redis set failed', cause)
  ).map((): void => undefined);
}

/**
 * Atomic conditional claim: Redis `SET … NX` writes only when the key is
 * absent and reports whether this caller's write won, so N concurrent
 * claimants on one key resolve to exactly one winner. This is the primitive a
 * first-use marker (a consumed TOTP code) is built on; a `GET`-then-`SET`
 * pair would let every racer through.
 */
export function redisSetNx<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  value: z.infer<TSchema>,
  ...args: TArgs
): ResultAsync<boolean, DomainError> {
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return errAsync(validationError('redis value failed schema validation', parsed.error));
  }
  return fromPromise(
    redis.set(definition.buildKey(...args), parsed.data, { nx: true, ex: definition.ttlSeconds }),
    (cause) => unavailableError('redis setnx failed', cause)
  ).map((reply) => reply === 'OK');
}

/**
 * Remaining lifetime of a key in whole seconds; null when the key is missing
 * or carries no expiry.
 */
export function redisTtl<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<number | null, DomainError> {
  return fromPromise(redis.ttl(definition.buildKey(...args)), (cause) =>
    unavailableError('redis ttl failed', cause)
  ).map((seconds) => (seconds > 0 ? seconds : null));
}

export function redisDel<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<void, DomainError> {
  return fromPromise(redis.del(definition.buildKey(...args)), (cause) =>
    unavailableError('redis del failed', cause)
  ).map((): void => undefined);
}

/**
 * Distinct members of a set. Zero for a set that does not exist, which is the
 * same answer as a set that holds nothing — Redis draws no distinction and
 * neither does a count.
 */
export function redisScard<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<number, DomainError> {
  return fromPromise(redis.scard(definition.buildKey(...args)), (cause) =>
    unavailableError('redis scard failed', cause)
  );
}

/**
 * Every member of a set, each parsed through the entry's schema. Unordered:
 * a set has no order, so a caller that needs one sorts what it gets.
 */
export function redisSmembers<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<readonly z.infer<TSchema>[], DomainError> {
  return fromPromise(redis.smembers<unknown[]>(definition.buildKey(...args)), (cause) =>
    unavailableError('redis smembers failed', cause)
  ).andThen((stored) => {
    const members: z.infer<TSchema>[] = [];
    for (const raw of stored) {
      const parsed = definition.schema.safeParse(raw);
      if (!parsed.success) {
        return errAsync<readonly z.infer<TSchema>[], DomainError>(
          validationError('redis stored set member failed schema validation', parsed.error)
        );
      }
      members.push(parsed.data);
    }
    return okAsync<readonly z.infer<TSchema>[], DomainError>(members);
  });
}

/**
 * Every field of a hash, each value parsed through the entry's schema. An
 * empty record for a hash that does not exist, matching {@link redisScard}'s
 * reading of an absent key as an empty one.
 */
export function redisHGetAll<TSchema extends z.ZodType, TArgs extends readonly unknown[]>(
  redis: Redis,
  definition: RedisKeyDefinition<TSchema, TArgs>,
  ...args: TArgs
): ResultAsync<Readonly<Record<string, z.infer<TSchema>>>, DomainError> {
  return fromPromise(
    redis.hgetall<Record<string, unknown>>(definition.buildKey(...args)),
    (cause) => unavailableError('redis hgetall failed', cause)
  ).andThen((stored) => {
    const fields: Record<string, z.infer<TSchema>> = {};
    for (const [field, raw] of Object.entries(stored ?? {})) {
      const parsed = definition.schema.safeParse(raw);
      if (!parsed.success) {
        return errAsync<Readonly<Record<string, z.infer<TSchema>>>, DomainError>(
          validationError('redis stored hash field failed schema validation', parsed.error)
        );
      }
      fields[field] = parsed.data;
    }
    return okAsync<Readonly<Record<string, z.infer<TSchema>>>, DomainError>(fields);
  });
}

/**
 * Runs one Lua script and parses its reply.
 *
 * Redis executes a script atomically — nothing else runs for its duration —
 * which is what lets a sequence of reads, comparisons and writes observe and
 * leave one consistent state. That is the only reason to reach for this rather
 * than for the single-command helpers above: a check-then-write split across
 * round trips loses updates under concurrency, and the whole point of a
 * ceiling checked before an add is that the two happen together.
 *
 * `keys` carries EVERY key the script touches, built from the registry by the
 * caller. A key the script assembles from its own arguments is invisible to
 * the test harness's per-run key scoping, so it would be written outside the
 * run that wrote it; passing them all is what keeps that impossible.
 *
 * Every failure — an unreachable endpoint, an error reply from the script
 * itself — is one `unavailable`, because a caller decides on whether the
 * script ran and never on how it failed to.
 */
export function redisEval<TReply extends z.ZodType>(
  redis: Redis,
  call: {
    readonly script: string;
    readonly reply: TReply;
    readonly keys: readonly string[];
    readonly args: readonly string[];
  }
): ResultAsync<z.infer<TReply>, DomainError> {
  return fromPromise(
    redis.createScript(call.script).exec([...call.keys], [...call.args]),
    (cause) => unavailableError('redis eval failed', cause)
  ).andThen((raw) => {
    const parsed = call.reply.safeParse(raw);
    return parsed.success
      ? okAsync<z.infer<TReply>, DomainError>(parsed.data)
      : errAsync<z.infer<TReply>, DomainError>(
          validationError('redis script returned an unreadable reply', parsed.error)
        );
  });
}

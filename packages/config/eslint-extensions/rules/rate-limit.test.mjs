// Tests for the vendored rate-limit enforcement rules. Applies the extension
// config inline (no loader, no fixture tree) so the test stays valid regardless
// of loader behavior. Neither rule needs type information, so the bare tseslint
// parser (syntax only) is enough.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../rate-limit.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root, derived from this file's location, so the default scope regex
// (apps/api/src) matches the synthetic file paths below.
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const apiPath = path.join(
  repoRoot,
  'apps',
  'api',
  'src',
  'slices',
  'identity',
  'domain',
  'gate.ts'
);
const sharedPath = path.join(repoRoot, 'packages', 'shared', 'src', 'notes.ts');

function createLinter() {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      ...extensionConfig,
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ],
  });
}

/**
 * @param {string} code
 * @param {string} filePath
 * @param {string} ruleId
 */
async function lintAt(code, filePath, ruleId) {
  const [result] = await createLinter().lintText(code, { filePath });
  if (result === undefined) throw new Error('ESLint returned no lint result');
  return result.messages.filter((message) => message.ruleId === ruleId);
}

const SHAPE_RULE = 'rate-limit/no-window-counter-shape';
const FAILS_CLOSED_RULE = 'rate-limit/fails-closed';

describe('no-window-counter-shape', () => {
  it('flags a Zod schema declaring the retired window shape', async () => {
    const messages = await lintAt(
      `const windowSchema = z.object({ count: z.number(), firstAttempt: z.number() });\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/consume/);
  });

  it('flags an interface declaring the retired window shape', async () => {
    const messages = await lintAt(
      `interface WindowState { readonly count: number; readonly firstAttempt: number }\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a type alias declaring the retired window shape', async () => {
    const messages = await lintAt(
      `type WindowState = { count: number; firstAttempt: number };\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a stored value literal carrying the retired window shape', async () => {
    const messages = await lintAt(
      `await redisSet(redis, key, { count: 1, firstAttempt: now });\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags the retired shape written with quoted keys', async () => {
    const messages = await lintAt(
      `const state = { 'count': 1, 'firstAttempt': now };\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('accepts a spread and a numeric key alongside a lone count', async () => {
    const messages = await lintAt(
      `const state = { ...rest, 1: 'first', count: 1 };\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toEqual([]);
  });

  it('honours an explicit scope option', async () => {
    const [result] = await new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        { files: ['**/*.ts'], rules: { [SHAPE_RULE]: ['error', { scopedFiles: '/packages/' }] } },
      ],
    }).lintText(`const state = { count: 1, firstAttempt: now };\n`, { filePath: sharedPath });

    if (result === undefined) throw new Error('ESLint returned no lint result');

    expect(result.messages.filter((message) => message.ruleId === SHAPE_RULE)).toHaveLength(1);
  });

  it('accepts a decision carrying only a count', async () => {
    const messages = await lintAt(
      `const decision = { allowed: true, count: 3 };\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an unrelated first-attempt field', async () => {
    const messages = await lintAt(
      `const outcome = { count: 2, firstAttemptLegsInserted: 2 };\n`,
      apiPath,
      SHAPE_RULE
    );

    expect(messages).toEqual([]);
  });

  it('ignores files outside the api source tree', async () => {
    const messages = await lintAt(
      `const windowSchema = z.object({ count: z.number(), firstAttempt: z.number() });\n`,
      sharedPath,
      SHAPE_RULE
    );

    expect(messages).toEqual([]);
  });
});

describe('fails-closed', () => {
  it('flags a consume result defaulted with unwrapOr', async () => {
    const messages = await lintAt(
      `const decision = (await consume(redis, definition, id)).unwrapOr({ allowed: true, count: 0 });\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/fail closed/);
  });

  it('flags a consume result recovered with orElse', async () => {
    const messages = await lintAt(
      `const decision = consume(redis, definition, id).orElse(() => okAsync({ allowed: true, count: 0 }));\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a consume result defaulted with unwrapOrElse', async () => {
    const messages = await lintAt(
      `const decision = consume(redis, definition, id).unwrapOrElse(() => admit());\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission produced from a catch', async () => {
    const messages = await lintAt(
      `async function gate(redis) {
        try {
          return await check(redis);
        } catch {
          return { allowed: true, count: 0 };
        }
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a consume reached through a port object', async () => {
    const messages = await lintAt(
      `const decision = deps.limiter.consume(definition, id).unwrapOr(admit());\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a consume result defaulted after intermediate combinators', async () => {
    const messages = await lintAt(
      `const decision = consume(redis, definition, id).map(toVerdict).unwrapOr(admit());\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission returned from an isErr branch on a consume binding', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isErr()) return { allowed: true };
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatch(/fail closed/);
  });

  it('flags a consume binding defaulted through a later combinator', async () => {
    const messages = await lintAt(
      `function gate(redis, definition, id) {
        const decision = consume(redis, definition, id);
        return decision.unwrapOr({ allowed: true });
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a consume error matched into an admission', async () => {
    const messages = await lintAt(
      `const decision = consume(redis, definition, id).match((value) => value, () => ({ allowed: true }));\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a hoisted admission constant returned from a catch', async () => {
    const messages = await lintAt(
      `const ADMIT = { allowed: true, count: 0 };
      async function gate(redis) {
        try {
          return await check(redis);
        } catch {
          return ADMIT;
        }
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission produced from a promise catch handler', async () => {
    const messages = await lintAt(
      `const decision = check(redis).catch(() => ({ allowed: true }));\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission produced from a function-expression catch handler', async () => {
    const messages = await lintAt(
      `const decision = check(redis).catch(function () {
        return { allowed: true };
      });\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('accepts a promise catch that recovers into a non-admission', async () => {
    const messages = await lintAt(
      `const rows = load(db).catch(() => []);\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a match whose error half surfaces the failure', async () => {
    const messages = await lintAt(
      `const response = consume(redis, definition, id).match((value) => value, (error) => unavailable(error));\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an isOk branch that admits on success', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isOk()) return { allowed: decision.value.allowed };
        return unavailable(decision.error);
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a destructured binding alongside a consume gate', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const { redis: client } = deps;
        const decision = await consume(client, definition, id);
        if (decision.isErr()) return unavailable(decision.error);
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('flags an admission made conditional on isErr', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        return { allowed: decision.isErr() ? true : decision.value.allowed };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission from a negated isOk branch on a consume binding', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (!decision.isOk()) return { allowed: true };
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission from an isErr branch on a rate-limit decision parameter', async () => {
    const messages = await lintAt(
      `function respond(c, result: Result<RateLimitDecision, DomainError>) {
        if (result.isErr()) return { allowed: true, count: 0 };
        return result.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a bare true returned from an isErr statement branch', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isErr()) {
          return true;
        }
        return decision.value.allowed;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission short-circuited past a failed decision', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        return decision.isErr() || decision.value.allowed;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission conjoined onto a failed decision', async () => {
    const messages = await lintAt(
      `const ADMIT = { allowed: true, count: 0 };
      async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        return decision.isErr() && ADMIT;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission that falls through an early success return', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isOk()) return decision.value;
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission that falls through a negated early return', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (!decision.isErr()) return decision.value;
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a bare true that falls through an early success return', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isOk()) {
          return decision.value.allowed;
        }
        return true;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a consume error matched into a bare true', async () => {
    const messages = await lintAt(
      `const allowed = consume(redis, definition, id).match((value) => value.allowed, () => true);\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('accepts a fall-through reached on success as well as failure', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isErr()) {
          record(decision.error);
        }
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('flags a bare true short-circuited off a successful decision', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        return decision.isOk() || true;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission that falls through inside a switch case', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, kind) {
        const decision = await consume(redis, definition, id);
        switch (kind) {
          case 'full':
            if (decision.isOk()) return decision.value;
            return { allowed: true };
          default:
            return decision.value;
        }
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission that falls through an else-if guard', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, flag) {
        const decision = await consume(redis, definition, id);
        if (flag) return { allowed: false };
        else if (decision.isOk()) return decision.value;
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags an admission that falls through a two-deep else-if chain', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, flag, other) {
        const decision = await consume(redis, definition, id);
        if (flag) return refuse();
        else if (other) return refuse();
        else if (decision.isOk()) return decision.value;
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('flags a bare true that falls through an else-if guard', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, flag) {
        const decision = await consume(redis, definition, id);
        if (flag) return refuse();
        else if (decision.isOk()) return decision.value.allowed;
        return true;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toHaveLength(1);
  });

  it('accepts an else-if guard whose fall-through refuses', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, flag) {
        const decision = await consume(redis, definition, id);
        if (flag) return refuse();
        else if (decision.isOk()) return decision.value;
        return unavailable(decision.error);
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an else-if guard whose success branch returns nothing', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, flag) {
        const decision = await consume(redis, definition, id);
        if (flag) return refuse();
        else if (decision.isOk()) {
          record(decision.value);
        }
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an admission after a nested if the rule cannot place', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, enabled) {
        const decision = await consume(redis, definition, id);
        if (enabled) if (decision.isOk()) return decision.value;
        return unavailable(decision.error);
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a logical whose left operand asks nothing of a decision', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, ready) {
        const decision = await consume(redis, definition, id);
        const skip = ready || bypass;
        return skip ? { allowed: true } : decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an admission guarded by a negated non-decision test', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, ready) {
        const decision = await consume(redis, definition, id);
        if (!ready) return { allowed: true };
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an admission guarded by a bare predicate call', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (isBypassed()) return { allowed: true };
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an unrelated result matched into an admission-shaped value', async () => {
    const messages = await lintAt(
      `const summary = lookup(db, id).match((value) => value, () => ({ allowed: true }));\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a fall-through past a success branch that returns nothing', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isOk()) {
          record(decision.value);
        }
        return { allowed: true };
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a verdict conjoined onto a successful decision', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        return decision.isOk() && decision.value.allowed;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a bare true returned from an unrelated failure branch', async () => {
    const messages = await lintAt(
      `async function gate(db, id) {
        const lookup = await loadMember(db, id);
        if (lookup.isErr()) {
          return true;
        }
        return lookup.value.active;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a failed decision widening a refusal test', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id, tooMany) {
        const decision = await consume(redis, definition, id);
        if (decision.isErr() || tooMany) return refuse();
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a failed decision short-circuiting into a refusal', async () => {
    const messages = await lintAt(
      `async function gate(redis, definition, id) {
        const decision = await consume(redis, definition, id);
        if (decision.isErr() || !decision.value.allowed) return refuse();
        return decision.value;
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an isErr branch that surfaces the unavailable error', async () => {
    const messages = await lintAt(
      `function respond(c, result: Result<RateLimitDecision, DomainError>) {
        if (result.isErr()) {
          return c.json(createErrorResponse(WIRE[result.error.code]), STATUS[result.error.code]);
        }
        if (result.value.allowed) return null;
        return c.json(createErrorResponse(ERROR_CODES.RATE_LIMITED), 429);
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a hoisted uncounted admission returned outside any error path', async () => {
    const messages = await lintAt(
      `const UNCOUNTED = okAsync({ allowed: true, count: 0 });
      function limit(c, definition) {
        if (c.var.principal.kind === 'full') return UNCOUNTED;
        return consume(c.var.redis, definition, id);
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a catch that recovers into a non-admission', async () => {
    const messages = await lintAt(
      `function canonicalCredential(credential) {
        try {
          const decoded = fromBase64(credential);
          return decoded.length === 0 ? null : toBase64(decoded);
        } catch {
          return null;
        }
      }\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a computed recovery combinator on an unrelated chain', async () => {
    const messages = await lintAt(
      `const value = candidates['unwrapOr'](fallback);\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('honours an explicit scope option', async () => {
    const [result] = await new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
        {
          files: ['**/*.ts'],
          rules: { [FAILS_CLOSED_RULE]: ['error', { scopedFiles: '/packages/' }] },
        },
      ],
    }).lintText(`const decision = consume(redis, definition, id).unwrapOr(admit());\n`, {
      filePath: sharedPath,
    });

    if (result === undefined) throw new Error('ESLint returned no lint result');

    expect(result.messages.filter((message) => message.ruleId === FAILS_CLOSED_RULE)).toHaveLength(
      1
    );
  });

  it('accepts a consume result surfaced as a Result', async () => {
    const messages = await lintAt(
      `const decision = await consume(redis, definition, id);
      if (decision.isErr()) return unavailable(decision.error);\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts an unrelated best-effort result being defaulted', async () => {
    const messages = await lintAt(
      `await evictUserBestEffort(evictUser, userId).unwrapOr(null);\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('accepts a deliberate uncounted admission outside any error path', async () => {
    const messages = await lintAt(
      `const UNCOUNTED = okAsync({ allowed: true, count: 0 });\n`,
      apiPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });

  it('ignores files outside the api source tree', async () => {
    const messages = await lintAt(
      `const decision = consume(redis, definition, id).unwrapOr({ allowed: true, count: 0 });\n`,
      sharedPath,
      FAILS_CLOSED_RULE
    );

    expect(messages).toEqual([]);
  });
});

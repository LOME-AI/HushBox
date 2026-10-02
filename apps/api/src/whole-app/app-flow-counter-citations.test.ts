/**
 * # Every counter a slice flow spends, against the routes that cite it
 *
 * The posture map is this Worker's single answer to "what bounds this route?",
 * and its completeness has always been asserted in the direction that cannot
 * find the gap: from a declaration outward to the counter it names. That
 * direction confirms the rows it already holds and structurally cannot emit a
 * row for a counter no row mentions — which is the defect. This file walks the
 * other way: from every line that spends a counter, to the citation that
 * declares it.
 *
 * ## Reach
 *
 * The subject is every call to the shared primitives `consume` and
 * `consumeLayers`, imported from `lib/rate-limit`, in a non-test module of this
 * Worker outside `lib/rate-limit` itself. Inside that directory the calls are
 * the primitive's own delegation and the edge bound's, and the edge bound
 * spends exactly the layers a route's declaration handed it — cited by
 * construction, with nothing a walk could find.
 *
 * Which modules bind the primitives, and under what names, is read by
 * `test-support/rate-limit-spend-sites.ts`, shared with
 * `app-network-lockout-resolver.test.ts` — the other question asked of these
 * same lines. Neither file may keep a reading of its own: a gate whose subject
 * has narrowed reports nothing rather than reporting something wrong.
 *
 * A counter reached any OTHER way is outside this walk, and it is not
 * unguarded: `docs/CODE-RULES.md` §Security allows one counting implementation,
 * and the arch rule `rate-limit-keys-use-the-primitive` is what refuses a
 * hand-rolled counter — a `ratelimit:` key minted through the generic Redis
 * registry, or a limit definition handed to a generic Redis operation. This
 * walk assumes that rule's subject and asks the question one level up: given
 * that a counter is spent through the primitive, does any route declare it?
 *
 * Reading unreadable input throws rather than skipping it, everywhere below. A
 * spend site whose definition expression this file cannot resolve, an import
 * shape it cannot follow, a layer list it cannot destructure: each is a hole
 * the walk would otherwise report green over, and a check that passes over what
 * it cannot see reads exactly like one that saw nothing wrong.
 *
 * ## What it cannot prove
 *
 * That the CITED counter is this route's. A citation is a reference from
 * `countedInFlow`, memoized per definition object, so entries that ARE the same
 * object bind to one reference — the step-up gates do not each carry a lockout
 * of their own, and the ones that share theirs are indistinguishable here. The
 * assertion therefore reads "this counter is cited by some route", never "this
 * route cites this gate's counter"; the colocated posture tests are where a
 * route's own citation is pinned against the object its domain consumes.
 *
 * That the spend is REACHED. The walk reads a call site, not a call: a spend
 * behind a branch no request takes is cited exactly like one on every path, and
 * nothing here distinguishes them.
 *
 * That the citation is at the RIGHT route. A counter spent in one slice's flow
 * and cited at an unrelated slice's route satisfies this walk.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ROUTE_POSTURES } from '../composition/rate-limit-posture.js';
import { countedInFlow } from '../lib/rate-limit/index.js';
import {
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT,
  CHAT_TRIAL_SEND_IP_RATE_LIMIT,
} from '../slices/chat/domain/rate-limit.js';
import {
  TRIAL_QUOTA_IP_RATE_LIMIT,
  TRIAL_QUOTA_SESSION_RATE_LIMIT,
} from '../slices/chat/domain/trial/quota.js';
import { IDENTITY_KEYS } from '../slices/identity/domain/keys.js';
import { STEP_UP_GATES } from '../slices/identity/domain/session/step-up.js';
import { MEDIA_RATE_LIMITS } from '../slices/media/index.js';
import {
  API_SRC,
  PRIMITIVE_DIR,
  repoRelative,
  spendBindings,
} from '../test-support/rate-limit-spend-sites.js';
import type { CarriedRoutePosture, RateLimitDefinition } from '../lib/rate-limit/index.js';
import type { SpendFunction } from '../test-support/rate-limit-spend-sites.js';

function* sourceFilePaths(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFilePaths(full);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const relative = path.relative(API_SRC, full);
    if (relative === PRIMITIVE_DIR || relative.startsWith(`${PRIMITIVE_DIR}${path.sep}`)) continue;
    yield full;
  }
}

/** One line that spends a counter, and the expression naming the entry it spends. */
interface SpendSite {
  readonly at: string;
  readonly expression: string;
}

/** The definition expression(s) one spend call names, as written. */
function definitionExpressions(
  call: ts.CallExpression,
  primitive: SpendFunction,
  where: string
): readonly string[] {
  const [, subject] = call.arguments;
  if (subject === undefined) {
    throw new Error(`${where}: ${primitive} called without the entry it spends.`);
  }
  if (primitive === 'consume') return [subject.getText(call.getSourceFile())];
  if (!ts.isArrayLiteralExpression(subject)) {
    throw new Error(
      `${where}: consumeLayers takes a layer list this walk cannot read — every layer's ` +
        'entry must be written in the call for the spend to be attributable.'
    );
  }
  return subject.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`${where}: a consumeLayers layer this walk cannot read.`);
    }
    const definition = element.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'definition'
    );
    if (definition === undefined || !ts.isPropertyAssignment(definition)) {
      throw new Error(`${where}: a consumeLayers layer naming no definition.`);
    }
    return definition.initializer.getText(element.getSourceFile());
  });
}

/** Every line in this Worker that spends a counter through the primitives. */
function spendSites(): readonly SpendSite[] {
  const sites: SpendSite[] = [];
  for (const file of sourceFilePaths(API_SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('consume')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const bound = spendBindings(source);
    if (bound.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const primitive = bound.get(node.expression.text);
        if (primitive !== undefined) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const at = `${repoRelative(file)}:${String(line)}`;
          for (const expression of definitionExpressions(node, primitive, at)) {
            sites.push({ at, expression });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  return sites;
}

/**
 * The runtime values a spend expression can be rooted in, keyed by the text
 * that names the root. A root binding several values is a PARAMETERIZED spend
 * site: `startGuardedStepUp` spends whichever gate it is handed, so `args.gate`
 * stands for every gate the registry holds and that one call site contributes
 * one spend per gate. Reading it as a single position would let a gate added to
 * the registry, and cited nowhere, pass behind its siblings.
 *
 * A root this map does not hold is a hard failure rather than a skip: a new
 * spend site is exactly the thing the walk exists to see, and an unresolvable
 * one silently dropped is the hole reappearing.
 */
const SPEND_ROOTS: Readonly<Record<string, readonly unknown[]>> = {
  IDENTITY_KEYS: [IDENTITY_KEYS],
  MEDIA_RATE_LIMITS: [MEDIA_RATE_LIMITS],
  CHAT_STREAM_USER_RATE_LIMIT: [CHAT_STREAM_USER_RATE_LIMIT],
  CHAT_TRIAL_SEND_IP_RATE_LIMIT: [CHAT_TRIAL_SEND_IP_RATE_LIMIT],
  CHAT_TRIAL_REMAINING_IP_RATE_LIMIT: [CHAT_TRIAL_REMAINING_IP_RATE_LIMIT],
  TRIAL_QUOTA_SESSION_RATE_LIMIT: [TRIAL_QUOTA_SESSION_RATE_LIMIT],
  TRIAL_QUOTA_IP_RATE_LIMIT: [TRIAL_QUOTA_IP_RATE_LIMIT],
  'args.gate': Object.values(STEP_UP_GATES),
};

function isDefinition(value: unknown): value is RateLimitDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RateLimitDefinition>;
  return (
    typeof candidate.buildKey === 'function' &&
    typeof candidate.maxAttempts === 'number' &&
    typeof candidate.windowSeconds === 'number'
  );
}

function readPath(
  root: unknown,
  properties: readonly string[],
  where: string
): RateLimitDefinition {
  let value = root;
  for (const property of properties) {
    if (typeof value !== 'object' || value === null || !(property in value)) {
      throw new Error(`${where}: '${property}' is not readable on the value it is read from.`);
    }
    value = (value as Record<string, unknown>)[property];
  }
  if (!isDefinition(value)) throw new Error(`${where}: does not resolve to a rate-limit entry.`);
  return value;
}

/**
 * Every entry one spend expression can name. The root is the LONGEST dotted
 * prefix {@link SPEND_ROOTS} holds, so a property path reaching through a
 * parameter (`args.gate.lockout`) and one reaching through a registry
 * (`IDENTITY_KEYS.loginLockout`) resolve through the same rule.
 */
function resolveSpend(expression: string): readonly RateLimitDefinition[] {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression)) {
    throw new Error(
      `rate-limit spend '${expression}' is not a property path this walk can resolve — ` +
        'an entry named by anything but a dotted reference cannot be attributed to a route.'
    );
  }
  const parts = expression.split('.');
  for (let take = parts.length; take > 0; take -= 1) {
    const roots = SPEND_ROOTS[parts.slice(0, take).join('.')];
    if (roots === undefined) continue;
    const rest = parts.slice(take);
    return roots.map((root) => readPath(root, rest, `rate-limit spend '${expression}'`));
  }
  throw new Error(
    `rate-limit spend '${expression}' is rooted in nothing this walk holds — add the root to ` +
      'SPEND_ROOTS so the entry it names can be checked against the routes that cite it.'
  );
}

/** One spend: the line, the expression, and the entry it resolves to. */
interface Spend {
  readonly at: string;
  readonly expression: string;
  readonly definition: RateLimitDefinition;
}

const SPENDS: readonly Spend[] = spendSites().flatMap((site) =>
  resolveSpend(site.expression).map((definition) => ({ ...site, definition }))
);

/**
 * The spends no route declares, named by where they happen. Pure over both
 * halves so the control below can hand it a subject the tree does not contain.
 */
function uncitedSpends(
  spends: readonly Spend[],
  postures: Readonly<Record<string, CarriedRoutePosture>>
): readonly string[] {
  const cited = new Set<unknown>();
  for (const posture of Object.values(postures)) {
    if (posture.kind !== 'named') continue;
    for (const reference of posture.countedInFlow) cited.add(reference);
  }
  return spends
    .filter((spend) => !cited.has(countedInFlow(spend.definition)))
    .map((spend) => `${spend.at} spends ${spend.expression}`);
}

describe('counters spent in a slice flow', () => {
  it('are each cited by a route in the assembled posture map', () => {
    expect(uncitedSpends(SPENDS, ROUTE_POSTURES)).toEqual([]);
  });

  it('are found by walking the spend sites, so the walk has a subject', () => {
    expect(SPENDS.length).toBeGreaterThan(0);
  });

  it('include every gate a parameterized spend site can be handed', () => {
    const gateSpends = SPENDS.filter((spend) => spend.expression === 'args.gate.lockout');
    expect(gateSpends).toHaveLength(Object.keys(STEP_UP_GATES).length);
    expect(new Set(gateSpends.map((spend) => spend.definition))).toEqual(
      new Set([IDENTITY_KEYS.stepUpLockout, IDENTITY_KEYS.deleteAccountInitLockout])
    );
  });
});

describe('the walk', () => {
  it('reports a counter no route cites', () => {
    const uncited: RateLimitDefinition = {
      kind: 'throttle',
      maxAttempts: 1,
      windowSeconds: 60,
      buildKey: (id: string) => `ratelimit:uncited:${id}`,
    };
    expect(
      uncitedSpends(
        [...SPENDS, { at: 'slice/domain/flow.ts:1', expression: 'UNCITED', definition: uncited }],
        ROUTE_POSTURES
      )
    ).toEqual(['slice/domain/flow.ts:1 spends UNCITED']);
  });

  it('reports a real spend whose route withdraws the citation', () => {
    const withdrawn = countedInFlow(IDENTITY_KEYS.loginLockout);
    const postures: Readonly<Record<string, CarriedRoutePosture>> = Object.fromEntries(
      Object.entries(ROUTE_POSTURES).map(([key, posture]) => [
        key,
        posture.kind === 'named'
          ? {
              ...posture,
              countedInFlow: posture.countedInFlow.filter((reference) => reference !== withdrawn),
            }
          : posture,
      ])
    );
    const reported = uncitedSpends(SPENDS, postures);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(
      /^apps\/api\/src\/slices\/identity\/domain\/opaque\/login\.ts:\d+ spends IDENTITY_KEYS\.loginLockout$/
    );
  });

  it('refuses a spend expression it cannot root in a known entry', () => {
    expect(() => resolveSpend('SOME_UNDECLARED_LIMIT')).toThrow(
      /rooted in nothing this walk holds/
    );
  });

  it('refuses a spend expression that is not a property path', () => {
    expect(() => resolveSpend('limitFor(route)')).toThrow(/not a property path/);
  });
});

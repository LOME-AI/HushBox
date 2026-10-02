import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import rule, {
  BINDING_FACTORY,
  CAPABILITY_MODULE,
} from './posture-fragments-satisfy-a-fresh-literal.rule.js';

/**
 * Every fixture project carries the factory's declaring module, because the rule
 * asserts its own subject before it reports anything. A fixture that models one
 * corner of the slice tree still has to hold the symbol clause 3 is written against —
 * the exception is the two fixtures that withhold it deliberately, which supply their
 * own project.
 */
const CAPABILITY_STUB = `export function ${BINDING_FACTORY}(): void {}\n`;

function projectWithFiles(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  if (!Object.hasOwn(files, CAPABILITY_MODULE)) {
    project.createSourceFile(CAPABILITY_MODULE, CAPABILITY_STUB);
  }
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

function projectWith(filePath: string, source: string): Project {
  return projectWithFiles({ [filePath]: source });
}

const FRAGMENT = 'apps/api/src/slices/identity/rate-limit-posture.ts';
const OTHER_FRAGMENT = 'apps/api/src/slices/billing/rate-limit-posture.ts';

const IMPORTS = [
  "import { bindRoutePosture } from '../../lib/rate-limit/index.js';",
  "import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';",
  "import type { createIdentityManifest } from './routes.js';",
  '',
].join('\n');

const TARGET = 'Record<SliceRouteKey<typeof createIdentityManifest>, CarriedRoutePosture>';

const ENTRIES = [
  "  '$post /auth/login/init': bindRoutePosture([{ identity: 'ip', countedAt: 'edge' }]),",
  "  '$get /auth/session': { kind: 'default' },",
].join('\n');

describe('posture-fragments-satisfy-a-fresh-literal', () => {
  describe('the accepted shape', () => {
    it('passes a fragment whose satisfies applies to the literal with as const', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes a fragment whose satisfies applies to a bare literal without as const', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} satisfies ${TARGET};\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes a fragment whose literal is parenthesized before satisfies', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = ({\n${ENTRIES}\n} as const) satisfies ${TARGET};\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes a fragment reaching the key union through a same-file type alias', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type IdentityRouteKey = SliceRouteKey<typeof createIdentityManifest>;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<IdentityRouteKey, CarriedRoutePosture>;\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes an inline type-only specifier beside a well-formed fragment', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type IdentityRouteKey = SliceRouteKey<typeof createIdentityManifest>;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<IdentityRouteKey, CarriedRoutePosture>;\n` +
          'export { type IdentityRouteKey };\n'
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes a locally declared fragment exported through an export clause', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n` +
          'export { IDENTITY_ROUTE_POSTURES };\n'
      );
      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('freshness lost — the shapes that carry a satisfies clause and check nothing', () => {
    // Each negative binding below carries `as const`. Without it the intermediate
    // binding widens to `string` and TS1360 fires for an unrelated reason, which would
    // make the fixture appear to prove the opposite of what the spike measured.
    it('flags a named const bound before satisfies', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}const draft = {\n${ENTRIES}\n} as const;\n` +
          `export const IDENTITY_ROUTE_POSTURES = draft satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: FRAGMENT });
      expect(violations[0]?.message).toContain('IDENTITY_ROUTE_POSTURES');
      expect(violations[0]?.message).toContain('binding');
    });

    it('flags a spread of a prior binding', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}const draft = {\n${ENTRIES}\n} as const;\n` +
          `export const IDENTITY_ROUTE_POSTURES = { ...draft } satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('spread');
    });

    it('flags a spread mixed with literal entries', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}const draft = {\n${ENTRIES}\n} as const;\n` +
          `export const IDENTITY_ROUTE_POSTURES = { ...draft,\n${ENTRIES}\n} as const satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('spread');
    });

    it('flags a helper function return satisfying the target', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}function build() {\n  return {\n${ENTRIES}\n  } as const;\n}\n` +
          `export const IDENTITY_ROUTE_POSTURES = build() satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('call');
    });

    it('flags a non-const type assertion between the literal and satisfies', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type Loose = Record<string, CarriedRoutePosture>;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as Loose satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('assertion');
    });
  });

  describe('no satisfies clause at all', () => {
    it('flags a fragment declared with as const and no satisfies', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('satisfies');
    });

    it('flags a fragment declared with a type annotation instead of satisfies', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES: ${TARGET} = {\n${ENTRIES}\n};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('satisfies');
    });

    it('flags a fragment module that exports no value declaration at all', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type IdentityRouteKey = SliceRouteKey<typeof createIdentityManifest>;\n` +
          'export type { IdentityRouteKey };\n'
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('no posture fragment');
    });
  });

  describe('the empty fragment', () => {
    // An empty literal that COMPILES proves the derived key union is empty too (a
    // non-empty union would fail the missing-key half), so a zero-property literal is
    // the syntactic face of a fragment that satisfies its target vacuously.
    it('flags a fragment whose literal declares no route at all', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {} as const satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('no route');
    });
  });

  describe('the satisfies target must be the slice own route-key record', () => {
    it('flags a widened target that names no slice route key', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<string, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('SliceRouteKey');
    });

    it('flags a target naming a type whose name merely starts with the key union', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type SliceRouteKeyish = string;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<SliceRouteKeyish, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('SliceRouteKey');
    });

    // The two shapes below NAME the key union and still lose the stale-key check:
    // both were compiled against the real manifest with every real key plus one stale
    // key and produced no diagnostic at all. A target that merely mentions the union
    // clears a textual check while admitting every key the union does not name.
    it('flags a key position widened by a union member beside the key union', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<SliceRouteKey<typeof createIdentityManifest> | string, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('SliceRouteKey');
    });

    it('flags a target intersected with a widening record', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET} & Record<string, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('SliceRouteKey');
    });

    it('flags a same-file alias that itself names no slice route key', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type AnyKey = string;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<AnyKey, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('SliceRouteKey');
    });
  });

  // The target clause resolves structure rather than text, so each shape below is
  // stated as a PAIR: the accepted spelling and the same spelling with the key
  // position widened. An accept row alone would pass against a rule that resolved
  // nothing; its twin is what makes it a discrimination.
  describe('the target may be spelled through parentheses or a same-file alias', () => {
    it('passes a parenthesized target', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies (${TARGET});\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('flags a parenthesized target whose key position is widened', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies (Record<string, CarriedRoutePosture>);\n`
      );
      expect(rule.check(project)).toHaveLength(1);
    });

    it('passes a whole target reached through a same-file alias', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type IdentityPostures = ${TARGET};\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies IdentityPostures;\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('flags a whole target alias whose key position is widened', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type IdentityPostures = Record<string, CarriedRoutePosture>;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies IdentityPostures;\n`
      );
      expect(rule.check(project)).toHaveLength(1);
    });
  });

  describe('targets the clause cannot resolve to the key union', () => {
    it('flags a key position naming a type this module does not declare', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<ImportedKey, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ImportedKey');
    });

    it('flags a whole target naming a type this module does not declare', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ImportedPostures;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ImportedPostures');
    });

    it('flags a target that is an inline type literal rather than a keyed record', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies { '$get /auth/session': CarriedRoutePosture };\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Record');
    });

    it('flags a record carrying no value type beside the key union', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<SliceRouteKey<typeof createIdentityManifest>>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Record');
    });

    // An alias cycle is a type error, not a syntax one, so it reaches the rule intact.
    // Resolution must terminate on it: a rule that recurs forever takes the whole
    // architecture check down rather than reporting anything.
    it('flags a key position whose aliases cycle', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type First = Second;\ntype Second = First;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies Record<First, CarriedRoutePosture>;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('SliceRouteKey');
    });

    it('flags a whole target whose aliases cycle', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}type First = Second;\ntype Second = First;\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies First;\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Record');
    });
  });

  describe('shapes that reach satisfies through something else again', () => {
    it('flags a property access standing in for the literal', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}const registry = { postures: {\n${ENTRIES}\n} } as const;\n` +
          `export const IDENTITY_ROUTE_POSTURES = registry.postures satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('binding');
    });

    it('flags an initializer that is not an object at all', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = [] satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ArrayLiteralExpression');
    });

    it('flags an exported const with no initializer', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export declare const IDENTITY_ROUTE_POSTURES: ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('not a posture-fragment declaration');
    });

    it('flags a default-exported fragment expression', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export default {\n${ENTRIES}\n} as const satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('not a posture-fragment declaration');
    });

    it('flags an anonymous default-exported class', () => {
      const project = projectWith(FRAGMENT, `${IMPORTS}export default class {}\n`);
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('`default`');
    });
  });

  describe('every exported value in a fragment module is a fragment declaration', () => {
    it('flags an exported builder sitting beside a well-formed fragment', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export function buildPostures() {\n  return {\n${ENTRIES}\n  } as const;\n}\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n`
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('buildPostures');
    });

    it('flags a helper reached through an export clause, counted once', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}function buildPostures() {\n  return {\n${ENTRIES}\n  } as const;\n}\n` +
          `export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n` +
          'export { buildPostures };\n'
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('buildPostures');
    });

    it('reports every offending declaration, not only the first', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}const draft = {\n${ENTRIES}\n} as const;\n` +
          `export const FIRST = draft satisfies ${TARGET};\n` +
          `export const SECOND = { ...draft } satisfies ${TARGET};\n`
      );
      expect(rule.check(project)).toHaveLength(2);
    });

    it('reports each slice fragment independently', () => {
      const project = projectWithFiles({
        [FRAGMENT]: `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n`,
        [OTHER_FRAGMENT]: `${IMPORTS}const draft = {\n${ENTRIES}\n} as const;\nexport const BILLING_ROUTE_POSTURES = draft satisfies ${TARGET};\n`,
      });
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: OTHER_FRAGMENT });
    });
  });

  describe('scope', () => {
    // Every fixture here is the BYTE-IDENTICAL laundered source that fires at the
    // fragment path, moved to another path. The pair is the discrimination proof: if
    // the matcher were inert these would still pass, so each one is stated against
    // its firing twin rather than on its own.
    // Deliberately carries no `bindRoutePosture`: clause 3 fires on ANY slice-tree
    // module naming the factory, so a source that named it could never be silent at
    // a second slice path and the pair would prove nothing about clause 1's matcher.
    const LAUNDERED =
      "import type { CarriedRoutePosture, SliceRouteKey } from '../../lib/rate-limit/index.js';\n" +
      "import type { createIdentityManifest } from './routes.js';\n" +
      `const draft = {\n  '$get /auth/session': { kind: 'default' },\n} as const;\n` +
      `export const IDENTITY_ROUTE_POSTURES = draft satisfies ${TARGET};\n`;

    it('flags the laundered source at the fragment path (the twin the rows below are stated against)', () => {
      expect(rule.check(projectWith(FRAGMENT, LAUNDERED))).toHaveLength(1);
    });

    it('passes the same source in a slice domain module', () => {
      expect(
        rule.check(projectWith('apps/api/src/slices/identity/domain/keys.ts', LAUNDERED))
      ).toEqual([]);
    });

    it('passes the same source in the composition root posture map', () => {
      expect(
        rule.check(projectWith('apps/api/src/composition/rate-limit-posture.ts', LAUNDERED))
      ).toEqual([]);
    });

    it('passes the same source in a fragment colocated test file', () => {
      expect(
        rule.check(
          projectWith('apps/api/src/slices/identity/rate-limit-posture.test.ts', LAUNDERED)
        )
      ).toEqual([]);
    });

    it('attributes exactly one violation when every path holds the same source', () => {
      const violations = rule.check(
        projectWithFiles({
          [FRAGMENT]: LAUNDERED,
          'apps/api/src/slices/identity/domain/keys.ts': LAUNDERED,
          'apps/api/src/composition/rate-limit-posture.ts': LAUNDERED,
          'apps/api/src/slices/identity/rate-limit-posture.test.ts': LAUNDERED,
          'apps/api/src/lib/rate-limit/posture.ts': LAUNDERED,
        })
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: FRAGMENT });
    });

    it('reports nothing when the scanned tree holds no fragment', () => {
      const project = projectWith(
        'apps/api/src/slices/identity/routes.ts',
        'export const routes = 1;\n'
      );
      expect(rule.check(project)).toEqual([]);
    });
  });

  // Clause 3 keys on a symbol NAME, so it is the one clause whose decay is silent: a
  // renamed or moved factory leaves it matching nothing, reporting nothing, and the
  // fragment path evadable again. Both halves are asserted, because a module that
  // still exists proves nothing about the name it exports.
  describe('the rule pins its own subject', () => {
    const FRESH = `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n`;

    it('throws when the declaring module names no file in the scanned tree', () => {
      const project = new Project({ useInMemoryFileSystem: true });
      project.createSourceFile(FRAGMENT, FRESH);
      expect(() => rule.check(project)).toThrow(CAPABILITY_MODULE);
    });

    it('throws when the declaring module no longer exports the factory', () => {
      const project = projectWithFiles({
        [CAPABILITY_MODULE]: 'export function bindPosture(): void {}\n',
        [FRAGMENT]: FRESH,
      });
      expect(() => rule.check(project)).toThrow(BINDING_FACTORY);
    });
  });

  describe('a fragment cannot escape the path the freshness clause watches', () => {
    it('flags a slice module outside the fragment path that binds a route posture', () => {
      const project = projectWith(
        'apps/api/src/slices/identity/domain/rate-limit.ts',
        "import { bindRoutePosture } from '../../../lib/rate-limit/index.js';\n" +
          "export const P = bindRoutePosture([{ identity: 'ip', countedAt: 'edge' }]);\n"
      );
      const violations = rule.check(project);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('rate-limit-posture.ts');
    });

    it('flags an aliased import of the binding factory outside the fragment path', () => {
      const project = projectWith(
        'apps/api/src/slices/identity/routes.ts',
        "import { bindRoutePosture as bind } from '../../lib/rate-limit/index.js';\n" +
          "export const P = bind([{ identity: 'ip', countedAt: 'edge' }]);\n"
      );
      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a namespace-qualified use of the binding factory outside the fragment path', () => {
      const project = projectWith(
        'apps/api/src/slices/identity/routes.ts',
        "import * as rl from '../../lib/rate-limit/index.js';\n" +
          "export const P = rl.bindRoutePosture([{ identity: 'ip', countedAt: 'edge' }]);\n"
      );
      expect(rule.check(project)).toHaveLength(1);
    });

    it('passes the binding factory used inside the fragment itself', () => {
      const project = projectWith(
        FRAGMENT,
        `${IMPORTS}export const IDENTITY_ROUTE_POSTURES = {\n${ENTRIES}\n} as const satisfies ${TARGET};\n`
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes the binding factory own declaration in lib', () => {
      const project = projectWith(
        'apps/api/src/lib/rate-limit/capability.ts',
        'export function bindRoutePosture(): void {}\n'
      );
      expect(rule.check(project)).toEqual([]);
    });

    it('passes a slice test file exercising the binding factory', () => {
      const project = projectWith(
        'apps/api/src/slices/identity/domain/rate-limit.test.ts',
        "import { bindRoutePosture } from '../../../lib/rate-limit/index.js';\n" +
          'export const P = bindRoutePosture([]);\n'
      );
      expect(rule.check(project)).toEqual([]);
    });
  });
});

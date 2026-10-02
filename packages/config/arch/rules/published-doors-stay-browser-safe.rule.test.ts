import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, { NODE_ONLY_DOORS } from './published-doors-stay-browser-safe.rule.js';

/**
 * The rule reads the guarded package's manifest off the project's file system
 * and every module out of the parsed source files, so a fixture writes both:
 * the exports map as text, every module as a real source file, all under
 * {@link REPO_ROOT}.
 *
 * Every fixture carries the registry module and each declared node-only door,
 * seeded from {@link NODE_ONLY_DOORS} rather than from a copy of it — the rule
 * asserts over that list, so a fixture holding its own copy would go on passing
 * after the list moved.
 */

const PACKAGE_DIR = 'packages/shared';
const MANIFEST_PATH = `${PACKAGE_DIR}/package.json`;
const REGISTRY = `${PACKAGE_DIR}/src/env.config.ts`;
const REGISTRY_SOURCE = "export const envConfig = { DATABASE_URL: { to: ['backend'] } };\n";
const REGISTRY_DOOR = './env.config';

/** The module each declared node-only door is served by, in fixture layout. */
function targetFor(subpath: string): string {
  return `./src${subpath.slice(1)}.ts`;
}

const NODE_ONLY_EXPORTS = Object.fromEntries(
  NODE_ONLY_DOORS.map((subpath) => [subpath, targetFor(subpath)])
);

/** A declared node-only door other than the registry's own, for the exemption fixtures. */
const GUARD_DOOR = NODE_ONLY_DOORS.find((subpath) => subpath !== REGISTRY_DOOR) ?? REGISTRY_DOOR;

/**
 * A module reaching the registry through a callee that only BECOMES the require
 * function once evaluated. The shared walk reports the escape rather than the
 * module, so the reach is an edge this walk cannot follow — which is a refusal
 * here, never an absence.
 */
const UNREAD_REACH = "const load = require;\nexport const registry = load('./env.config.js');\n";

/** The same reach spelled as a member read, the other route a require escapes by. */
const MEMBER_REACH = "export const registry = module.require('./env.config.js');\n";

/** The same reach with the require destructured out from under its own name. */
const DESTRUCTURED_REACH =
  "const { require: load } = module;\nexport const registry = load('./env.config.js');\n";

/**
 * The same reach with the require taken off another module by an import clause,
 * which is that module's namespace destructured: {@link MEMBER_REACH} one
 * module over.
 */
const IMPORTED_REACH =
  "import { require as load } from 'some-pkg';\n" +
  "export const registry = load('./env.config.js');\n";

/**
 * The reach neither escape spells on its own: a require handed on under an
 * object shorthand, taken back out by a destructure, and called through the
 * name that leaves it with. The walk read neither half, so this composition
 * linked the module while the door read as reaching nothing.
 *
 * It pins the composition rather than either half: each half stops the walk on
 * its own now, so disabling one alone leaves this fixture refusing.
 */
const HANDED_ON_REACH =
  'const bag = { require };\nconst { require: load } = bag;\n' +
  "export const registry = load('./env.config.js');\n";

/**
 * The same reach minted rather than inherited: `createRequire` hands back a
 * require function, so binding its result is {@link UNREAD_REACH} one step
 * earlier. The control the three spellings below are each one word away from.
 */
const MINTED_REACH =
  'const load = createRequire(import.meta.url);\n' +
  "export const registry = load('./env.config.js');\n";

/** The same mint renamed as it is imported, so the word it is called by is not its own. */
const MINTED_IMPORTED_REACH =
  "import { createRequire as mk } from 'node:module';\n" +
  'const load = mk(import.meta.url);\n' +
  "export const registry = load('./env.config.js');\n";

/** The same mint rebound to a local, which is {@link UNREAD_REACH} aimed at the minter. */
const MINTED_BOUND_REACH =
  'const mk = createRequire;\n' +
  'const load = mk(import.meta.url);\n' +
  "export const registry = load('./env.config.js');\n";

/** The same mint taken off a namespace, which is {@link MEMBER_REACH} aimed at the minter. */
const MINTED_MEMBER_REACH =
  'const load = nodeModule.createRequire(import.meta.url);\n' +
  "export const registry = load('./env.config.js');\n";

/** A guard door reaching nothing at all: the reading on which the exemption is dead. */
const NO_REACH = 'export const detect = 1;\n';

function manifestWith(exports: Record<string, string>): string {
  return JSON.stringify(
    { name: '@hushbox/shared', exports: { ...NODE_ONLY_EXPORTS, ...exports } },
    null,
    2
  );
}

function projectWith(manifest: string, files: Record<string, string> = {}): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.getFileSystem().writeFileSync(path.join(REPO_ROOT, MANIFEST_PATH), manifest);
  project.createSourceFile(path.join(REPO_ROOT, REGISTRY), REGISTRY_SOURCE);
  for (const subpath of NODE_ONLY_DOORS.filter((door) => door !== REGISTRY_DOOR)) {
    project.createSourceFile(
      path.join(REPO_ROOT, PACKAGE_DIR, targetFor(subpath)),
      "export { envConfig } from './env.config.js';\n"
    );
  }
  for (const [relative, contents] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), contents, { overwrite: true });
  }
  return project;
}

/**
 * The refusal a declared node-only door's module draws, whichever of the two
 * refusals it earns: an absence of any edge into the registry, or an edge the
 * walk cannot follow. Telling those two apart is what several cases below turn
 * on, so the helper reports the message and leaves the reading to the case.
 */
function refusalFor(guardDoorSource: string): string {
  const project = projectWith(manifestWith({}), {
    [path.join(PACKAGE_DIR, targetFor(GUARD_DOOR))]: guardDoorSource,
  });
  try {
    rule.check(project);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the rule returned rather than refusing, so there is no account to read');
}

describe('a published door whose closure reaches the server-only module', () => {
  it('flags the door, pointing at the edge that pulls the registry in', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export * from './api.js';\n",
        [`${PACKAGE_DIR}/src/api.ts`]:
          "import { schema } from './schema.js';\nimport { envConfig } from './env.config.js';\nexport const api = { schema, envConfig };\n",
        [`${PACKAGE_DIR}/src/schema.ts`]: 'export const schema = 1;\n',
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(`${PACKAGE_DIR}/src/api.ts`);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.message).toContain("'.'");
    expect(violations[0]?.message).toContain(REGISTRY);
  });

  it('prints the chain from the door to the registry, so the edge to cut is visible', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export * from './api.js';\n",
        [`${PACKAGE_DIR}/src/api.ts`]: "export { envConfig } from './env.config.js';\n",
      })
    );

    expect(violations[0]?.message).toContain(
      `${PACKAGE_DIR}/src/index.ts -> ${PACKAGE_DIR}/src/api.ts -> ${REGISTRY}`
    );
  });

  it('names the sanctioned subpath, derived from the exports map rather than spelled out', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export { envConfig } from './env.config.js';\n",
      })
    );

    expect(violations[0]?.message).toContain("'@hushbox/shared/env.config'");
  });

  it('reports one violation per affected door rather than one for the package', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts', './routes': './src/routes.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export { envConfig } from './env.config.js';\n",
        [`${PACKAGE_DIR}/src/routes.ts`]: "export { envConfig } from './env.config.js';\n",
      })
    );

    expect(violations).toHaveLength(2);
  });
});

describe('the entry set', () => {
  it('holds a leaf door the barrel never reaches', () => {
    const violations = rule.check(
      projectWith(
        manifestWith({ '.': './src/index.ts', './script-safe-json': './src/script-safe-json.ts' }),
        {
          [`${PACKAGE_DIR}/src/index.ts`]: 'export const version = 1;\n',
          [`${PACKAGE_DIR}/src/script-safe-json.ts`]:
            "import { envConfig } from './env.config.js';\nexport const modes = Object.keys(envConfig);\n",
        }
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'./script-safe-json'");
  });

  it('passes a package whose doors all stay clear of the registry', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts', './routes': './src/routes.ts' }), {
        // A diamond: `schema` is reached from both sides and walked once.
        [`${PACKAGE_DIR}/src/index.ts`]:
          "export * from './routes.js';\nexport * from './schema.js';\n",
        [`${PACKAGE_DIR}/src/routes.ts`]:
          "import './schema.js';\nexport const routes = ['/chat'];\n",
        [`${PACKAGE_DIR}/src/schema.ts`]: 'export const schema = 1;\n',
      })
    );

    expect(violations).toEqual([]);
  });
});

describe('a door declared node-only', () => {
  it('reaches the registry without being flagged, which is what the declaration buys', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: 'export const version = 1;\n',
      })
    );

    expect(violations).toEqual([]);
  });

  it('throws when the exports map no longer publishes it', () => {
    const manifest = JSON.stringify({
      name: '@hushbox/shared',
      exports: Object.fromEntries(
        Object.entries(NODE_ONLY_EXPORTS).filter(([subpath]) => subpath !== REGISTRY_DOOR)
      ),
    });

    expect(() => rule.check(projectWith(manifest))).toThrow(REGISTRY_DOOR);
  });

  it('throws once its door stops reaching the registry, so a dead exemption cannot stand', () => {
    const project = projectWith(manifestWith({}), {
      [path.join(PACKAGE_DIR, targetFor(GUARD_DOOR))]: NO_REACH,
    });

    expect(() => rule.check(project)).toThrow(GUARD_DOOR);
  });

  it('stops at an escaped require in its own module rather than reading the door as unreached', () => {
    const project = projectWith(manifestWith({}), {
      [path.join(PACKAGE_DIR, targetFor(GUARD_DOOR))]: UNREAD_REACH,
    });

    expect(() => rule.check(project)).toThrow('the require function escapes into a value');
  });
});

/**
 * That refusal is the only place the repository states what a reader has to act
 * on here: what state produces this absence, what to do about it, why no reach
 * the walk reads can end in it, and how far that reading goes. The comments
 * that used to restate those facts point at it now, so nothing else in the tree
 * would notice them being reworded away.
 *
 * The last of those is the one a message can get wrong in the reader's favour:
 * the disposition it hands out is DROP, so a sentence claiming more closure than
 * the walk has buys a silent unguarding. Its clauses are pinned like the rest,
 * and the pin is on the DERIVATION rather than on the shapes the sentence
 * illustrates it with — a pin that holds only the examples would go on passing
 * while the sentence around them shrank back to naming a class it does not have.
 *
 * Each is pinned by the shortest phrase carrying its claim — enough that cutting
 * the clause reds, little enough that the prose around it stays free to change.
 * The framing sentence, the connectives, and the subpath and registry path the
 * cases above already assert are deliberately left unpinned.
 */
describe('the account a node-only door with no read edge gets', () => {
  it('names the one state that produces the absence', () => {
    expect(refusalFor(NO_REACH)).toContain('the exemption is dead');
  });

  it('states what leaving a dead entry standing costs, which is why it is not harmless', () => {
    expect(refusalFor(NO_REACH)).toContain('would silently cover the next edge in');
  });

  it('tells its reader what to do, rather than leaving the disposition to be worked out', () => {
    expect(refusalFor(NO_REACH)).toContain('drop the entry');
  });

  it('states why no reach this walk reads can end in the absence', () => {
    const account = refusalFor(NO_REACH);

    expect(account).toContain('through a form this walk cannot follow');
    expect(account).toContain('stops the walk with its own refusal');
    expect(account).toContain('no reach this walk reads ends in this absence');
  });

  it('states how far that reading goes by derivation rather than by example', () => {
    const account = refusalFor(NO_REACH);

    expect(account).toContain('a fixed set of words standing in a fixed set of positions');
    expect(account).toContain('everything outside that pairing');
  });

  it('says the shapes it names are instances, so a reader does not read them as the list', () => {
    const account = refusalFor(NO_REACH);

    expect(account).toContain('a key computed at runtime');
    expect(account).toContain('a reflective property read');
    expect(account).toContain('instances, not the class');
  });

  it('tells the reader what to search for, which is any route at all rather than a shape', () => {
    const account = refusalFor(NO_REACH);

    expect(account).toContain('any route to a module loader at all');
    expect(account).toContain('before dropping the entry');
  });

  it('reads differently for a reach the walk cannot follow, the two states having parted', () => {
    expect(refusalFor(NO_REACH)).not.toBe(refusalFor(UNREAD_REACH));
  });
});

/**
 * The refusal every unfollowable edge ends at is the sole owner of what one
 * skipped edge costs a reachability closure, and of what an escaped require
 * function is — so it carries pins of its own rather than borrowing the ones
 * above.
 *
 * That the module it names is still there is gated outside this file, by
 * `packages/config/rule-named-paths.mjs`: it reads every repo path a rule's own
 * literals name and refuses one that resolves to nothing, so a rename or a move
 * the message does not follow is caught there rather than here — which is why
 * the case below pins the wording alone.
 */
describe('the account an edge the walk cannot follow gets', () => {
  it('states what skipping one edge would cost, which is why the walk stops instead', () => {
    const account = refusalFor(UNREAD_REACH);

    expect(account).toContain('takes every module behind it out of the closure');
    expect(account).toContain('reads exactly like a clean pass');
  });

  it('names the expression the require function escaped through, not the statement around it', () => {
    expect(refusalFor(MEMBER_REACH)).toContain("'module.require'");
  });

  it('says what to write instead, rather than only what it refuses', () => {
    expect(refusalFor(UNREAD_REACH)).toContain('rewrite the reach in a form the walk reads');
  });

  it('names the minter beside the loader, the two escaping on the same terms', () => {
    expect(refusalFor(MINTED_BOUND_REACH)).toContain(
      'or the `createRequire` that mints one, which is the same escape a word earlier'
    );
  });

  it('names where the escapes are enumerated, the reader having no editor to follow', () => {
    expect(refusalFor(UNREAD_REACH)).toContain('packages/config/arch/lib/module-references.ts');
  });
});

/**
 * A door reaching the registry through a require that escapes into a value: the
 * walk reports the escape, so the edge is one this rule refuses to follow rather
 * than one it never saw. Each is paired with the ordinary spelling of the same
 * reach, which the walk does read — the pairing is what makes the refusal a
 * property of the FORM rather than of the fixture.
 */
describe('a reach written in a form the shared walk cannot follow', () => {
  it('refuses an ordinary door whose only edge in is a require bound to a name', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: UNREAD_REACH,
    });

    expect(() => rule.check(project)).toThrow('the require function escapes into a value');
  });

  it('refuses an ordinary door whose only edge in is a require taken off an object', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: MEMBER_REACH,
    });

    expect(() => rule.check(project)).toThrow('the require function escapes into a value');
  });

  it('refuses an ordinary door whose only edge in is a require destructured under a new name', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: DESTRUCTURED_REACH,
    });

    expect(() => rule.check(project)).toThrow('the require function escapes into a value');
  });

  it('refuses an ordinary door whose only edge in is a require imported under a new name', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: IMPORTED_REACH,
    });

    expect(() => rule.check(project)).toThrow('the require function escapes into a value');
  });

  it('refuses an ordinary door reached by a shorthand and a destructure composed', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: HANDED_ON_REACH,
    });

    expect(() => rule.check(project)).toThrow('the require function escapes into a value');
  });

  it('refuses an ordinary door whose only edge in is a minted require', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: MINTED_REACH,
    });

    expect(() => rule.check(project)).toThrow(
      `'createRequire(import.meta.url)' in ${PACKAGE_DIR}/src/index.ts`
    );
  });

  it('refuses an ordinary door whose only edge in is a mint imported under a new name', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: MINTED_IMPORTED_REACH,
    });

    expect(() => rule.check(project)).toThrow(
      `'createRequire as mk' in ${PACKAGE_DIR}/src/index.ts`
    );
  });

  it('refuses an ordinary door whose only edge in is a mint bound to a name', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: MINTED_BOUND_REACH,
    });

    expect(() => rule.check(project)).toThrow(`'createRequire' in ${PACKAGE_DIR}/src/index.ts`);
  });

  it('refuses an ordinary door whose only edge in is a mint taken off an object', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: MINTED_MEMBER_REACH,
    });

    expect(() => rule.check(project)).toThrow(
      `'nodeModule.createRequire(import.meta.url)' in ${PACKAGE_DIR}/src/index.ts`
    );
  });

  it('flags the same reach spelled as a plain require call, which the walk does read', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export const registry = require('./env.config.js');\n",
      })
    );

    expect(violations).toHaveLength(1);
  });
});

describe('what the walk counts as an edge', () => {
  it('follows a re-export, which an import-only scan misses', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export { envConfig } from './env.config.js';\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('follows a type-only import, the step that makes a value edge look harmless next', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]:
          "import type { envConfig } from './env.config.js';\nexport type Env = typeof envConfig;\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('follows a dynamic import', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]:
          "export const load = async () => import('./env.config.js');\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('reads a dynamic import written as a template, which holds the same string a quoted one does', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]:
          'export const load = async () => import(`./env.config.js`);\n',
      })
    );

    expect(violations).toHaveLength(1);
  });

  it("follows the package's OWN specifier, which a relative-only walk calls unreachable", () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export * from './api.js';\n",
        [`${PACKAGE_DIR}/src/api.ts`]:
          "import { envConfig } from '@hushbox/shared/env.config';\nexport const names = Object.keys(envConfig);\n",
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(`${PACKAGE_DIR}/src/api.ts`);
  });

  it('resolves the package barrel specifier back through the exports map', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts', './legal': './src/legal/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export { envConfig } from './env.config.js';\n",
        [`${PACKAGE_DIR}/src/legal/index.ts`]: "export * from '@hushbox/shared';\n",
      })
    );

    expect(violations).toHaveLength(2);
  });

  it('resolves a directory specifier to its index module', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: "export * from './legal/index.js';\n",
        [`${PACKAGE_DIR}/src/legal/index.ts`]: "export { envConfig } from '../env.config.js';\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('follows a type-position import(), which no import or export declaration carries', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]:
          "export type Registry = typeof import('./env.config.js').envConfig;\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('follows a deferred dynamic import, the phase spelling of the same link', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]:
          "export const load = async () => import.defer('./env.config.js');\n",
      })
    );

    expect(violations).toHaveLength(1);
  });

  it('counts a re-export with no source module as no edge, there being nothing to follow', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]: 'const version = 1;\nexport { version };\n',
      })
    );

    expect(violations).toEqual([]);
  });

  it('leaves an external specifier alone rather than chasing a package it cannot see', () => {
    const violations = rule.check(
      projectWith(manifestWith({ '.': './src/index.ts' }), {
        [`${PACKAGE_DIR}/src/index.ts`]:
          "import { z } from 'zod';\nexport const schema = z.string();\n",
      })
    );

    expect(violations).toEqual([]);
  });
});

describe('an edge the walk cannot resolve', () => {
  it('throws rather than dropping the subtree behind it', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: "export * from './api.mts';\n",
    });

    expect(() => rule.check(project)).toThrow('./api.mts');
  });

  it('throws on a dynamic import whose specifier is computed rather than written', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]:
        'export const load = async (name: string) => import(`./${name}.js`);\n',
    });

    expect(() => rule.check(project)).toThrow('${name}');
  });

  it('throws on a dynamic import carrying no specifier at all', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: 'export const load = async () => import();\n',
    });

    expect(() => rule.check(project)).toThrow('import()');
  });

  it('accounts for a parenthesised specifier as unread rather than as computed', () => {
    const message = refusalFor("export const load = async () => import(('./api.js'));\n");

    expect(message).toContain('read no module name off it');
    expect(message).not.toContain('computed');
  });

  it('accounts for a spread specifier as unread rather than as computed', () => {
    const message = refusalFor("export const registry = require(...['./api.js']);\n");

    expect(message).toContain('read no module name off it');
    expect(message).not.toContain('computed');
  });

  it('accounts for a declaration-position specifier without pointing at a call', () => {
    const message = refusalFor('export * from `./api.js`;\n');

    expect(message).toContain('read no module name off it');
    expect(message).toContain('where the form takes it');
    expect(message).not.toMatch(/\bcall/);
  });

  it('throws on a type-position import whose specifier is computed rather than written', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]:
        'type Name = string;\nexport type Registry = import(Name).Thing;\n',
    });

    expect(() => rule.check(project)).toThrow('import(Name)');
  });

  it('throws when a closure module reaches a first-party sibling the walk never opens', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: "export * from '@hushbox/config/arch/lib/paths.js';\n",
    });

    expect(() => rule.check(project)).toThrow('@hushbox/config/arch/lib/paths.js');
  });

  it('throws when a self-package specifier names a door whose module is gone', () => {
    const project = projectWith(
      manifestWith({ '.': './src/index.ts', './routes': './src/routes.ts' }),
      {
        [`${PACKAGE_DIR}/src/index.ts`]: "export * from '@hushbox/shared/routes';\n",
      }
    );

    expect(() => rule.check(project)).toThrow('@hushbox/shared/routes');
  });

  it('throws when a self-package specifier names no published door', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: "export * from '@hushbox/shared/secrets';\n",
    });

    expect(() => rule.check(project)).toThrow('@hushbox/shared/secrets');
  });
});

describe("the rule's own subject", () => {
  it('throws when no module declares the registry, so the rule cannot stand over nothing', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project
      .getFileSystem()
      .writeFileSync(path.join(REPO_ROOT, MANIFEST_PATH), manifestWith({ '.': './src/index.ts' }));
    project.createSourceFile(
      path.join(REPO_ROOT, `${PACKAGE_DIR}/src/index.ts`),
      'export const version = 1;\n'
    );

    expect(() => rule.check(project)).toThrow('envConfig');
  });

  it('throws when two modules declare it, which splits the subject in silence', () => {
    const project = projectWith(manifestWith({ '.': './src/index.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: 'export const version = 1;\n',
      [`${PACKAGE_DIR}/src/env.other.ts`]: 'export const envConfig = {};\n',
    });

    expect(() => rule.check(project)).toThrow('env.other.ts');
  });

  it('throws when a published door names a module that is gone', () => {
    const project = projectWith(manifestWith({ './routes': './src/routes.ts' }), {
      [`${PACKAGE_DIR}/src/index.ts`]: 'export const version = 1;\n',
    });

    expect(() => rule.check(project)).toThrow('./routes');
  });
});

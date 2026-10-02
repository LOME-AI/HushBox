import { existsSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  API_SRC,
  PRIMITIVE_DIR,
  PRIMITIVE_SPECIFIER,
  SPEND_FUNCTIONS,
  importSpecifierText,
  isSpendFunction,
  namedImportElements,
  repoRelative,
  spendBindings,
} from './rate-limit-spend-sites.js';

/**
 * A module the walks never read, parsed at a path inside the Worker's source
 * root so the locations it reports are the ones a real file would produce.
 */
function parse(text: string): ts.SourceFile {
  return ts.createSourceFile(
    path.join(API_SRC, 'slices', 'probe', 'flow.ts'),
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS
  );
}

/** The first statement of a probe, as the import declaration it was written as. */
function firstImport(text: string): ts.ImportDeclaration {
  const [statement] = parse(text).statements;
  if (statement === undefined || !ts.isImportDeclaration(statement)) {
    throw new Error('the probe did not parse as an import declaration.');
  }
  return statement;
}

describe('the walks’ source root', () => {
  it('is the directory the spend primitives live in', () => {
    expect(existsSync(path.join(API_SRC, PRIMITIVE_DIR, 'capability.ts'))).toBe(true);
  });

  it('spells a file beneath it repo-relative, in one spelling on every platform', () => {
    expect(repoRelative(path.join(API_SRC, 'slices', 'media', 'domain', 'rate-limit.ts'))).toBe(
      'apps/api/src/slices/media/domain/rate-limit.ts'
    );
  });

  it('carries the specifier fragment an import of the primitives is recognized by', () => {
    expect(repoRelative(path.join(API_SRC, PRIMITIVE_DIR, 'index.ts'))).toContain(
      PRIMITIVE_SPECIFIER
    );
  });
});

describe('the spend primitives', () => {
  it('are recognized under each name they are exported with', () => {
    expect(SPEND_FUNCTIONS.filter((name) => isSpendFunction(name))).toEqual([...SPEND_FUNCTIONS]);
  });

  it('do not claim a name neighbouring theirs', () => {
    expect(isSpendFunction('consumeLayer')).toBe(false);
  });
});

describe('the bound names one module gives the spend primitives', () => {
  it('hold each primitive the module imports under its own name', () => {
    const bound = spendBindings(
      parse("import { consume, consumeLayers } from '../../lib/rate-limit/index.js';")
    );
    expect([...bound]).toEqual([
      ['consume', 'consume'],
      ['consumeLayers', 'consumeLayers'],
    ]);
  });

  it('follow an alias back to the primitive it renames', () => {
    const bound = spendBindings(
      parse("import { consume as spend } from '../../lib/rate-limit/index.js';")
    );
    expect([...bound]).toEqual([['spend', 'consume']]);
  });

  it('pass over a type-only element of an import of the primitives', () => {
    const bound = spendBindings(
      parse("import { consume, type RateLimitDefinition } from '../../lib/rate-limit/index.js';")
    );
    expect([...bound.keys()]).toEqual(['consume']);
  });

  it('are empty for a module that imports neither primitive', () => {
    expect(spendBindings(parse("import { z } from 'zod';")).size).toBe(0);
  });

  it('refuse a namespace import of the primitives', () => {
    expect(() =>
      spendBindings(parse("import * as rateLimit from '../../lib/rate-limit/index.js';"))
    ).toThrow(/namespace import of the rate-limit primitives/);
  });

  it('refuse a primitive’s name imported from anywhere else', () => {
    expect(() => spendBindings(parse("import { consume } from '../counting.js';"))).toThrow(
      /imports 'consume' from '\.\.\/counting\.js'/
    );
  });

  it('pass over a primitive’s name imported type-only from elsewhere', () => {
    expect(spendBindings(parse("import type { consume } from '../counting.js';")).size).toBe(0);
  });

  it('pass over a type-only namespace import of the primitives', () => {
    expect(
      spendBindings(parse("import type * as rl from '../../lib/rate-limit/index.js';")).size
    ).toBe(0);
  });
});

describe('one import declaration', () => {
  it('names the module it reads as its specifier text', () => {
    expect(
      importSpecifierText(
        firstImport("import { consume } from '../../lib/rate-limit/index.js';"),
        'probe'
      )
    ).toBe('../../lib/rate-limit/index.js');
  });

  it('refuses a specifier that is not a string literal', () => {
    expect(() =>
      importSpecifierText(
        firstImport('import { consume } from `../../lib/rate-limit/index.js`;'),
        'probe'
      )
    ).toThrow(/an import specifier this walk cannot read/);
  });

  it('carries no named imports when the statement is not an import at all', () => {
    const [statement] = parse('const consume = 1;').statements;
    if (statement === undefined) throw new Error('the probe parsed to nothing.');
    expect(namedImportElements(statement)).toEqual([]);
  });
});

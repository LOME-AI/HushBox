import { describe, it, expect } from 'vitest';
import path from 'node:path';
import ts from 'typescript';
import { STACK_SLOT_VARIABLE, stackSlotFrom } from './stack-slot.js';

const STACK_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(STACK_DIR, '..', '..', '..');
const BASE_TSCONFIG = path.join(REPO_ROOT, 'packages', 'config', 'tsconfig.base.json');

const SHARED_READER = path.join(STACK_DIR, 'stack-slot.ts');
const SLOT_ALLOCATOR = path.join(REPO_ROOT, 'scripts', 'lib', 'claims', 'slot-claim.ts');

/** How a module the compiler loaded spells the claim registry's directory. */
const CLAIM_REGISTRY_DIR = '/lib/claims/';

/** The package the claim files reach the kernel's advisory locks through. */
const NATIVE_LOCKING_PACKAGE = 'fs-native-extensions';

/**
 * Module resolution has to be the compiler's own, or the graph walked here is
 * not the graph the code loads. Read from the config every package extends
 * rather than restated, so a resolution change moves both together.
 */
function resolutionOptions(): ts.CompilerOptions {
  const read = ts.readConfigFile(BASE_TSCONFIG, (file) => ts.sys.readFile(file));
  if (read.error || !read.config) throw new Error('cannot read the base tsconfig');
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(BASE_TSCONFIG),
    undefined,
    BASE_TSCONFIG
  );
  // Nothing here reads a type, only which files the compiler had to load, and
  // the standard library plus every ambient @types package costs more than the
  // whole walk.
  return { ...parsed.options, noLib: true, types: [] };
}

interface ModuleGraph {
  /** Every file the compiler loaded to build the entry's program. */
  readonly files: readonly string[];
  /** Every module specifier those files name, resolved or not. */
  readonly specifiers: readonly string[];
}

function specifierOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
  return undefined;
}

function moduleSpecifiersOf(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = specifierOf(node);
    if (specifier && ts.isStringLiteral(specifier)) found.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * What a module reaches, taken from the program the compiler builds for it
 * rather than from the import list at the top of the file: a specifier reaches
 * whatever the module behind it reaches, however many files down.
 */
function moduleGraphOf(entry: string): ModuleGraph {
  const program = ts.createProgram([entry], resolutionOptions());
  const sources = program.getSourceFiles();
  return {
    files: sources.map((source) => source.fileName),
    specifiers: sources.flatMap((source) => moduleSpecifiersOf(source)),
  };
}

describe('stackSlotFrom', () => {
  it('names the variable the generator writes the slot into', () => {
    expect(STACK_SLOT_VARIABLE).toBe('HB_STACK_SLOT');
  });

  it('reads the slot the generator wrote', () => {
    expect(stackSlotFrom({ [STACK_SLOT_VARIABLE]: '7' })).toBe(7);
  });

  it('reads a written zero as the slot it names', () => {
    expect(stackSlotFrom({ [STACK_SLOT_VARIABLE]: '0' })).toBe(0);
  });

  it('refuses an absent variable rather than standing in a slot another checkout may hold', () => {
    expect(() => stackSlotFrom({})).toThrow(STACK_SLOT_VARIABLE);
  });

  it.each(['', '   ', '1.5', '-1', 'nine'])(
    'refuses the misconfigured value %j rather than guessing a slot',
    (value) => {
      expect(() => stackSlotFrom({ [STACK_SLOT_VARIABLE]: value })).toThrow(STACK_SLOT_VARIABLE);
    }
  );
});

describe("the shared reader's module graph", () => {
  it('reaches neither the claim registry nor the native locking package', () => {
    const graph = moduleGraphOf(SHARED_READER);

    expect(graph.files.some((file) => file.endsWith('/lib/stack/stack-slot.ts'))).toBe(true);
    expect(graph.files.filter((file) => file.includes(CLAIM_REGISTRY_DIR))).toEqual([]);
    expect(graph.specifiers).not.toContain(NATIVE_LOCKING_PACKAGE);
  });

  it('would see both of them, walked from the allocator that does reach them', () => {
    const graph = moduleGraphOf(SLOT_ALLOCATOR);

    expect(graph.files.filter((file) => file.includes(CLAIM_REGISTRY_DIR)).length).toBeGreaterThan(
      0
    );
    expect(graph.specifiers).toContain(NATIVE_LOCKING_PACKAGE);
  });
});

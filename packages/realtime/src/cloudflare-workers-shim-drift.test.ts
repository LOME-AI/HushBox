// The instrument on the sync contract `cloudflare-workers.d.ts` carries: every
// declaration the shim makes — the Durable Object base, the interfaces and
// consts beside it, and the additive augmentations of DOM interfaces — must
// name a declaration the installed platform types also make, and may declare
// no member on it the platform does not, while deliberately giving those
// members different TYPES (rebinding Request/Response/WebSocket to the
// consumer's own globals is the shim's whole purpose). So this compares names
// and never signatures — a signature comparison would be permanently red
// against a shim doing its job.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function parse(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
}

type NamedDeclaration =
  | ts.ClassDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.VariableDeclaration;

type MemberBearing = ts.ClassDeclaration | ts.InterfaceDeclaration;

interface Declarations {
  readonly source: ts.SourceFile;
  readonly byName: ReadonlyMap<string, NamedDeclaration[]>;
  readonly names: readonly string[];
}

/**
 * Constructors and construct signatures are nameless here on purpose: a
 * constructor is not a member a subclass can override, which is the property
 * the base-class half of this comparison rests on.
 */
function memberName(
  member: ts.ClassElement | ts.TypeElement,
  source: ts.SourceFile
): string | undefined {
  if (ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
    return undefined;
  }
  return member.name === undefined ? undefined : member.name.getText(source);
}

function namesOfMembers(
  members: readonly (ts.ClassElement | ts.TypeElement)[],
  source: ts.SourceFile
): string[] {
  return members
    .map((member) => memberName(member, source))
    .filter((name): name is string => name !== undefined);
}

function namedDeclarationOf(
  node: ts.Node
): { name: string; declaration: NamedDeclaration } | undefined {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name === undefined ? undefined : { name: node.name.text, declaration: node };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, declaration: node };
  }
  return undefined;
}

/**
 * Every named declaration a source carries, indexed by name and kept in source
 * order. Declarations nested in a module or namespace block are indexed under
 * the bare name: the shim puts the Durable Object base inside
 * `declare module 'cloudflare:workers'` while the platform types put it
 * elsewhere, and the two are the same declaration for this comparison.
 */
function indexDeclarations(sourceText: string, fileName: string): Declarations {
  const source = parse(sourceText, fileName);
  const byName = new Map<string, NamedDeclaration[]>();
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    const named = namedDeclarationOf(node);
    if (named !== undefined) {
      const existing = byName.get(named.name);
      if (existing === undefined) {
        byName.set(named.name, [named.declaration]);
        names.push(named.name);
      } else {
        existing.push(named.declaration);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { source, byName, names };
}

/**
 * The member names reachable from one declaration, unioned across every
 * declaration sharing the name. Names only: the shim's member types
 * deliberately differ from the platform's, so a signature comparison would be
 * permanently red against a shim doing its job.
 */
function declaredMemberNames(declarations: Declarations, name: string): Set<string> {
  return collectMemberNames(declarations, name, new Set());
}

function collectMemberNames(
  declarations: Declarations,
  name: string,
  seen: Set<string>
): Set<string> {
  const collected = new Set<string>();
  if (seen.has(name)) return collected;
  seen.add(name);
  for (const declaration of declarations.byName.get(name) ?? []) {
    for (const member of memberNamesOfDeclaration(declarations, declaration, seen)) {
      collected.add(member);
    }
  }
  return collected;
}

function heritageNames(declaration: MemberBearing): string[] {
  return (declaration.heritageClauses ?? []).flatMap((clause) =>
    clause.types
      .map((type) => type.expression)
      .filter((expression) => ts.isIdentifier(expression))
      .map((identifier) => identifier.text)
  );
}

/**
 * Members are collected through the indirections the platform types use to
 * place them: a base class or extended interface, a type alias, and the type of
 * a declared const. Without that the platform's `DurableObjectStub` — an alias
 * onto an intersection whose `fetch` lives in `Fetcher` — would read as
 * memberless and redden a shim that is tracking it correctly.
 */
function memberNamesOfDeclaration(
  declarations: Declarations,
  declaration: NamedDeclaration,
  seen: Set<string>
): Set<string> {
  if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) {
    return declaration.type === undefined
      ? new Set()
      : memberNamesOfType(declarations, declaration.type, seen);
  }
  const collected = new Set(namesOfMembers([...declaration.members], declarations.source));
  for (const base of heritageNames(declaration)) {
    for (const inherited of collectMemberNames(declarations, base, seen)) collected.add(inherited);
  }
  return collected;
}

/** The parts of a composed type node whose members belong to the whole. */
function typeConstituents(node: ts.TypeNode): readonly ts.TypeNode[] {
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) return node.types;
  if (ts.isParenthesizedTypeNode(node)) return [node.type];
  if (ts.isConditionalTypeNode(node)) return [node.trueType, node.falseType];
  return [];
}

/**
 * Property types are deliberately not followed: a member's own type is a
 * different declaration, and pulling its members in would dissolve every
 * declaration's member set into one blob that no divergence could escape.
 */
function memberNamesOfType(
  declarations: Declarations,
  node: ts.TypeNode,
  seen: Set<string>
): Set<string> {
  const collected = new Set<string>();
  if (ts.isTypeLiteralNode(node)) {
    for (const name of namesOfMembers([...node.members], declarations.source)) collected.add(name);
  } else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    for (const name of collectMemberNames(declarations, node.typeName.text, seen)) {
      collected.add(name);
    }
  }
  for (const constituent of typeConstituents(node)) {
    for (const name of memberNamesOfType(declarations, constituent, seen)) collected.add(name);
  }
  return collected;
}

/**
 * The base members a Durable Object subclass overrides. Reads the `override`
 * modifier rather than resolving the base type: `noImplicitOverride` makes the
 * modifier mandatory, so it is present wherever an override is.
 */
function extendsDurableObject(node: ts.ClassLikeDeclaration, source: ts.SourceFile): boolean {
  const extended = node.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
  );
  return (extended?.types[0]?.expression.getText(source) ?? '').endsWith('DurableObject');
}

function overriddenMembers(node: ts.ClassLikeDeclaration, source: ts.SourceFile): string[] {
  return node.members
    .filter((member) => (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Override) !== 0)
    .map((member) => memberName(member, source))
    .filter((name): name is string => name !== undefined);
}

function overriddenBaseMembers(sourceText: string, fileName: string): string[] {
  const source = parse(sourceText, fileName);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node) && extendsDurableObject(node, source)) {
      names.push(...overriddenMembers(node, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The declaration whose omissions matter, for the reason {@link driftBetween} records. */
const BASE_CLASS = 'DurableObject';

function driftForDeclaration(
  name: string,
  shim: Declarations,
  platform: Declarations,
  overridden: ReadonlySet<string>
): string[] {
  if (!platform.byName.has(name)) {
    return [`the shim declares a name the platform does not: ${name}`];
  }
  const shimMembers = declaredMemberNames(shim, name);
  const platformMembers = declaredMemberNames(platform, name);
  const overreach = [...shimMembers]
    .filter((member) => !platformMembers.has(member))
    .map((member) => `the shim declares a member the platform does not: ${name}.${member}`);
  if (name !== BASE_CLASS) return overreach;
  return [
    ...overreach,
    ...[...platformMembers]
      .filter((member) => overridden.has(member) && !shimMembers.has(member))
      .map(
        (member) =>
          `the platform declares a member the shim omits and a subclass overrides: ${name}.${member}`
      ),
  ];
}

/**
 * Every way the shim's declarations may part from the platform's, worded so the
 * failure names the declaration and the member. Two asymmetries are deliberate.
 * A member the shim declares and the platform does not is always drift: the
 * shim is what a DOM-lib consumer type-checks against, so it may never promise
 * a member the runtime types have dropped. The reverse — a member the platform
 * declares and the shim omits — is the shim being narrow on purpose everywhere
 * except the base class, where `noImplicitOverride` makes an omitted member a
 * contradiction (TS4113 against the shim, TS4114 against the real types); so it
 * is reported for the base class alone, and only when a subclass overrides it.
 */
function driftBetween(
  shimSource: string,
  platformSource: string,
  subclassSources: readonly string[]
): string[] {
  const shim = indexDeclarations(shimSource, 'the shim');
  const platform = indexDeclarations(platformSource, 'the platform types');
  const overridden = new Set(
    subclassSources.flatMap((source) => overriddenBaseMembers(source, 'a subclass source'))
  );

  return shim.names
    .flatMap((name) => driftForDeclaration(name, shim, platform, overridden))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Fixture edit that fails loudly rather than silently doing nothing: a fixture
 * built by an anchor the file no longer contains would leave the divergence
 * tests asserting against an unmodified source, inverting what they prove.
 */
function mutate(sourceText: string, anchor: string, replacement: string): string {
  if (!sourceText.includes(anchor)) throw new Error(`fixture anchor not found: ${anchor}`);
  return sourceText.replace(anchor, replacement);
}

describe('declaredMemberNames', () => {
  it('lists the member names a base class declares, excluding its constructor', () => {
    const source = [
      "declare module 'cloudflare:workers' {",
      '  export abstract class DurableObject<Env = unknown> {',
      '    protected ctx: DurableObjectState;',
      '    constructor(ctx: DurableObjectState, env: Env);',
      '    fetch(request: Request): Response | Promise<Response>;',
      '  }',
      '}',
    ].join('\n');

    expect([
      ...declaredMemberNames(indexDeclarations(source, 'shim.d.ts'), 'DurableObject'),
    ]).toEqual(['ctx', 'fetch']);
  });

  it('lists the member names an interface declares', () => {
    const source = [
      'interface DurableObjectId {',
      '  readonly name?: string;',
      '  toString(): string;',
      '}',
    ].join('\n');

    expect([
      ...declaredMemberNames(indexDeclarations(source, 'shim.d.ts'), 'DurableObjectId'),
    ]).toEqual(['name', 'toString']);
  });
});

describe('overriddenBaseMembers', () => {
  it('lists the members a Durable Object subclass marks as overrides', () => {
    const source = [
      "import { DurableObject } from 'cloudflare:workers';",
      'export class Room extends DurableObject<Env> {',
      '  override async fetch(): Promise<Response> {',
      '    return new Response();',
      '  }',
      '  private helper(): void {}',
      '}',
    ].join('\n');

    expect(overriddenBaseMembers(source, 'room.ts')).toEqual(['fetch']);
  });
});

const PLATFORM_DECLARATIONS = [
  'declare namespace CloudflareWorkersModule {',
  '  export abstract class DurableObject<Env = Cloudflare.Env, Props = {}> {',
  '    [Rpc.__DURABLE_OBJECT_BRAND]: never;',
  '    protected ctx: DurableObjectState<Props>;',
  '    constructor(ctx: DurableObjectState, env: Env);',
  '    fetch?(request: Request): Response | Promise<Response>;',
  '    connect?(socket: Socket): void | Promise<void>;',
  '    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void;',
  '  }',
  '}',
  'interface DurableObjectState<Props = unknown> {',
  '  waitUntil(promise: Promise<any>): void;',
  '  readonly id: DurableObjectId;',
  '  abort(reason?: string): void;',
  '}',
].join('\n');

const SHIM_DECLARATIONS = [
  "declare module 'cloudflare:workers' {",
  '  export abstract class DurableObject<Env = unknown> {',
  '    protected ctx: DurableObjectState;',
  '    constructor(ctx: DurableObjectState, env: Env);',
  '    fetch(request: Request): Response | Promise<Response>;',
  '    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void;',
  '  }',
  '}',
  'interface DurableObjectState {',
  '  waitUntil(promise: Promise<unknown>): void;',
  '  readonly id: DurableObjectId;',
  '}',
].join('\n');

const SHELL_OVERRIDING_CLOSE = [
  'export class Room extends DurableObject<Env> {',
  '  override async webSocketClose(ws: WebSocket): Promise<void> {}',
  '}',
].join('\n');

describe('driftBetween', () => {
  it('reports a member the shim declares on the base class that the platform does not', () => {
    const shim = mutate(
      SHIM_DECLARATIONS,
      '    fetch(request: Request): Response | Promise<Response>;',
      '    fetch(request: Request): Response | Promise<Response>;\n    hibernate(): void;'
    );

    expect(driftBetween(shim, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])).toEqual([
      'the shim declares a member the platform does not: DurableObject.hibernate',
    ]);
  });

  it('reports a member the shim declares on an interface that the platform does not', () => {
    const shim = mutate(
      SHIM_DECLARATIONS,
      '  waitUntil(promise: Promise<unknown>): void;',
      '  waitUntil(promise: Promise<unknown>): void;\n  hibernate(): void;'
    );

    expect(driftBetween(shim, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])).toEqual([
      'the shim declares a member the platform does not: DurableObjectState.hibernate',
    ]);
  });

  it('reports a name the shim declares that the platform does not declare at all', () => {
    const shim = mutate(
      SHIM_DECLARATIONS,
      'interface DurableObjectState {',
      'interface DurableObjectHandle {'
    );

    expect(driftBetween(shim, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])).toEqual([
      'the shim declares a name the platform does not: DurableObjectHandle',
    ]);
  });

  it('reports a member the platform declares that the shim omits and a subclass overrides', () => {
    const shim = mutate(
      SHIM_DECLARATIONS,
      '    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void;\n',
      ''
    );

    expect(driftBetween(shim, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])).toEqual([
      'the platform declares a member the shim omits and a subclass overrides: DurableObject.webSocketClose',
    ]);
  });

  it('passes over a platform member the shim omits that no subclass overrides', () => {
    expect(
      driftBetween(SHIM_DECLARATIONS, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])
    ).toEqual([]);
  });

  it('passes when the base class member lists agree while the member types differ', () => {
    const rebound = mutate(
      SHIM_DECLARATIONS,
      '    fetch(request: Request): Response | Promise<Response>;',
      '    fetch(request: DomRequest, extra: number): Promise<DomResponse>;'
    );

    expect(driftBetween(rebound, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])).toEqual([]);
  });

  it('passes when an interface member list agrees while the member types differ', () => {
    const rebound = mutate(
      SHIM_DECLARATIONS,
      '  waitUntil(promise: Promise<unknown>): void;',
      '  waitUntil(promise: DomPromise<never>, extra: number): void;'
    );

    expect(driftBetween(rebound, PLATFORM_DECLARATIONS, [SHELL_OVERRIDING_CLOSE])).toEqual([]);
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SHIM_PATH = path.join(HERE, 'cloudflare-workers.d.ts');
const OFFICIAL_TYPES_PATH = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@cloudflare/workers-types/package.json')),
  'index.d.ts'
);

/** The workspaces that can host a Worker, and so a Durable Object subclass. */
const SUBCLASS_ROOTS = ['apps', 'packages'];
const UNWALKED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.wrangler',
  '.astro',
]);

function typeScriptSourcePaths(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!UNWALKED_DIRECTORIES.has(entry.name)) paths.push(...typeScriptSourcePaths(entryPath));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      paths.push(entryPath);
    }
  }
  return paths;
}

function durableObjectSubclassSources(): string[] {
  return SUBCLASS_ROOTS.flatMap((root) => typeScriptSourcePaths(path.join(REPO_ROOT, root)))
    .map((sourcePath) => readFileSync(sourcePath, 'utf8'))
    .filter((text) => text.includes('extends DurableObject'));
}

/**
 * One member's declaration verbatim. Only the tests that prove the detector
 * ignores signatures read this — the detector itself never does.
 */
function memberDeclarationText(
  declarationName: string,
  wanted: string,
  sourceText: string,
  fileName: string
): string {
  const declarations = indexDeclarations(sourceText, fileName);
  let text = '';
  for (const declaration of declarations.byName.get(declarationName) ?? []) {
    if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) continue;
    for (const member of declaration.members) {
      if (memberName(member, declarations.source) === wanted) {
        text = member.getText(declarations.source);
      }
    }
  }
  return text;
}

describe('the shim tracks the platform declarations it carries', () => {
  const shimSource = readFileSync(SHIM_PATH, 'utf8');
  const platformSource = readFileSync(OFFICIAL_TYPES_PATH, 'utf8');
  const subclassSources = durableObjectSubclassSources();
  const shim = indexDeclarations(shimSource, SHIM_PATH);
  const platform = indexDeclarations(platformSource, OFFICIAL_TYPES_PATH);

  it('reads a non-empty member list off the base class on both sides', () => {
    expect([...declaredMemberNames(shim, 'DurableObject')]).toContain('webSocketClose');
    expect([...declaredMemberNames(platform, 'DurableObject')]).toContain('webSocketClose');
  });

  it('reads a non-empty member list off a declaration outside the base class', () => {
    expect([...declaredMemberNames(shim, 'DurableObjectState')]).toContain('waitUntil');
    expect([...declaredMemberNames(platform, 'DurableObjectState')]).toContain('waitUntil');
  });

  it('resolves a platform member that reaches the declaration through a type alias', () => {
    expect([...declaredMemberNames(shim, 'DurableObjectStub')]).toContain('fetch');
    expect([...declaredMemberNames(platform, 'DurableObjectStub')]).toContain('fetch');
  });

  it('carries no declaration the platform types lack', () => {
    expect(shim.names.filter((name) => !platform.byName.has(name))).toEqual([]);
    expect(shim.names).toEqual(
      expect.arrayContaining([
        'DurableObject',
        'DurableObjectState',
        'WebSocketPair',
        'ResponseInit',
      ])
    );
  });

  it('finds the in-repository subclasses that override base members', () => {
    expect(subclassSources.length).toBeGreaterThan(0);
    expect(subclassSources.flatMap((text) => overriddenBaseMembers(text, 'subclass.ts'))).toContain(
      'webSocketClose'
    );
  });

  it('holds while the base class gives a member a different type', () => {
    const shimFetch = memberDeclarationText('DurableObject', 'fetch', shimSource, SHIM_PATH);
    const platformFetch = memberDeclarationText(
      'DurableObject',
      'fetch',
      platformSource,
      OFFICIAL_TYPES_PATH
    );

    expect(shimFetch).not.toBe('');
    expect(shimFetch).not.toBe(platformFetch);
    expect(driftBetween(shimSource, platformSource, subclassSources)).toEqual([]);
  });

  it('holds while an interface gives a member a different type', () => {
    const shimWaitUntil = memberDeclarationText(
      'DurableObjectState',
      'waitUntil',
      shimSource,
      SHIM_PATH
    );
    const platformWaitUntil = memberDeclarationText(
      'DurableObjectState',
      'waitUntil',
      platformSource,
      OFFICIAL_TYPES_PATH
    );

    expect(shimWaitUntil).not.toBe('');
    expect(shimWaitUntil).not.toBe(platformWaitUntil);
    expect(driftBetween(shimSource, platformSource, subclassSources)).toEqual([]);
  });

  it('does not drift', () => {
    expect(driftBetween(shimSource, platformSource, subclassSources)).toEqual([]);
  });

  it('reports a member added to the real shim base class that the platform lacks', () => {
    const withExtra = mutate(
      shimSource,
      '    alarm(): void | Promise<void>;',
      '    alarm(): void | Promise<void>;\n    hibernate(): void;'
    );

    expect(driftBetween(withExtra, platformSource, subclassSources)).toEqual([
      'the shim declares a member the platform does not: DurableObject.hibernate',
    ]);
  });

  it('reports a member added to a real shim interface that the platform lacks', () => {
    const withExtra = mutate(
      shimSource,
      '  waitUntil(promise: Promise<unknown>): void;',
      '  waitUntil(promise: Promise<unknown>): void;\n  hibernate(): void;'
    );

    expect(driftBetween(withExtra, platformSource, subclassSources)).toEqual([
      'the shim declares a member the platform does not: DurableObjectState.hibernate',
    ]);
  });

  it('reports a real shim declaration the platform types do not name', () => {
    const renamed = mutate(
      shimSource,
      'interface AnalyticsEngineDataset {',
      'interface AnalyticsEngineDataStream {'
    );

    expect(driftBetween(renamed, platformSource, subclassSources)).toEqual([
      'the shim declares a name the platform does not: AnalyticsEngineDataStream',
    ]);
  });

  it('reports a member removed from the real shim that a subclass overrides', () => {
    const withoutError = mutate(
      shimSource,
      '    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;\n',
      ''
    );

    expect(driftBetween(withoutError, platformSource, subclassSources)).toEqual([
      'the platform declares a member the shim omits and a subclass overrides: DurableObject.webSocketError',
    ]);
  });
});

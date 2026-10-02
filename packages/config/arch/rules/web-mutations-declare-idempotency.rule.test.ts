import { Project, ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { DECLARATION_MODULE } from './web-mutations-declare-idempotency.rule.js';

/**
 * The declaration module, as the rule reads it out of the web tree. Its three
 * exported names are the whole vocabulary the rule recognizes, so a fixture
 * that omits one models the module having moved out from under the rule.
 */
const DECLARATION_SOURCE =
  'export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";\n' +
  'export function idempotencyKeyFor(variables: object): string {\n' +
  '  return String(variables);\n' +
  '}\n' +
  'export function idempotentHeaders(variables: object): { headers: Record<string, string> } {\n' +
  '  return { headers: { "Idempotency-Key": idempotencyKeyFor(variables) } };\n' +
  '}\n' +
  'export function idempotencyExempt(exemption: string): { idempotencyExemption: string } {\n' +
  '  return { idempotencyExemption: exemption };\n' +
  '}\n';

/**
 * TanStack's own module. `paths` stands in for the node_modules link the real
 * run resolves it through — the rule reads only the resolved declaration, so
 * both projects hand it the same thing by different routes. The alias the web
 * tree opens the DECLARATION module through gets no `paths` entry, because the
 * real run has none either: the arch project carries empty compiler options,
 * so `@/…` resolves nowhere and the rule must resolve it itself.
 */
const TANSTACK = '/node_modules/@tanstack/react-query/index.d.ts';

function projectWith(
  files: Record<string, string>,
  options?: { readonly noModule?: boolean }
): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      baseUrl: '/',
      paths: { '@tanstack/react-query': [TANSTACK] },
      target: ts.ScriptTarget.ES2022,
    },
  });
  project.createSourceFile(
    TANSTACK,
    'export declare function useMutation<T>(options: T): T;\n' +
      'export declare function useQuery<T>(options: T): T;\n'
  );
  if (options?.noModule !== true) {
    project.createSourceFile(`/${DECLARATION_MODULE}`, DECLARATION_SOURCE);
  }
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const IMPORTS =
  "import { useMutation } from '@tanstack/react-query';\n" +
  "import { idempotencyExempt, idempotentHeaders } from '@/lib/api/idempotent-mutation.js';\n";

/**
 * A module that builds its mutations on the app's client. The client's module is
 * opened through the `@/…` alias, which the arch project resolves nowhere.
 */
const CACHE_IMPORTS =
  "import { queryClient } from '@/providers/query-provider';\n" +
  "import { idempotencyExempt, idempotencyKeyFor } from '@/lib/api/idempotent-mutation.js';\n";

describe('web-mutations-declare-idempotency', () => {
  it('flags a mutation that neither carries a key nor declares an exemption', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'export function useThing(): unknown {\n' +
        '  return useMutation({\n' +
        '    mutationFn: (v: object) => post(v),\n' +
        '  });\n' +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/hooks/use-thing.ts');
    expect(violations[0]?.message).toContain('Idempotency-Key');
  });

  it('passes a mutation whose options reach the key helper directly', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'export function useThing(): unknown {\n' +
        '  return useMutation({\n' +
        '    mutationFn: (v: object) => post(v, idempotentHeaders(v)),\n' +
        '  });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a mutation reaching the key through a same-file helper', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'function headersFor(id: string): unknown {\n' +
        '  return idempotentHeaders({ id });\n' +
        '}\n' +
        'export function useThing(): unknown {\n' +
        '  return useMutation({\n' +
        '    mutationFn: (id: string) => post(id, headersFor(id)),\n' +
        '  });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('recognizes the key helper imported under another name', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        "import { useMutation } from '@tanstack/react-query';\n" +
        "import { idempotentHeaders as keyed } from '@/lib/api/idempotent-mutation.js';\n" +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, keyed(v)) });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a mutation whose meta is not the exemption declaration', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'export function useThing(): unknown {\n' +
        "  return useMutation({ meta: { idempotencyExemption: 'opaque-protocol' }, mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/hooks/use-thing.ts');
  });

  it('flags a mutation handed an options value instead of a literal', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'const options = { mutationFn: (v: object) => post(v, idempotentHeaders(v)) };\n' +
        'export function useThing(): unknown {\n' +
        '  return useMutation(options);\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/hooks/use-thing.ts');
    expect(violations[0]?.message).toContain('object literal');
  });

  it('passes over a same-named call that does not resolve to TanStack', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        "import { idempotencyExempt, idempotentHeaders } from '@/lib/api/idempotent-mutation.js';\n" +
        'function useMutation<T>(options: T): T {\n' +
        '  return options;\n' +
        '}\n' +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: () => post() });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over a test file', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.test.ts':
        IMPORTS + 'const m = useMutation({ mutationFn: () => post() });\n',
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('recognizes the declaration module opened through a relative specifier', () => {
    const project = projectWith({
      '/apps/web/src/lib/api/use-thing.ts':
        "import { useMutation } from '@tanstack/react-query';\n" +
        "import { idempotentHeaders } from './idempotent-mutation.js';\n" +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
      '/apps/web/src/hooks/deep/use-climbing.ts':
        "import { useMutation } from '@tanstack/react-query';\n" +
        "import { idempotencyExempt } from '../../lib/api/idempotent-mutation.js';\n" +
        'export function useClimbing(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('recognizes the declaration module opened through a `.ts`-spelled specifier', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        "import { useMutation } from '@tanstack/react-query';\n" +
        "import { idempotentHeaders } from '@/lib/api/idempotent-mutation.ts';\n" +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over a type-only binding on the declaration module', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        "import { useMutation } from '@tanstack/react-query';\n" +
        "import type { idempotentHeaders } from '@/lib/api/idempotent-mutation.js';\n" +
        "import { type idempotencyExempt as Unused, idempotentHeaders as keyed } from '@/lib/api/idempotent-mutation.js';\n" +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, keyed(v)) });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('follows a same-file arrow helper, and terminates on a recursive one', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        'const headersFor = (id: string): unknown => idempotentHeaders({ id });\n' +
        'export function useThing(): unknown {\n' +
        '  return useMutation({ mutationFn: (id: string) => post(id, headersFor(id)) });\n' +
        '}\n',
      '/apps/web/src/hooks/use-loop.ts':
        IMPORTS +
        'function spin(n: number): unknown {\n' +
        '  return spin(n - 1);\n' +
        '}\n' +
        'export function useLoop(): unknown {\n' +
        '  return useMutation({ mutationFn: (n: number) => spin(n) });\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/hooks/use-loop.ts');
  });

  it('flags an exemption reached off a namespace rather than the declaration', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-thing.ts':
        IMPORTS +
        "import * as helpers from '@/lib/api/idempotent-mutation.js';\n" +
        'export function useThing(): unknown {\n' +
        "  return useMutation({ meta: helpers.idempotencyExempt('opaque-protocol'), mutationFn: () => client.x.$post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => client.x.$post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/hooks/use-thing.ts');
  });

  it('flags a mutation built on the mutation cache that neither carries a key nor declares an exemption', () => {
    const project = projectWith({
      '/apps/web/src/lib/send.ts':
        CACHE_IMPORTS +
        'export function send(): Promise<unknown> {\n' +
        '  return queryClient\n' +
        '    .getMutationCache()\n' +
        '    .build(queryClient, { mutationFn: () => post() })\n' +
        '    .execute(undefined);\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/send.ts');
    expect(violations[0]?.message).toContain('Idempotency-Key');
  });

  it('passes cache-built mutations whose options reach the key helper or declare an exemption', () => {
    const project = projectWith({
      '/apps/web/src/lib/send.ts':
        CACHE_IMPORTS +
        'export function send(turn: object): Promise<unknown> {\n' +
        '  return queryClient\n' +
        '    .getMutationCache()\n' +
        '    .build(queryClient, { mutationFn: (v: object) => post(idempotencyKeyFor(v)) })\n' +
        '    .execute(turn);\n' +
        '}\n',
      '/apps/web/src/lib/register.ts':
        CACHE_IMPORTS +
        'export function register(): Promise<unknown> {\n' +
        '  return queryClient\n' +
        '    .getMutationCache()\n' +
        "    .build(queryClient, { meta: idempotencyExempt('naturally-idempotent'), mutationFn: () => post() })\n" +
        '    .execute(undefined);\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a cache-built mutation handed an options value instead of a literal', () => {
    const project = projectWith({
      '/apps/web/src/lib/send.ts':
        CACHE_IMPORTS +
        'const options = { mutationFn: (v: object) => post(idempotencyKeyFor(v)) };\n' +
        'export function send(turn: object): Promise<unknown> {\n' +
        '  return queryClient.getMutationCache().build(queryClient, options).execute(turn);\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('/apps/web/src/lib/send.ts');
    expect(violations[0]?.message).toContain('object literal');
  });

  it('passes over a build call that is not made on a mutation cache', () => {
    const project = projectWith({
      '/apps/web/src/lib/builders.ts':
        CACHE_IMPORTS +
        'export function builders(factory: Builder): unknown[] {\n' +
        '  return [\n' +
        '    factory.build(queryClient, { mutationFn: () => post() }),\n' +
        '    makeCache().build(queryClient, { mutationFn: () => post() }),\n' +
        '    queryClient.getQueryCache().build(queryClient, { queryFn: () => post() }),\n' +
        '  ];\n' +
        '}\n',
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws rather than reporting clean when the web scope collects nothing', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('/packages/shared/src/index.ts', 'export {};\n');

    expect(() => rule.check(project)).toThrow('empty scope');
  });

  it('throws when the declaration module names no file', () => {
    const project = projectWith(
      {
        '/apps/web/src/hooks/use-thing.ts':
          IMPORTS +
          'export function useThing(): unknown {\n' +
          '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
          '}\n',
      },
      { noModule: true }
    );

    expect(() => rule.check(project)).toThrow(DECLARATION_MODULE);
  });

  it('throws when no mutation carries a key, so the recognizer has gone blind', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-exempt.ts':
        IMPORTS +
        'export function useExempt(): unknown {\n' +
        "  return useMutation({ meta: idempotencyExempt('opaque-protocol'), mutationFn: () => post() });\n" +
        '}\n',
    });

    expect(() => rule.check(project)).toThrow('recognizes no keyed mutation');
  });

  it('throws when no mutation declares an exemption, so that arm is unexercised', () => {
    const project = projectWith({
      '/apps/web/src/hooks/use-keyed.ts':
        IMPORTS +
        'export function useKeyed(): unknown {\n' +
        '  return useMutation({ mutationFn: (v: object) => post(v, idempotentHeaders(v)) });\n' +
        '}\n',
    });

    expect(() => rule.check(project)).toThrow('recognizes no declared exemption');
  });
});

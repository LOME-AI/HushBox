import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './onerror-handler-only-in-app.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/** A Hono app bound to `name`, the receiver every real install has. */
function honoApp(name: string): string {
  return `import { Hono } from 'hono';\nconst ${name} = new Hono();\n`;
}

const APP_TS = 'apps/api/src/app.ts';
const APP_WITH_HANDLER =
  honoApp('base') + 'export const app = base.onError((error, c) => c.json({}, 500));\n';

describe('onerror-handler-only-in-app', () => {
  it('passes when app.ts installs exactly one onError handler', () => {
    const project = projectWith({
      [APP_TS]:
        honoApp('base') +
        'export const app = base.onError((error, c) => c.json({ code: "INTERNAL" }, 500));\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a sub-router that installs its own onError', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/slices/chat/routes.ts':
        honoApp('router') + 'export const sub = router.onError((error, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: '/apps/api/src/slices/chat/routes.ts',
      line: 3,
    });
    expect(violations[0]?.message).toContain('Sub-routers must not install onError');
  });

  it('flags when no onError handler exists in app.ts', () => {
    const project = projectWith({
      [APP_TS]: honoApp('base') + 'export const app = base.notFound((c) => c.json({}, 404));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${APP_TS}`, line: 1 });
    expect(violations[0]?.message).toContain('found none');
  });

  it('flags when app.ts installs more than one onError handler', () => {
    const project = projectWith({
      [APP_TS]:
        honoApp('base') +
        honoApp('other') +
        'const a = base.onError((e, c) => c.json({}, 500));\n' +
        'const b = other.onError((e, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${APP_TS}`, line: 6 });
    expect(violations[0]?.message).toContain('found more than one');
  });

  it('does not trip on object-literal onError properties (workflow policy / streamText option)', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/slices/workflows/builder/ports.ts':
        'export const node = { type: "modelCall", onError: "skip" };\n' +
        'export const agent = { onError: "fail" as const };\n',
      'apps/api/src/slices/models/adapters/language-adapter.ts':
        'const noopOnError = () => {};\n' +
        'export const opts = { onError: noopOnError };\n' +
        'export const branch = node.onError === "skip";\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not trip on an injected callback that happens to be named onError', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/slices/chat/domain/evict.ts':
        'export function evict(deps: Deps, id: string, error: unknown): void {\n' +
        '  deps.onError?.(id, error);\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not trip on an injected onError callback in a package', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'packages/realtime/src/user-rooms.ts':
        'export function evict(deps: Deps, id: string, error: unknown): void {\n' +
        '  deps.onError?.(id, error);\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a Hono onError install outside the api tree', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'packages/realtime/src/gateway.ts':
        honoApp('gateway') + 'export const g = gateway.onError((e, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/packages/realtime/src/gateway.ts', line: 3 });
  });

  it('recognises a Hono app threaded through a middleware wrapper', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/slices/chat/routes.ts':
        honoApp('root') +
        'export const sub = applyPipeline(root, {}).use("/x", guard).onError((e, c) => c.json({}, 500));\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('recognises an aliased Hono import', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/slices/chat/routes.ts':
        "import { Hono as Router } from 'hono';\n" +
        'const sub = new Router();\n' +
        'export const routes = sub.onError((e, c) => c.json({}, 500));\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('follows a chain of local aliases back to the Hono construction', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/slices/chat/routes.ts':
        honoApp('root') +
        'const mounted = root.route("/chat", inner);\n' +
        'const ready = mounted;\n' +
        'export const routes = ready.onError((e, c) => c.json({}, 500));\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('recognises a Hono app constructed inside a function body', () => {
    const project = projectWith({
      [APP_TS]:
        "import { Hono } from 'hono';\n" +
        'export function buildApp() {\n' +
        '  const root = new Hono();\n' +
        '  const base = applyPipeline(root, {}).use("/x", guard).onError((e, c) => c.json({}, 500));\n' +
        '  return base;\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an install on a Hono app received as a parameter', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/middleware/pipeline.ts':
        "import type { Hono } from 'hono';\n" +
        'export function applyPipeline(app: Hono<Env>): Hono<Env> {\n' +
        '  return app.onError((e, c) => c.json({}, 500));\n' +
        '}\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an onError call on a receiver that is not a Hono app', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'packages/shared/src/thing.ts': 'export const x = emitter.onError(() => {});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores non-Hono imports, constructions and parameter types in a file that also imports Hono', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/lib/http/client.ts':
        "import { Context, Hono } from 'hono';\n" +
        "import { z } from 'zod';\n" +
        'export function build(schema: z.ZodType, count: number, c: Context) {\n' +
        '  const emitter = new Emitter();\n' +
        '  return emitter.onError(() => {});\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files that build throwaway apps with their own onError', () => {
    const project = projectWith({
      [APP_TS]: APP_WITH_HANDLER,
      'apps/api/src/middleware/pipeline-session.test.ts':
        honoApp('app') + 'const handled = app.onError((err, c) => c.json({}, 500));\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports only sub-router installs and no missing-handler when app.ts is not in scope', () => {
    const project = projectWith({
      'apps/api/src/slices/chat/routes.ts':
        honoApp('router') + 'export const sub = router.onError((error, c) => c.json({}, 500));\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('Sub-routers must not install onError');
  });
});

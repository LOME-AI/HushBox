import { METHOD_NAME_ALL_LOWERCASE, METHODS } from 'hono/router';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './route-handlers-stay-inferred.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const ROUTES = 'apps/api/src/slices/chat/routes.ts';

/** A registration whose handler says nothing about what it returns. */
const CLEAN_ROUTES =
  "import { Hono } from 'hono';\n" +
  "export const routes = new Hono().get('/clean', (c) => c.json({ ok: true }, 200));\n";

describe('route-handlers-stay-inferred', () => {
  it('flags an inline handler carrying an explicit return-type annotation', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        'export const routes = new Hono()\n' +
        "  .get('/messages', async (c): Promise<Response> => c.json({ items: [] }, 200));\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${ROUTES}`, line: 3 });
    expect(violations[0]?.message).toContain("get '/messages'");
    expect(violations[0]?.message).toContain('Promise<Response>');
  });

  it('flags a hoisted function-declaration handler carrying a return-type annotation', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        'export function sendHandler(c: Context): Response {\n' +
        '  return c.json({ ok: true }, 200);\n' +
        '}\n' +
        "export const routes = new Hono().post('/send', sendHandler);\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${ROUTES}`, line: 2 });
    expect(violations[0]?.message).toContain("post '/send'");
  });

  it('flags a hoisted handler binding that carries its own type annotation', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        'const listHandler: Handler<AppEnv> = (c) => c.json({ items: [] }, 200);\n' +
        "export const routes = new Hono().get('/list', listHandler);\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${ROUTES}`, line: 2 });
    expect(violations[0]?.message).toContain('Handler<AppEnv>');
  });

  it('flags a hoisted arrow handler whose own return type is annotated', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        'const listHandler = (c: Context): Response => c.json({ items: [] }, 200);\n' +
        "export const routes = new Hono().get('/list', listHandler);\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${ROUTES}`, line: 2 });
  });

  it('flags a handler registered through the verb-as-argument spelling', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        'export const routes = new Hono()\n' +
        "  .on('POST', '/rotate', (c): Response => c.json({ ok: true }, 200));\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("post '/rotate'");
  });

  it('flags a function-expression handler carrying a return-type annotation', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        "export const routes = new Hono().get('/list', function (c): Response {\n" +
        '  return c.json({ items: [] }, 200);\n' +
        '});\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an annotated handler under every verb the router exposes', () => {
    for (const verb of [...METHODS, METHOD_NAME_ALL_LOWERCASE]) {
      const project = projectWith({
        [ROUTES]:
          "import { Hono } from 'hono';\n" +
          `export const routes = new Hono().${verb}('/x', (c): Response => c.body(null, 204));\n`,
      });

      expect(rule.check(project), verb).toHaveLength(1);
    }
  });

  it('passes a handler that lets Hono infer its response', () => {
    const project = projectWith({ [ROUTES]: CLEAN_ROUTES });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a handler that returns a bare Response without saying so', () => {
    const project = projectWith({
      [ROUTES]:
        CLEAN_ROUTES +
        "export const stream = new Hono().post('/stream', async (c) => {\n" +
        '  const upstream = await fetch(c.req.url);\n' +
        '  return new Response(upstream.body, { status: 200 });\n' +
        '});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an annotated middleware installed with use', () => {
    const project = projectWith({
      [ROUTES]:
        CLEAN_ROUTES +
        'const guard: MiddlewareHandler = async (c, next): Promise<void> => {\n' +
        '  await next();\n' +
        '};\n' +
        "export const guarded = new Hono().use('*', guard);\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a registration whose handler is produced by a factory call', () => {
    const project = projectWith({
      [ROUTES]:
        CLEAN_ROUTES + "export const built = new Hono().get('/built', makeHandler(deps));\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a handler binding that carries neither a type nor an initializer', () => {
    const project = projectWith({
      [ROUTES]:
        CLEAN_ROUTES +
        'let lateHandler;\n' +
        "export const late = new Hono().get('/late', lateHandler);\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a registration whose handler is declared in another module', () => {
    const project = projectWith({
      [ROUTES]:
        CLEAN_ROUTES +
        "import { sendHandler } from './handlers.js';\n" +
        "export const routes2 = new Hono().post('/send', sendHandler);\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not see a handler declared inside the manifest factory (documented blind spot)', () => {
    const project = projectWith({
      [ROUTES]:
        "import { Hono } from 'hono';\n" +
        'export function createRoutes() {\n' +
        '  const listHandler = (c: Context): Response => c.json({ items: [] }, 200);\n' +
        "  return new Hono().get('/list', listHandler);\n" +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts test files, whose throwaway apps reach no typed client', () => {
    const project = projectWith({
      [ROUTES]: CLEAN_ROUTES,
      'apps/api/src/slices/chat/routes.test.ts':
        "import { Hono } from 'hono';\n" +
        "const app = new Hono().get('/x', (c): Response => c.json({}, 200));\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores routers outside the product Worker tree', () => {
    const project = projectWith({
      [ROUTES]: CLEAN_ROUTES,
      'packages/realtime/src/gateway.ts':
        "import { Hono } from 'hono';\n" +
        "export const gateway = new Hono().get('/ws', (c): Response => c.body(null, 101));\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('aborts when the scanned tree yields no route registration at all', () => {
    const project = projectWith({
      'apps/api/src/lib/nothing.ts': 'export const x = 1;\n',
    });

    expect(() => rule.check(project)).toThrow(/route-handlers-stay-inferred/);
  });
});

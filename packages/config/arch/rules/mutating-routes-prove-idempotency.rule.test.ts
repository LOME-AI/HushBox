import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './mutating-routes-prove-idempotency.rule.js';

function projectWithFiles(files: Readonly<Record<string, string>>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

function projectWith(filePath: string, source: string): Project {
  return projectWithFiles({ [filePath]: source });
}

const ROUTES_PATH = 'apps/api/src/slices/billing/routes.ts';

const ROUTES_GROUP_PATH = 'apps/api/src/slices/billing/routes/things.ts';

const HELPER_SOURCE = `export function runByKey(route) {
  return runMutation(() => idempotent.byKey(route));
}
`;

/** A route group calling a wrapper helper it imports from the named module. */
function groupCalling(specifier: string): string {
  return `import { runByKey } from '${specifier}';
  app.post('/things', routeClass('session'), async (c) => runByKey({ c, execute }));
`;
}

describe('mutating-routes-prove-idempotency', () => {
  it('accepts a POST whose inline handler calls runMutation', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), (c) =>
        runMutation(() => idempotent.byKey({ execute }))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a POST whose inline handler references idempotent.* without a literal runMutation', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), (c) =>
        wrap(idempotent.byUpsert(() => create(c)))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a non-exempt POST whose handler performs a bare DB write with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), async (c) => {
        await db.insert(things).values(c.req.valid('json'));
        return c.json({ ok: true });
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES_PATH, line: 1 });
    expect(violations[0]?.message).toMatch(/runMutation/);
  });

  it('flags a non-exempt PUT with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.put('/things/:id', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-exempt PATCH with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.patch('/things/:id', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-exempt DELETE with no wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.delete('/things/:id', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-exempt ALL route, which registers the mutating verbs too', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.all('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts an ALL route whose inline handler calls runMutation', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.all('/things', routeClass('session'), (c) =>
        runMutation(() => idempotent.byKey({ execute }))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a non-exempt catch-all route, whose path is the bare wildcard', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.all('*', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a non-exempt POST registered through on()', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.on('POST', '/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a POST registered through on() whose handler calls runMutation', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.on('POST', '/things', routeClass('session'), (c) =>
        runMutation(() => idempotent.byKey({ execute }))
      );\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags each verb of an on() registration listing several', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.on(['POST', 'PUT'], '/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(2);
  });

  it('flags each path of an on() registration listing several', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.on('POST', ['/things', '/other'], routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(2);
  });

  it('reads the literal verbs of an on() list past one it cannot resolve', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.on(['POST', configuredVerb], '/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an on() registration under a read-only verb', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.on('GET', '/things', routeClass('session'), (c) => c.json({ things: [] }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a query builder delete, whose argument is a table rather than a path', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/repository.ts',
      `export async function purge(db, id) {
        await db.delete(things).where(eq(things.id, id));
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a delete whose string argument is not a route path', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/repository.ts',
      `export function forget(store) {
        store.delete('session-cache');
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores GET routes', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.get('/things', routeClass('session'), (c) => c.json({ things: [] }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('skips a directly declared-exempt mutating route (the exemption rule proves its wrapper)', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/webhooks/helcim', idempotencyExempt('webhook-event-id'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('skips a mutating route covered by a subtree exemption declaration', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/webhooks/helcim', (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('still flags a non-exempt route outside a subtree exemption prefix', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.use('/webhooks/*', idempotencyExempt('webhook-event-id'));
      app.post('/things', (c) => c.json({ ok: true }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2 });
  });

  it('flags a bare-write route whose exemption marker appears only in a comment', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/webhooks/helcim', async (c) => {
        // idempotencyExempt('webhook-event-id') is applied by the pipeline
        await db.insert(events).values(c.req.valid('json'));
        return c.json({ ok: true });
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a handler that routes through a same-file wrapper helper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `function runByKey(route) {
        return runMutation(() => idempotent.byKey(route));
      }
      app.post('/', routeClass('session'), async (c) => {
        const result = await runByKey({ c, body: c.req.valid('json'), execute });
        return respond200(c, result);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a handler whose wrapper helper is a sibling module of the slice routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/billing/routes/run-by-key.ts': HELPER_SOURCE,
      [ROUTES_GROUP_PATH]: groupCalling('./run-by-key.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a handler whose local helper of the same name performs a bare write', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/billing/routes/run-by-key.ts': HELPER_SOURCE,
      [ROUTES_GROUP_PATH]: `function runByKey(route) {
  return db.insert(things).values(route);
}
app.post('/things', routeClass('session'), async (c) => runByKey({ c, execute }));
`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that names a sibling wrapper helper the module does not import', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/billing/routes/run-by-key.ts': HELPER_SOURCE,
      [ROUTES_GROUP_PATH]: `import { execute } from '../../../lib/execute.js';
  app.post('/things', routeClass('session'), async (c) => runByKey({ c, execute }));
`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler whose wrapper helper sits one directory outside the routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/billing/run-by-key.ts': HELPER_SOURCE,
      [ROUTES_GROUP_PATH]: groupCalling('../run-by-key.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler whose wrapper helper sits in another slice routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/run-by-key.ts': HELPER_SOURCE,
      [ROUTES_GROUP_PATH]: groupCalling('../../conversations/routes/run-by-key.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler whose wrapper helper is declared in a test module of the routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/billing/routes/run-by-key.test.ts': HELPER_SOURCE,
      [ROUTES_GROUP_PATH]: groupCalling('./run-by-key.test.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a handler whose wrapper helper is two hops from the wrapper', () => {
    const project = projectWith(
      ROUTES_PATH,
      `function envelope(run) {
        return runMutation(run);
      }
      function withScope(route) {
        return envelope(() => route.execute());
      }
      function runByKey(route) {
        return withScope(route);
      }
      app.post('/things', routeClass('session'), async (c) => runByKey({ c, execute }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a handler whose helper chain names its next hop only in a comment', () => {
    const project = projectWith(
      ROUTES_PATH,
      `function envelope(run) {
        return runMutation(run);
      }
      function withScope(route) {
        // envelope() is applied by the caller
        return plainWrite(route);
      }
      function runByKey(route) {
        return withScope(route);
      }
      app.post('/things', routeClass('session'), async (c) => runByKey({ c, execute }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that names runMutation only in a comment', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), async (c) => {
        // runMutation(() => write(c))
        await db.insert(things).values(c.req.valid('json'));
        return c.json({ ok: true });
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that names an idempotent wrapper only in a comment', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), async (c) => {
        // idempotent.byUpsert covers this write
        return plain.byUpsert(() => write(c));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that names runMutation only in a string literal', () => {
    const project = projectWith(
      ROUTES_PATH,
      `app.post('/things', routeClass('session'), async (c) => {
        log('runMutation');
        return c.json({ ok: true });
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that names the run-control seam only in a comment', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.post('/', routeClass('session'), async (c) => {
        // deps.realtime(c.env).startRun(conversationId, runStartBody)
        return c.json({ ok: true });
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler whose same-file helper names the wrapper only in a comment', () => {
    const project = projectWith(
      ROUTES_PATH,
      `function runByKey(route) {
        // idempotent.byKey is composed by the shared envelope
        return plainWrite(route);
      }
      app.post('/things', routeClass('session'), async (c) => {
        const result = await runByKey({ c, execute });
        return respond200(c, result);
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a run-initiating handler that routes through the ConversationRoom startRun seam', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.post('/', routeClass('session'), async (c) => {
        const runKey = requiredRunKey(c);
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a stop handler that routes through the stopRun seam', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.post('/stop', routeClass('session'), async (c) => {
        const stopped = await deps.realtime(c.env).stopRun(conversationId);
        return stopped.match(onOk, onErr);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a resolved same-file named handler that wraps', () => {
    const project = projectWith(
      ROUTES_PATH,
      `const handleThing = (c) => runMutation(() => idempotent.byKey({ execute }));
      app.post('/things', routeClass('session'), handleThing);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a mutating route whose handler is imported from another file (unprovable)', () => {
    const project = projectWith(
      ROUTES_PATH,
      `import { handleThing } from './handlers.js';
      app.post('/things', routeClass('session'), handleThing);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/another file/);
  });

  it('names the routes directory the wrapper helper may sit in when it refuses a foreign handler', () => {
    const project = projectWith(
      ROUTES_PATH,
      `import { handleThing } from './handlers.js';
      app.post('/things', routeClass('session'), handleThing);\n`
    );

    expect(rule.check(project)[0]?.message).toMatch(/routes directory/);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/routes.test.ts',
      `app.post('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores spec files', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/routes.spec.ts',
      `app.post('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'packages/shared/src/notes.ts',
      `app.post('/things', routeClass('session'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});

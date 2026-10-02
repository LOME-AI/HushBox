import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './paid-turn-routes-prove-payer-seam.rule.js';

const CHAT_PATH = 'apps/api/src/slices/chat/routes.ts';

const SEAM = `async function resolveGatedTurnContext(c, deps, body, caller) {
  const resolved = await resolveTurnContext({ conversations: deps.conversations }, c.var.db, body);
  if (resolved.isErr()) return respondDomainError(c, resolved.error);
  return resolved.value;
}`;

/** A slice whose routes live in group modules: the registration, the marker, and the seam apart. */
const CHAT_GROUP = 'apps/api/src/slices/chat/routes/';

/**
 * The route-group layout the rule pins itself to, so every fixture stands where
 * the repository does. Each seed is inert — no registration, no paid marker, no
 * payer-resolution call — and a fixture writing one of these paths replaces it.
 */
const LAYOUT: Record<string, string> = {
  [CHAT_PATH]: 'export {};\n',
  [`${CHAT_GROUP}payer-seam.ts`]: `export const RUN_KEY_HEADER = 'x-run-key';\n`,
};

function projectWithFiles(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries({ ...LAYOUT, ...files })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

function projectWith(filePath: string, source: string): Project {
  return projectWithFiles({ [filePath]: source });
}

const SEAM_MODULE = `export ${SEAM}\n`;

const RUN_BODY_MODULE = `export function paidRunStartBody(run) {
  return { mode: 'paid', runKey: run.runKey, userId: run.context.payerUserId };
}
`;

/** A registration whose only paid marker is the run body it takes from another module. */
function sendRoute(bodySpecifier: string, resolution: string): string {
  return `import { paidRunStartBody } from '${bodySpecifier}';
      app.post('/', routeClass('session'), async (c) => {
        ${resolution}
        return respondRunStart(c, deps.realtime(c.env).startRun(id, paidRunStartBody(run)));
      });
`;
}

/** The same registration, taking its run body under the given import clause and local name. */
function importingSendRoute(clause: string, bodySpecifier: string, callee: string): string {
  return `import ${clause} from '${bodySpecifier}';
      app.post('/', routeClass('session'), async (c) => {
        const context = await ownPayerContext(c, body);
        return respondRunStart(c, deps.realtime(c.env).startRun(id, ${callee}(run)));
      });
`;
}

/** The registration taking the sibling's run body under a local name of its own. */
function aliasedSendRoute(bodySpecifier: string): string {
  return importingSendRoute(
    '{ paidRunStartBody as buildRunStartBody }',
    bodySpecifier,
    'buildRunStartBody'
  );
}

/** A group module publishing a sibling's run body under a name of its own choosing. */
const RENAMING_REEXPORT = `export { paidRunStartBody as buildRunStartBody } from './run-body.js';\n`;

/** A group module re-binding its own run body declaration to a second name. */
const REBINDING_DECLARATION = `${RUN_BODY_MODULE}
export const buildRunStartBody = paidRunStartBody;
`;

/** A group module re-binding a sibling's run body to a name of its own instead of renaming it. */
const REBINDING_MODULE = `import { paidRunStartBody } from './run-body.js';

export const buildRunStartBody = paidRunStartBody;
`;

const DEFAULT_BODY_MODULE = `export default function paidRunStartBody(run) {
  return { mode: 'paid', runKey: run.runKey, userId: run.context.payerUserId };
}
`;

const DEFAULT_NAMING_DECLARATION = `function paidRunStartBody(run) {
  return { mode: 'paid', runKey: run.runKey, userId: run.context.payerUserId };
}

export default paidRunStartBody;
`;

const DEFAULT_EXPRESSION = `export default (run) => ({ mode: 'paid', runKey: run.runKey });\n`;

/** A module filling its own default slot with an export statement beside the declaration. */
const DEFAULT_BY_STATEMENT = `function paidRunStartBody(run) {
  return { mode: 'paid', runKey: run.runKey, userId: run.context.payerUserId };
}

export { paidRunStartBody as default };
`;

/** A group module whose default slot is a class carrying the run body as a static. */
const DEFAULT_CLASS_MODULE = `export default class RunBodies {
  static paid = { mode: 'paid', runKey: 'k' };
}
`;

/** The registration taking a sibling's default export under a local name. */
function defaultImportingSendRoute(bodySpecifier: string): string {
  return importingSendRoute('buildRunStartBody', bodySpecifier, 'buildRunStartBody');
}

/** The registration taking a name a sibling publishes by renaming it on the way out. */
function reexportImportingSendRoute(bodySpecifier: string): string {
  return importingSendRoute('{ buildRunStartBody }', bodySpecifier, 'buildRunStartBody');
}

const THROUGH_SEAM = 'const context = await resolveGatedTurnContext(c, deps, body, caller);';
const OWN_PAYER = 'const context = await ownPayerContext(c, body);';

/** The chat slice as a split leaves it: registration, marker and seam in three group modules. */
function groupModuleProject(resolution: string): Project {
  return projectWithFiles({
    [`${CHAT_GROUP}payer-seam.ts`]: SEAM_MODULE,
    [`${CHAT_GROUP}run-body.ts`]: RUN_BODY_MODULE,
    [`${CHAT_GROUP}send-routes.ts`]: sendRoute('./run-body.js', resolution),
  });
}

/** A slice registering in `routes.ts` whose run body sits at the given module instead. */
function splitMarkerProject(runBodyPath: string): Project {
  return projectWithFiles({
    [runBodyPath]: RUN_BODY_MODULE,
    [CHAT_PATH]: sendRoute('./routes/run-body.js', OWN_PAYER),
  });
}

describe('paid-turn-routes-prove-payer-seam', () => {
  it('holds a slice whose routes live in group modules inside its scope', () => {
    expect(rule.check(groupModuleProject(THROUGH_SEAM))).toEqual([]);
    expect(rule.check(groupModuleProject(OWN_PAYER))).toHaveLength(1);
  });

  it('scopes a route whose run body is declared in a sibling module of its routes directory', () => {
    const violations = rule.check(splitMarkerProject(`${CHAT_GROUP}run-body.ts`));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CHAT_PATH });
    expect(violations[0]?.message).toMatch(/resolveGatedTurnContext/);
  });

  it('scopes a route whose sibling run body is bound under a local name', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: RUN_BODY_MODULE,
      [CHAT_PATH]: aliasedSendRoute('./routes/run-body.js'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CHAT_PATH });
  });

  it('does not scope a route by an aliased run body from another slice routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/run-body.ts': RUN_BODY_MODULE,
      [CHAT_PATH]: aliasedSendRoute('../conversations/routes/run-body.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('scopes a route whose run body reaches it through a renamed re-export in the group', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: RUN_BODY_MODULE,
      [`${CHAT_GROUP}bodies.ts`]: RENAMING_REEXPORT,
      [CHAT_PATH]: reexportImportingSendRoute('./routes/bodies.js'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CHAT_PATH });
  });

  it('scopes a group module whose run body reaches it through a renamed re-export', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: RUN_BODY_MODULE,
      [`${CHAT_GROUP}bodies.ts`]: RENAMING_REEXPORT,
      [`${CHAT_GROUP}send-routes.ts`]: reexportImportingSendRoute('./bodies.js'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `${CHAT_GROUP}send-routes.ts` });
  });

  /**
   * Pins the rebound-value example of this rule's boundary section in its
   * module-local spelling: any reader widened to follow the binding reddens this.
   */
  it('does not scope a route by a run body its own module re-binds to a second name', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: REBINDING_DECLARATION,
      [CHAT_PATH]: reexportImportingSendRoute('./routes/run-body.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  /**
   * The same example with the binding crossing an import, which the module-local
   * case survives: only a reader widened to follow it into another module reddens this.
   */
  it('does not scope a route by a run body a group module re-binds to its own name', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: RUN_BODY_MODULE,
      [`${CHAT_GROUP}bodies.ts`]: REBINDING_MODULE,
      [CHAT_PATH]: reexportImportingSendRoute('./routes/bodies.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('scopes a route whose run body is a sibling default export', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BODY_MODULE,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/run-body.js'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CHAT_PATH });
  });

  it('scopes a group module whose run body is a sibling default export', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BODY_MODULE,
      [`${CHAT_GROUP}send-routes.ts`]: defaultImportingSendRoute('./run-body.js'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `${CHAT_GROUP}send-routes.ts` });
  });

  it('scopes a route whose sibling defaults to a declaration it names', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_NAMING_DECLARATION,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/run-body.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route whose sibling defaults to an inline run body', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_EXPRESSION,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/run-body.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route taking a sibling default export as a named specifier', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BODY_MODULE,
      [CHAT_PATH]: importingSendRoute(
        '{ default as buildRunStartBody }',
        './routes/run-body.js',
        'buildRunStartBody'
      ),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route whose sibling re-exports a run body into its default slot', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: RUN_BODY_MODULE,
      [`${CHAT_GROUP}bodies.ts`]: `export { paidRunStartBody as default } from './run-body.js';\n`,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/bodies.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route whose sibling forwards another module default slot', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BODY_MODULE,
      [`${CHAT_GROUP}index.ts`]: `export { default } from './run-body.js';\n`,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/index.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route whose sibling forwards a default slot under a name', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BODY_MODULE,
      [`${CHAT_GROUP}index.ts`]: `export { default as buildRunStartBody } from './run-body.js';\n`,
      [CHAT_PATH]: reexportImportingSendRoute('./routes/index.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not scope a route by a default slot forwarded from outside the group', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/chat/domain/run-body.ts': DEFAULT_BODY_MODULE,
      [`${CHAT_GROUP}index.ts`]: `export { default } from '../domain/run-body.js';\n`,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/index.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not scope a route by a default forward whose module the project lacks', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}index.ts`]: `export { default } from './missing.js';\n`,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/index.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('scopes a route whose sibling forwards a default slot filled by an export statement', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BY_STATEMENT,
      [`${CHAT_GROUP}index.ts`]: `export { default as buildRunStartBody } from './run-body.js';\n`,
      [CHAT_PATH]: reexportImportingSendRoute('./routes/index.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route taking a default slot an export statement fills', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BY_STATEMENT,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/run-body.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not scope a route by a default slot forwarded through two group modules', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_BODY_MODULE,
      [`${CHAT_GROUP}index.ts`]: `export { default } from './run-body.js';\n`,
      [`${CHAT_GROUP}barrel.ts`]: `export { default } from './index.js';\n`,
      [CHAT_PATH]: defaultImportingSendRoute('./routes/barrel.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  /**
   * Pins the class example of this rule's boundary section: a reader widened to
   * admit a class in the default slot reddens this case instead of falsifying it.
   */
  it('does not scope a route by a paid run body a default-exported class holds', () => {
    const project = projectWithFiles({
      [`${CHAT_GROUP}run-body.ts`]: DEFAULT_CLASS_MODULE,
      [CHAT_PATH]: `import RunBodies from './routes/run-body.js';
      app.post('/', routeClass('session'), async (c) => {
        const context = await ownPayerContext(c, body);
        return respondRunStart(c, deps.realtime(c.env).startRun(id, RunBodies.paid));
      });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not scope a route by a run body under a different slice routes directory', () => {
    const project = splitMarkerProject('apps/api/src/slices/conversations/routes/run-body.ts');

    expect(rule.check(project)).toEqual([]);
  });

  it('does not scope a route by a run body declared only in a test module', () => {
    const project = splitMarkerProject(`${CHAT_GROUP}run-body.test.ts`);

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a seamless paid route registered in a group module of its own', () => {
    const project = projectWith(
      `${CHAT_GROUP}send-routes.ts`,
      `app.post('/', routeClass('session'), async (c) => {
        const context = await ownPayerContext(c, body);
        const runStartBody = { mode: 'paid', runKey, userId: context.payerUserId };
        return respondRunStart(c, deps.realtime(c.env).startRun(id, runStartBody));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a paid turn route that resolves its context through the seam', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/', routeClass('session'), async (c) => {
        const context = await resolveGatedTurnContext(c, deps, body, caller);
        if (context instanceof Response) return context;
        const runStartBody = { mode: 'paid', runKey, userId: context.payerUserId };
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a paid turn route that starts a paid run without the seam', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/guest', routeClass('public'), async (c) => {
        const context = await resolveTurnContextDirectly(c, body);
        const runStartBody = { mode: 'paid', runKey, userId: context.payerUserId };
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CHAT_PATH, line: 6 });
    expect(violations[0]?.message).toMatch(/resolveGatedTurnContext/);
  });

  it('does not accept a seam named only in a comment in the handler', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/regenerate', routeClass('session'), async (c) => {
        // resolveGatedTurnContext ran in middleware.
        const context = await ownPayerContext(c, body);
        const runStartBody = { mode: 'paid', runKey, userId: context.payerUserId };
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/resolveGatedTurnContext/);
  });

  it('accepts a trial route, which resolves no payer', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/trial', routeClass('public'), async (c) => {
        const runStartBody = { mode: 'trial', runKey, sessionId: principal.sessionId };
        return respondTrialRunStart(c, deps.realtime(c.env).startRun(room, runStartBody), id);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a paid route whose run body is built by a same-file helper', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      function paidRunBody(context, runKey) {
        return { mode: 'paid', runKey, userId: context.payerUserId };
      }
      app.post('/', routeClass('session'), async (c) => {
        const context = await resolveGatedTurnContext(c, deps, body, caller);
        return respondRunStart(c, deps.realtime(c.env).startRun(id, paidRunBody(context, runKey)));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a paid route whose helper builds the paid run body while the seam is absent', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      function paidRunBody(context, runKey) {
        return { mode: 'paid', runKey, userId: context.payerUserId };
      }
      app.post('/', routeClass('session'), async (c) => {
        return respondRunStart(c, deps.realtime(c.env).startRun(id, paidRunBody(context, runKey)));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('scopes a route whose run mode is chosen by a conditional rather than a literal', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/send', routeClass('session'), async (c) => {
        const context = await ownPayerContext(c, body);
        const runStartBody = { mode: isTrial ? 'trial' : 'paid', runKey, userId: context.payerUserId };
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/resolveGatedTurnContext/);
  });

  it('scopes a route whose same-file helper chooses the run mode conditionally', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      function runBody(context, runKey, isTrial) {
        return { mode: isTrial ? 'trial' : 'paid', runKey, userId: context.payerUserId };
      }
      app.post('/send', routeClass('session'), async (c) => {
        return respondRunStart(c, deps.realtime(c.env).startRun(id, runBody(context, runKey, false)));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('does not scope a route whose paid mode appears only in a comment', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/trial', routeClass('public'), async (c) => {
        // A trial turn is never mode: 'paid', so it resolves no payer.
        const runStartBody = { mode: 'trial', runKey, sessionId: principal.sessionId };
        return respondTrialRunStart(c, deps.realtime(c.env).startRun(room, runStartBody), id);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('does not scope a route that names the paid mode only in a type position', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      app.post('/trial', routeClass('public'), async (c) => {
        const runStartBody: Extract<RunStartBody, { mode: 'paid' }>['regenerate'] = undefined;
        return respondTrialRunStart(c, deps.realtime(c.env).startRun(room, runStartBody), id);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the single payer-resolution call site inside the seam', () => {
    const project = projectWith(CHAT_PATH, `${SEAM}\n`);

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a second payer-resolution call site', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      async function resolveRegenerateContext(c, body) {
        return resolveTurnContext({ conversations: deps.conversations }, c.var.db, body);
      }\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations[0]?.message).toMatch(/one call site/);
  });

  it('flags a second payer-resolution call site in another api file', () => {
    const project = projectWithFiles({
      [CHAT_PATH]: `${SEAM}\n`,
      'apps/api/src/slices/chat/routes-extra.ts': `const context = await resolveTurnContext(deps, db, body);\n`,
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('ignores payer-resolution calls in test files', () => {
    const project = projectWithFiles({
      [CHAT_PATH]: `${SEAM}\n`,
      'apps/api/src/slices/chat/routes.test.ts': `const context = await resolveTurnContext(deps, db, body);\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a paid run body outside a route registration', () => {
    const project = projectWith(
      CHAT_PATH,
      `${SEAM}
      const template = { mode: 'paid', runKey: 'k' };\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a route whose handler lives in another file (no paid marker is visible)', () => {
    const project = projectWith(
      CHAT_PATH,
      `import { startTurn } from './handlers.js';
      app.post('/', routeClass('session'), startTurn);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when no slice writes its routes where the marker scope looks', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile('services/api/src/slices/chat/routes.ts', `${SEAM}\n`);

    expect(() => rule.check(project)).toThrow(/names no file/);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'packages/realtime/src/room-core.ts',
      `app.post('/', async (c) => {
        const runStartBody = { mode: 'paid', runKey };
        return startRun(id, runStartBody);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});

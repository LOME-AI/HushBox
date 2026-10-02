import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './public-routes-prove-authorization.rule.js';

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

const CONVERSATIONS_PATH = 'apps/api/src/slices/conversations/routes.ts';
const MEDIA_PATH = 'apps/api/src/slices/media/routes.ts';

const CONVERSATIONS_GROUP_PATH = 'apps/api/src/slices/conversations/routes/members.ts';

const GATE_HELPER_SOURCE = `export async function authorizeCaller(deps, c, conversationId) {
  return resolveConversationCaller({ principal: c.var.principal, linkResolution: deps });
}
`;

/**
 * A gate helper long enough that its declaration spans the offsets a
 * registration in another module occupies, plus an export the group does not
 * import.
 */
const SPANNING_GATE_HELPER_SOURCE = `export async function authorizeCaller(deps, c, conversationId) {
  const principal = c.var.principal;
  const linkResolution = deps.linkResolution;
  const resolved = await resolveConversationCaller({ principal, linkResolution, conversationId });
  if (resolved instanceof Response) return resolved;
  return resolved;
}
export function respondForbidden(c) {
  return c.json({ code: 'FORBIDDEN' }, 403);
}
`;

/** A route group calling a gate helper it imports from the named module. */
function groupCalling(specifier: string): string {
  return `import { authorizeCaller } from '${specifier}';
  app.get('/:conversationId/members', routeClass('public'), async (c) => {
    const caller = await authorizeCaller(deps, c, conversationId);
    return respond200(c, caller);
  });
`;
}

describe('public-routes-prove-authorization', () => {
  it('accepts a public :conversationId route whose inline handler resolves the caller', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId', routeClass('public'), async (c) => {
        const resolved = await resolveConversationCaller({ principal: c.var.principal });
        return respond200(c, resolved);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a public :conversationId route routed through a same-file gate helper', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `async function authorizeCaller(deps, c, conversationId) {
        return resolveConversationCaller({ principal: c.var.principal, linkResolution: deps });
      }
      app.get('/:conversationId/members', routeClass('public'), async (c) => {
        const caller = await authorizeCaller(deps, c, conversationId);
        if (caller instanceof Response) return caller;
        return respond200(c, caller);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a public :conversationId route routed through a gate helper in a sibling routes module', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: groupCalling('./authorize.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a public :conversationId route whose gate helper is imported under another name', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: `import { authorizeCaller as gate } from './authorize.js';
  app.get('/:conversationId/members', routeClass('public'), async (c) => {
    const caller = await gate(deps, c, conversationId);
    return respond200(c, caller);
  });
`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a route whose sibling gate helper spans the offsets the registration occupies in its own module', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': SPANNING_GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: groupCalling('./authorize.js'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a route whose handler calls a local helper of its own that never resolves a caller', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: `function authorizeCaller(c) {
  return { ok: true };
}
app.get('/:conversationId/members', routeClass('public'), async (c) => {
  const caller = await authorizeCaller(c);
  return respond200(c, caller);
});
`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a route whose handler names a sibling gate helper the module does not import', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: `import { respond200 } from '../../../lib/respond.js';
  app.get('/:conversationId/members', routeClass('public'), async (c) => {
    const caller = await authorizeCaller(deps, c, conversationId);
    return respond200(c, caller);
  });
`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a route whose gate helper name arrives on a type-only import declaration', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: `import type { authorizeCaller } from './authorize.js';
  app.get('/:conversationId/members', routeClass('public'), async (c) => {
    const caller = await authorizeCaller(deps, c, conversationId);
    return respond200(c, caller);
  });
`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a route whose gate helper name arrives on a type-only import specifier', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: `import { type authorizeCaller } from './authorize.js';
  app.get('/:conversationId/members', routeClass('public'), async (c) => {
    const caller = await authorizeCaller(deps, c, conversationId);
    return respond200(c, caller);
  });
`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a route whose gate helper sits one directory outside the routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: groupCalling('../authorize.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a route whose gate helper sits in another slice routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/media/routes/authorize.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: groupCalling('../../media/routes/authorize.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a route whose gate helper is declared in a test module of the routes directory', () => {
    const project = projectWithFiles({
      'apps/api/src/slices/conversations/routes/authorize.test.ts': GATE_HELPER_SOURCE,
      [CONVERSATIONS_GROUP_PATH]: groupCalling('./authorize.test.js'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('names the routes directory a gate helper may sit in when it refuses a route', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId/messages', routeClass('public'), async (c) => {
        const messages = await readMessages(deps.stores(c.var.db), { conversationId });
        return respond200(c, messages);
      });\n`
    );

    expect(rule.check(project)[0]?.message).toMatch(/routes directory/);
  });

  it('names the routes directory a gate helper may sit in when it refuses a foreign handler', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `import { readConversation } from './handlers.js';
      app.get('/:conversationId', routeClass('public'), readConversation);\n`
    );

    expect(rule.check(project)[0]?.message).toMatch(/routes directory/);
  });

  it('accepts a public credential-reading route whose handler resolves the media caller', () => {
    const project = projectWith(
      MEDIA_PATH,
      `app.get('/:contentItemId/download-url', routeClass('public'),
        rateLimitByCaller(limits.download, { credentialHeader: LINK_CREDENTIAL_HEADER }),
        async (c) => {
          const caller = await resolveMediaCaller({
            principal: c.var.principal,
            linkCredential: c.req.header(LINK_CREDENTIAL_HEADER),
          });
          return respond200(c, caller);
        });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a public :conversationId route whose handler never resolves a caller', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId/messages', routeClass('public'), async (c) => {
        const messages = await readMessages(deps.stores(c.var.db), { conversationId });
        return respond200(c, messages);
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CONVERSATIONS_PATH, line: 1 });
    expect(violations[0]?.message).toMatch(/resolveConversationCaller/);
  });

  it('flags a public mutating :conversationId route whose handler never resolves a caller', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.patch('/:conversationId/my-name', routeClass('public'), async (c) => {
        return respond200(c, await renameMember(deps.stores(c.var.db), c.req.valid('json')));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a public route that still names the link credential after its gate call is deleted', () => {
    const project = projectWith(
      MEDIA_PATH,
      `app.get('/:contentItemId/download-url', routeClass('public'),
        rateLimitByCaller(limits.download, { credentialHeader: LINK_CREDENTIAL_HEADER }),
        async (c) => {
          const minted = await mintDownloadUrl(mintDeps(deps, c), contentItemId);
          return respond200(c, minted);
        });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/link credential/);
  });

  it('flags a public route that reads a conversation id from its body without resolving the caller', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.post('/guest', routeClass('public'), async (c) => {
        const body = c.req.valid('json');
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/conversation id/);
  });

  it('accepts a public route that reads a conversation id from its body and resolves the caller', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `async function resolveGuestSenderOrRefusal(c, deps, conversationId) {
        return resolveConversationCaller({ principal: c.var.principal, linkResolution: deps });
      }
      app.post('/guest', routeClass('public'), async (c) => {
        const body = c.req.valid('json');
        const gated = await resolveGuestSenderOrRefusal(c, deps, body.conversationId);
        if (gated instanceof Response) return gated;
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('does not scope a route on a conversation id named only in a comment', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `app.get('/trial/websocket', routeClass('public'), async (c) => {
        // The paid socket is keyed by a conversationId, which a trial session lacks.
        return upgrade(c, deps.trialRoomName(principal.sessionId));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('does not accept a gate named only in a comment in the handler', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId/funding', routeClass('public'), async (c) => {
        // resolveConversationCaller is applied downstream.
        return respond200(c, await readFunding(deps.stores(c.var.db), { conversationId }));
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never resolves its caller/);
  });

  it('does not accept a gate helper that names the gate only in a comment', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `async function authorizeCaller(deps, c, conversationId) {
        // resolveConversationCaller runs for this subtree already.
        return callerFromPrincipal(c.var.principal);
      }
      app.get('/:conversationId/members', routeClass('public'), async (c) => {
        const caller = await authorizeCaller(deps, c, conversationId);
        return respond200(c, caller);
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never resolves its caller/);
  });

  it('does not accept a gate helper named only in a comment in the handler', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `async function authorizeCaller(deps, c, conversationId) {
        return resolveConversationCaller({ principal: c.var.principal, linkResolution: deps });
      }
      app.get('/:conversationId/members', routeClass('public'), async (c) => {
        // authorizeCaller runs in middleware for this subtree.
        return respond200(c, callerFromPrincipal(c.var.principal));
      });\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never resolves its caller/);
  });

  it('flags a public route naming the credential header as a bare string literal', () => {
    const project = projectWith(
      MEDIA_PATH,
      `app.get('/thumbnail', routeClass('public'), async (c) => {
        const credential = c.req.header('x-link-auth');
        return respond200(c, await readThumbnail(credential));
      });\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a public route that neither takes a conversation id nor names the credential', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/shared/message/:shareId', routeClass('public'), async (c) => {
        const result = await readSharedMessage(deps.stores(c.var.db), { shareId });
        return respond200(c, result);
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('does not pull an anonymous route into scope because a sibling in the chain names the credential', () => {
    const project = projectWith(
      MEDIA_PATH,
      `const routes = new Hono()
        .get('/:contentItemId/download-url', routeClass('public'),
          rateLimitByCaller(limits.download, { credentialHeader: LINK_CREDENTIAL_HEADER }),
          async (c) => resolveMediaCaller({ principal: c.var.principal }))
        .get('/shared/:shareId/:contentItemId/download-url', routeClass('public'),
          async (c) => respond200(c, await mintDownloadUrl(mintDeps(deps, c), contentItemId)));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a session-classed :conversationId route (the pipeline authorizes it)', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId/forks', routeClass('session'), async (c) => {
        return respond200(c, await listForks(deps.stores(c.var.db), { conversationId }));
      });\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a route with no class declaration at all', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId/forks', async (c) => c.json({ forks: [] }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('covers a route declared public by a same-file subtree use', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.use('/guest/*', routeClass('public'));
      app.get('/guest/:conversationId', async (c) => c.json({ conversationId }));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2 });
  });

  it('leaves a route outside the subtree public prefix unclassified', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.use('/guest/*', routeClass('public'));
      app.get('/:conversationId', async (c) => c.json({ conversationId }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('reads the route class from a routeClass argument that follows other middleware', () => {
    const project = projectWith(
      MEDIA_PATH,
      `app.get('/:contentItemId/download-url',
        rateLimitByCaller(limits.download, { credentialHeader: LINK_CREDENTIAL_HEADER }),
        routeClass('public'),
        async (c) => respond200(c, await mintDownloadUrl(mintDeps(deps, c), contentItemId)));\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/link credential/);
  });

  it('covers a subtree public prefix written without a wildcard', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.use('/guest', routeClass('public'));
      app.get('/guest', async (c) => c.json({ conversationId }));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a subtree declaration for another route class', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.use('/guest/*', routeClass('session'));
      app.get('/guest/:conversationId', async (c) => c.json({ conversationId }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('classifies nothing from a subtree prefix that is not a string literal', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.use(GUEST_PREFIX, routeClass('public'));
      app.get('/guest/:conversationId', async (c) => c.json({ conversationId }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a subtree-public registration carrying no handler at all', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.use('/guest/*', routeClass('public'));
      app.get('/guest/:conversationId');\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('resolves an identifier handler that names a same-file function declaration', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `export default function () {}
      async function readConversation(c) {
        return resolveConversationCaller({ principal: c.var.principal });
      }
      app.get('/:conversationId', routeClass('public'), readConversation);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a resolved same-file named handler that resolves the caller', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `const readConversation = async (c) => resolveConversationCaller({ principal: c.var.principal });
      app.get('/:conversationId', routeClass('public'), readConversation);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('scopes a body-reading route whose handler is hoisted into a same-file const', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `const sendHandler = async (c) => {
        const body = c.req.valid('json');
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, runStartBody));
      };
      app.post('/send', routeClass('public'), sendHandler);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/conversation id/);
  });

  it('scopes a credential-naming route whose handler is hoisted into a same-file const', () => {
    const project = projectWith(
      MEDIA_PATH,
      `const thumbnailHandler = async (c) => {
        const credential = c.req.header(LINK_CREDENTIAL_HEADER);
        return respond200(c, await readThumbnail(credential));
      };
      app.get('/thumbnail', routeClass('public'), thumbnailHandler);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/link credential/);
  });

  it('accepts a hoisted body-reading handler that resolves the caller', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/routes.ts',
      `const sendHandler = async (c) => {
        const body = c.req.valid('json');
        const caller = await resolveConversationCaller({ principal: c.var.principal });
        return respondRunStart(c, deps.realtime(c.env).startRun(body.conversationId, caller));
      };
      app.post('/send', routeClass('public'), sendHandler);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a public :conversationId route whose handler lives in another file', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `import { readConversation } from './handlers.js';
      app.get('/:conversationId', routeClass('public'), readConversation);\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/another file/);
  });

  it('flags a public :conversationId registration with no handler argument', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `app.get('/:conversationId', routeClass('public'));\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a Map.delete call that is not a route registration', () => {
    const project = projectWith(
      CONVERSATIONS_PATH,
      `const cache = new Map();
      cache.delete(conversationId);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/conversations/routes.test.ts',
      `app.get('/:conversationId', routeClass('public'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith(
      'apps/web/src/lib/api-client.ts',
      `app.get('/:conversationId', routeClass('public'), (c) => c.json({ ok: true }));\n`
    );

    expect(rule.check(project)).toEqual([]);
  });
});

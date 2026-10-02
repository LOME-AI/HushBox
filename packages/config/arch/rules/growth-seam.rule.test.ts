import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './growth-seam.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('growth-seam', () => {
  describe('growth tables carry no account column', () => {
    it('flags a growth-owned table declaring a user_id column', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { users } from './users';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  id: uuid('id').primaryKey(),\n" +
          "  userId: uuid('user_id').references(() => users.id),\n" +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'packages/db/src/schema/growth-visitors.ts',
        line: 3,
      });
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('passes a growth-owned table whose only reference is another growth table', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-hourly-events.ts':
          "import { pgTable, text, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { campaigns } from './campaigns';\n" +
          "export const growthHourlyEvents = pgTable('growth_hourly_events', {\n" +
          "  id: uuid('id').primaryKey(),\n" +
          "  campaign: text('campaign').references(() => campaigns.tag),\n" +
          '});\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes an identity-owned table declaring a user_id column', () => {
      const project = projectWith({
        'packages/db/src/schema/user-acquisition.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { users } from './users';\n" +
          "export const userAcquisition = pgTable('user_acquisition', {\n" +
          "  userId: uuid('user_id').references(() => users.id),\n" +
          '});\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a growth-owned table referencing the account table under an alias', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { users as accounts } from './users';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  ownerId: uuid('owner_id').references(() => accounts.id),\n" +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table declared through an aliased table factory', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable as table, uuid } from 'drizzle-orm/pg-core';\n" +
          "export const growthVisitors = table('growth_visitors', {\n" +
          "  userId: uuid('user_id'),\n" +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table whose definition is wrapped in a call chain', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  userId: uuid('user_id'),\n" +
          '}).enableRLS();\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table behind a type assertion', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  userId: uuid('user_id'),\n" +
          '}) as unknown as never;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table declared under a local name and exported renamed', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "const rows = pgTable('growth_visitors', {\n" +
          "  userId: uuid('user_id'),\n" +
          '});\n' +
          'export { rows as growthVisitors };\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table whose account column arrives in a spread', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { users } from './users';\n" +
          'const owner = {\n' +
          "  ownerId: uuid('owner_id').references(() => users.id),\n" +
          '};\n' +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  id: uuid('id').primaryKey(),\n" +
          '  ...owner,\n' +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table declared through a namespace table factory', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import * as pg from 'drizzle-orm/pg-core';\n" +
          "export const growthVisitors = pg.pgTable('growth_visitors', {\n" +
          "  userId: pg.uuid('user_id'),\n" +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned schema declaration this rule cannot read as a table', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { growthTable } from './helpers';\n" +
          "export const growthVisitors = growthTable('growth_visitors', {});\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned table whose column group cannot be resolved', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { columnsFrom } from './helpers';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  id: uuid('id').primaryKey(),\n" +
          "  ...columnsFrom('users'),\n" +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned name the schema declares as something other than a table', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts': 'export const growthVisitors = [];\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned table spreading a column group from another file', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { ownerColumns } from './columns';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          "  id: uuid('id').primaryKey(),\n" +
          '  ...ownerColumns,\n' +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned table whose column groups spread each other', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { users } from './users';\n" +
          'const owner = { ...person };\n' +
          "const person = { ownerId: uuid('owner_id').references(() => users.id), ...owner };\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          '  ...owner,\n' +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table whose column name is written in backticks', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          '  ownerId: uuid(`user_id`),\n' +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('growthVisitors');
    });

    it('flags a growth-owned table whose column name is assembled from a template', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { suffix } from './naming';\n" +
          "export const growthVisitors = pgTable('growth_visitors', {\n" +
          '  ownerId: uuid(`user_${suffix}`),\n' +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned table taking its columns from a call', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable } from 'drizzle-orm/pg-core';\n" +
          "import { columnsFor } from './helpers';\n" +
          "export const growthVisitors = pgTable('growth_visitors', columnsFor('growth'));\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned table taking its columns from a function beside it', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { pgTable, uuid } from 'drizzle-orm/pg-core';\n" +
          "import { users } from './users';\n" +
          'function columns() {\n' +
          "  return { userId: uuid('user_id').references(() => users.id) };\n" +
          '}\n' +
          "export const growthVisitors = pgTable('growth_visitors', columns());\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it('flags a growth-owned table name bound by a destructuring', () => {
      const project = projectWith({
        'packages/db/src/schema/growth-visitors.ts':
          "import { tables } from './generated';\n" + 'export const { growthVisitors } = tables;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot read');
    });

    it("passes a list sharing a growth table's name outside the schema", () => {
      const project = projectWith({
        'apps/admin/src/routes/growth-page.ts': "export const campaigns = ['spring', 'summer'];\n",
      });

      expect(rule.check(project)).toEqual([]);
    });

    it("passes a constant sharing a growth table's name outside the schema", () => {
      const project = projectWith({
        'apps/admin/src/routes/growth-page.ts':
          "import { listCampaigns } from './api';\n" +
          'export const campaigns = listCampaigns();\n',
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('the growth route resolves no principal', () => {
    it('flags a beacon handler reading the principal off the context', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    const who = c.var.principal;\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'apps/api/src/slices/growth/routes.ts',
        line: 4,
      });
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('flags a growth route whose handler is declared in another file', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          "import { beacon } from './beacon-handler.js';\n" +
          "export const growthRoutes = new Hono().post('/', beacon);\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot be resolved');
    });

    it('flags a beacon handler asking the context for the principal by name', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          "    const who = c.get('principal');\n" +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('flags a beacon handler asking the context for the principal in backticks', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    const who = c.get(`principal`);\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('flags a beacon handler that calls a principal resolver', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest(derivePrincipal) {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    const who = await derivePrincipal(c);\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('derivePrincipal');
      expect(violations[0]?.message).toContain('reaches a principal');
    });

    it('passes a beacon handler that reads only the request and the counters', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    await recordBeacon({ redis: c.var.redis, rawBody: await c.req.text() });\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a growth module resolving the principal in a helper beside the route', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'function actor(c) {\n' +
          '  return c.var.principal;\n' +
          '}\n' +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    await recordBeacon({ actor: actor(c) });\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'apps/api/src/slices/growth/routes.ts',
        line: 3,
      });
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('reports one violation for a line carrying several spellings of the principal', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "export const stamp = (c) => ({ a: c.var.principal, b: c.get('principal') });\n",
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a growth domain module reading the principal', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          'export function stamp(c): string {\n' +
          '  const who = c.var.principal;\n' +
          '  return String(who);\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('flags a growth test module reading the principal', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.integration.test.ts':
          "import { context } from './fixtures';\n" + 'export const who = context.var.principal;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('flags a beacon handler destructuring the principal off the context', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    const { principal } = c.var;\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolves no principal');
    });

    it('flags a beacon handler destructuring the principal under another name', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { Hono } from 'hono';\n" +
          'export function createGrowthManifest() {\n' +
          "  return new Hono().post('/', async (c) => {\n" +
          '    const { principal: who } = c.var;\n' +
          '    return c.body(null, 204);\n' +
          '  });\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolves no principal');
    });
  });

  describe('growth imports no session resolver', () => {
    it('flags a growth module importing derivePrincipal', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "import { derivePrincipal } from '../../../lib/context/principal.js';\n" +
          'export const owner = derivePrincipal;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'apps/api/src/slices/growth/domain/record-beacon.ts',
        line: 1,
      });
      expect(violations[0]?.message).toContain('derivePrincipal');
    });

    it('flags a growth module reaching a principal resolver by computed name', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "import * as context from '../../../lib/context/index.js';\n" +
          "export const derive = context['derivePrincipal'];\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('derivePrincipal');
    });

    it('flags a growth module reaching a principal resolver by a backtick key', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "import * as context from '../../../lib/context/index.js';\n" +
          'export const derive = context[`derivePrincipal`];\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('derivePrincipal');
    });

    it('flags a growth module keying a lookup on a name it assembles', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "import * as context from '../../../lib/context/index.js';\n" +
          "import { part } from './naming.js';\n" +
          'export const derive = context[`derive${part}`];\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('assembles the name');
    });

    it('passes a growth module building a redis key from a template', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "import { bucket } from './clock.js';\n" +
          'export const key = `growth:views:${bucket()}`;\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a growth module importing the session middleware', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { sessionMiddleware } from '../../middleware/pipeline-session.js';\n" +
          'export const middleware = sessionMiddleware;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('pipeline-session');
    });

    it('flags a growth module whose module specifier is not written out', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          'export async function load(name: string): Promise<unknown> {\n' +
          '  return await import(name);\n' +
          '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('not written out');
    });

    it('passes a growth module importing its own domain barrel', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/routes.ts':
          "import { recordBeacon } from './domain/index.js';\n" +
          'export const record = recordBeacon;\n',
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('the visitor hash reaches neither identity nor a growth door', () => {
    it('flags an identity module importing the visitor hash', () => {
      const project = projectWith({
        'apps/api/src/slices/identity/domain/register.ts':
          "import { visitorHash } from '../../growth/domain/visitor-hash.js';\n" +
          'export const stamp = visitorHash;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'apps/api/src/slices/identity/domain/register.ts',
        line: 1,
      });
      expect(violations[0]?.message).toContain('visitorHash');
    });

    it('flags an identity module naming the visitor hash as a string', () => {
      const project = projectWith({
        'apps/api/src/slices/identity/domain/register.ts':
          "import * as growth from '../../growth/domain/index.js';\n" +
          "export const stamp = growth['visitorHash'];\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('visitorHash');
    });

    it('flags an identity module naming the visitor hash in backticks', () => {
      const project = projectWith({
        'apps/api/src/slices/identity/domain/register.ts':
          "import * as growth from '../../growth/domain/index.js';\n" +
          'export const stamp = growth[`visitorHash`];\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('visitorHash');
    });

    it('flags a growth barrel re-exporting the visitor hash', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/index.ts':
          "export { visitorHash } from './domain/visitor-hash.js';\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('visitorHash');
    });

    it('flags a growth public door re-exporting the visitor hash', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "export { visitorHash as hashVisitor } from '../domain/visitor-hash.js';\n",
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it("flags a growth door publishing another symbol under the hash's name", () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "export { computeHash as visitorHash } from '../domain/visitor-hash.js';\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('published from a growth door');
    });

    it('flags a growth door binding the visitor hash by destructuring', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "import { hashing } from '../domain/visitor-hash.js';\n" +
          'export const { visitorHash } = hashing;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('published from a growth door');
    });

    it('flags a growth barrel declaring the visitor hash itself', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/index.ts':
          'export const visitorHash = async (): Promise<string> => "";\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('visitorHash');
    });

    it('flags a growth public door declaring the visitor hash as a function', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          'export async function visitorHash(): Promise<string> {\n' + "  return '';\n" + '}\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('published from a growth door');
    });

    it('flags a growth door publishing the visitor hash under another name', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "import { visitorHash } from '../domain/visitor-hash.js';\n" +
          'export const hashVisitor = visitorHash;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'apps/api/src/slices/growth/public/registration.ts',
        line: 1,
      });
      expect(violations[0]?.message).toContain('published from a growth door');
    });

    it('flags a growth barrel publishing the visitor hash under a renamed import', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/index.ts':
          "import { visitorHash as h } from './domain/visitor-hash.js';\n" +
          'export const hashVisitor = h;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('published from a growth door');
    });

    it('flags a growth door that re-exports a whole module', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/index.ts': "export * from './domain/visitor-hash.js';\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot see');
    });

    it('flags a growth door publishing a namespace import of a slice module', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "import * as vh from '../domain/visitor-hash.js';\n" + 'export const hashing = vh;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'apps/api/src/slices/growth/public/registration.ts',
        line: 1,
      });
      expect(violations[0]?.message).toContain('cannot see');
    });

    it('flags a growth barrel holding a whole module even where it publishes one member', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/index.ts':
          "import * as vh from './domain/visitor-hash.js';\n" +
          'export const width = vh.HASH_BYTES;\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot see');
    });

    it('flags a growth door publishing a whole module through a shape nothing here enumerates', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "import * as vh from '../domain/visitor-hash.js';\n" +
          'export const api = Object.freeze({ ...vh });\n',
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a growth door reaching a whole module through a dynamic import', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "export const hashing = await import('../domain/visitor-hash.js');\n",
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot see');
    });

    it('flags a growth door reaching a whole module through an import assignment', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "import vh = require('../domain/visitor-hash.js');\n" + 'export const hashing = vh;\n',
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('passes a growth door importing named symbols from its own slice', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "import { countBeacon } from '../domain/count-beacon.js';\n" +
          'export const count = countBeacon;\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it("passes identity importing the registration counter from growth's public door", () => {
      const project = projectWith({
        'apps/api/src/slices/identity/domain/register.ts':
          "import { countRegistrationStarted } from '../../growth/public/registration.js';\n" +
          'export const count = countRegistrationStarted;\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes the growth domain module that computes the hash for its own use', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/domain/record-beacon.ts':
          "import { visitorHash } from './visitor-hash.js';\n" +
          'export const hash = visitorHash;\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a growth door publishing a symbol whose name merely contains the hash', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/public/registration.ts':
          "export { countVisitorHashes } from '../domain/count-beacon.js';\n",
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a growth barrel that publishes everything except the hash', () => {
      const project = projectWith({
        'apps/api/src/slices/growth/index.ts':
          "export { recordBeacon } from './domain/record-beacon.js';\n" +
          "export { countBeacon } from './domain/count-beacon.js';\n",
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('growth-owned relations declare no path into another slice', () => {
    it('flags a growth-owned table declaring a relation to an identity-owned one', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  acquisitions: many(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'packages/db/src/schema/relations.ts',
        line: 5,
      });
      expect(violations[0]?.message).toContain('campaigns');
      expect(violations[0]?.message).toContain('userAcquisition');
      expect(violations[0]?.message).toContain('one-directional');
    });

    it('flags a growth-owned relation declared through an aliased relations factory', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations as defineRelations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = defineRelations(campaigns, ({ many }) => ({\n' +
          '  acquisitions: many(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('one-directional');
    });

    it('flags a growth-owned relation declared through a namespace relations factory', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import * as orm from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = orm.relations(campaigns, ({ many }) => ({\n' +
          '  acquisitions: many(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('one-directional');
    });

    it('passes a member call named for the relations factory whose subject is no table', () => {
      const project = projectWith({
        'apps/admin/src/routes/growth-page.ts':
          "import { describeGraph, config } from './graph';\n" +
          'export const graph = describeGraph.relations(config, ({ many }) => ({\n' +
          '  nodes: many(config),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags the same declaration written through an aliased import', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns as tags } from './campaigns';\n" +
          "import { userAcquisition as sources } from './user-acquisition';\n" +
          'export const tagRelations = relations(tags, ({ many }) => ({\n' +
          '  acquisitions: many(sources),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('passes an identity-owned table declaring a relation to a growth-owned one', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { users } from './users';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const userAcquisitionRelations = relations(userAcquisition, ({ one }) => ({\n' +
          '  user: one(users, { fields: [userAcquisition.userId], references: [users.id] }),\n' +
          '  campaign: one(campaigns, { fields: [userAcquisition.campaign], references: [campaigns.tag] }),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a growth-owned table declaring a relation to another growth-owned one', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { growthHourlyEvents } from './growth-hourly-events';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  hourlyEvents: many(growthHourlyEvents),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a growth-owned table declaring no relations at all', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { growthVisitors } from './growth-visitors';\n" +
          'export const growthVisitorsRelations = relations(growthVisitors, () => ({}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a growth-owned relation whose target is not a plain table name', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import * as schema from './index';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  acquisitions: many(schema.userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a growth-owned relations declaration that hides its builders', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = relations(campaigns, (build) => ({\n' +
          '  acquisitions: build.many(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a growth-owned relation whose target names no table at all', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { growthCampaignStatusEnum } from './enums';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  statuses: many(growthCampaignStatusEnum),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a growth-owned relation whose builder is handed no table', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  everything: many(),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a growth-owned relations declaration written with no callback', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          'export const campaignsRelations = relations(campaigns);\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a growth-owned relations declaration whose second argument is not a callback', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          'export const campaignsRelations = relations(campaigns, {});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('passes a growth-owned declaration whose callback is a function expression', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { growthHourlyEvents } from './growth-hourly-events';\n" +
          'export const campaignsRelations = relations(campaigns, function ({ many }) {\n' +
          '  return { hourlyEvents: many(growthHourlyEvents) };\n' +
          '});\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a growth-owned callback whose other calls are not relation builders', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { growthHourlyEvents } from './growth-hourly-events';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  hourlyEvents: many(growthHourlyEvents),\n' +
          '  label: helpers.describe(userAcquisition),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a growth-owned relation builder bound to another name', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => {\n' +
          '  const link = many;\n' +
          '  return { acquisitions: link(userAcquisition) };\n' +
          '});\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('escapes this callback');
    });

    it('flags a growth-owned relation builder handed to another function', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { accountLink } from './account-link';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  ...accountLink(many),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('escapes this callback');
    });

    it('flags a growth-owned relation builder invoked through a member', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  acquisitions: many.call(null, userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('escapes this callback');
    });

    it('passes a growth-owned relation named for the builder that declares it', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { growthHourlyEvents } from './growth-hourly-events';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  many: many(growthHourlyEvents),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('passes a growth-owned callback reading a property that shares a builder name', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { growthHourlyEvents } from './growth-hourly-events';\n" +
          "import { cardinalities } from './cardinalities';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many }) => ({\n' +
          '  hourlyEvents: many(growthHourlyEvents, { relationName: cardinalities.many }),\n' +
          '}));\n',
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a growth-owned relation whose factory is reached by a keyed access', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import * as orm from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          "export const campaignsRelations = orm['relations'](campaigns, ({ many }) => ({\n" +
          '  acquisitions: many(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('one-directional');
    });

    it('passes a keyed call in the schema tree that names no relations factory', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import * as orm from 'drizzle-orm';\n" + "export const rows = orm['sql']();\n",
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a namespace-spelled relations declaration in the schema tree', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import * as orm from 'drizzle-orm';\n" +
          "import * as schema from './index';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = orm.relations(schema.campaigns, ({ many }) => ({\n' +
          '  acquisitions: many(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a growth-owned relations declaration whose builders nest a destructuring', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import { campaigns } from './campaigns';\n" +
          "import { userAcquisition } from './user-acquisition';\n" +
          'export const campaignsRelations = relations(campaigns, ({ many: { call } }) => ({\n' +
          '  acquisitions: call(userAcquisition),\n' +
          '}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });

    it('flags a relations declaration whose subject this rule cannot resolve', () => {
      const project = projectWith({
        'packages/db/src/schema/relations.ts':
          "import { relations } from 'drizzle-orm';\n" +
          "import * as schema from './index';\n" +
          'export const campaignsRelations = relations(schema.campaigns, ({ many }) => ({}));\n',
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('cannot resolve');
    });
  });
});

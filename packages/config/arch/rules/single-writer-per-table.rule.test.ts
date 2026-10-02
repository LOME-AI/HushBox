import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { isTestScaffolding } from './single-writer-per-table.rule.js';

const BARREL = 'packages/db/src/schema/index.ts';

/** The live table-export set, mirrored from `packages/db/src/schema/index.ts`. */
const TABLE_NAMES = [
  'users',
  'verificationTokens',
  'accountDeletionEvents',
  'userAcquisition',
  'termsAcceptances',
  'wallets',
  'ledgerEntries',
  'usageRecords',
  'llmCompletions',
  'mediaGenerations',
  'payments',
  'memberBudgets',
  'conversationSpending',
  'allowanceSpending',
  'publicStatsSnapshots',
  'conversations',
  'conversationMembers',
  'conversationForks',
  'epochs',
  'epochMembers',
  'sharedLinks',
  'sharedMessages',
  'messages',
  'contentItems',
  'modelCatalog',
  'newsletterSubscribers',
  'newsletterIssues',
  'newsletterDeliveries',
  'newsletterWebhookEvents',
  'adminAudit',
  'deviceTokens',
  'notificationPreferences',
  'feedback',
  'customInstructions',
  'preferences',
  'bannerConfig',
  'bannerDismissals',
  'campaigns',
  'growthVisitors',
  'growthPaths',
  'growthReferrers',
  'growthCampaignPaths',
  'growthGeo',
  'growthDailyPathReach',
  'growthHourlyEvents',
  'growthHourlyFunnel',
  'growthHourlyProductEntry',
  'idempotencyKeys',
  'jobs',
  'serviceEvidence',
];

/** The live view-export set, mirrored from `packages/db/src/schema/index.ts`. */
const VIEW_NAMES = [
  'marketingHourlyView',
  'marketingDailyView',
  'growthWeeklyView',
  'funnelWeeklyView',
  'acquisitionSourcesView',
];

/**
 * Builds a synthetic schema barrel. The `./enums` and `./relations` declarations
 * must be filtered out by the rule; the remaining named exports are the table set.
 */
function barrelSource(
  tables: readonly string[] = TABLE_NAMES,
  views: readonly string[] = VIEW_NAMES
): string {
  const enums = "export { walletTypeEnum } from './enums';\n";
  const relations = "export { usersRelations } from './relations';\n";
  const tableExports = tables.map((name) => `export { ${name} } from './${name}';\n`).join('');
  const viewExports = views.map((name) => `export { ${name} } from './views/${name}';\n`).join('');
  return enums + relations + tableExports + viewExports;
}

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, source] of Object.entries(files)) {
    project.createSourceFile(path, source);
  }
  return project;
}

describe('single-writer-per-table', () => {
  it('flags a slice writing a foreign table via the query builder', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.insert(messages).values({});\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'billing'");
    expect(violations[0]?.message).toContain("table 'messages'");
    expect(violations[0]?.message).toContain("owned by 'chat'");
  });

  it('flags a slice writing an infra sentinel table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/chat/adapters/stores.ts': 'const x = db.insert(jobs).values({});\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'chat'");
    expect(violations[0]?.message).toContain("table 'jobs'");
    expect(violations[0]?.message).toContain("owned by 'lib'");
  });

  it('flags a raw-SQL cross-slice write', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.execute(sql`INSERT INTO ${messages} (a) VALUES (1)`);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'billing'");
    expect(violations[0]?.message).toContain("table 'messages'");
  });

  it('passes a raw-SQL owner write', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/feedback/adapters/stores.ts':
        'const x = db.execute(sql`INSERT INTO ${feedback} (a) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${feedback})`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a non-DML sql template that reads a foreign table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.execute(sql`SELECT * FROM ${messages}`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a correct owner write via the query builder', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/identity/adapters/stores.ts': 'const x = db.insert(users).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag Hono route verbs, Set.delete, or storage.delete', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/identity/routes.ts':
        "router.delete('/session', handler);\nseen.delete(makeKey(x));\nstorage.delete(object.key);\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores writes in test files', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.test.ts':
        'const x = db.insert(messages).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores writes in spec files', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.spec.ts':
        'const x = db.insert(messages).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores writes in an integration setup file that seeds another slice', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/chat/routes.integration.setup.ts':
        'const x = db.insert(users).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('exempts the api test-support tree, whose scaffolding seeds whatever slice its subject needs', () => {
    expect(isTestScaffolding('apps/api/src/test-support/rate-limit-double.ts')).toBe(true);
  });

  it('ignores a test-support write of a slice-owned table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/test-support/chat-harness.ts': 'const x = db.insert(users).values({});\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not exempt an ordinary api source file', () => {
    expect(isTestScaffolding('apps/api/src/slices/chat/adapters/stores.ts')).toBe(false);
  });

  it('flags a schema table with no TABLE_OWNER entry', () => {
    const project = projectWith({
      [BARREL]: barrelSource([...TABLE_NAMES, 'ghostTable']),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("table 'ghostTable'");
    expect(violations[0]?.message).toContain('no owning slice');
  });

  it('flags a TABLE_OWNER key absent from the schema', () => {
    const project = projectWith({
      [BARREL]: barrelSource(TABLE_NAMES.filter((name) => name !== 'feedback')),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'feedback'");
    expect(violations[0]?.message).toContain('no longer exists');
  });

  it('passes cleanly when every table maps one-to-one to its owner', () => {
    const project = projectWith({ [BARREL]: barrelSource() });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a slice reading a view another slice owns', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/reads.ts':
        'const x = db.select().from(funnelWeeklyView);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("slice 'billing'");
    expect(violations[0]?.message).toContain("view 'funnelWeeklyView'");
    expect(violations[0]?.message).toContain("owned by 'growth'");
  });

  it('passes the owning slice reading its own view', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/growth/adapters/reads.ts':
        'const x = db.select().from(funnelWeeklyView);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a raw-SQL read of a view from a foreign slice', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/admin/domain/growth.ts':
        'const x = db.execute(sql`select * from ${marketingDailyView}`);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("view 'marketingDailyView'");
  });

  it('flags a view read from a file no owner tree claims', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/composition/growth-bindings.ts':
        'const x = db.select().from(growthWeeklyView);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('no owner tree');
    expect(violations[0]?.message).toContain("view 'growthWeeklyView'");
  });

  it('does not attribute a view reference inside the package that declares the views', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'packages/db/src/schema/views/funnel-weekly.ts':
        'const x = db.select().from(growthWeeklyView);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a view read in a test file', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/reads.test.ts':
        'const x = db.select().from(funnelWeeklyView);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a schema view with no VIEW_OWNER entry', () => {
    const project = projectWith({
      [BARREL]: barrelSource(TABLE_NAMES, [...VIEW_NAMES, 'ghostView']),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("view 'ghostView'");
    expect(violations[0]?.message).toContain('no owning slice');
  });

  it('does not flag a slice reading a schema view that has no owner (view completeness reports it once, at the barrel)', () => {
    const project = projectWith({
      [BARREL]: barrelSource(TABLE_NAMES, [...VIEW_NAMES, 'ghostView']),
      'apps/api/src/slices/billing/adapters/reads.ts': 'const x = db.select().from(ghostView);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(BARREL);
    expect(violations[0]?.message).toContain('no owning slice');
  });

  it('flags a VIEW_OWNER key absent from the schema', () => {
    const project = projectWith({
      [BARREL]: barrelSource(
        TABLE_NAMES,
        VIEW_NAMES.filter((name) => name !== 'growthWeeklyView')
      ),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'growthWeeklyView'");
    expect(violations[0]?.message).toContain('no longer exists');
  });

  it('does not demand a table owner for a view export', () => {
    const project = projectWith({ [BARREL]: barrelSource() });

    // Every VIEW_NAMES entry is a barrel export the table derivation must drop:
    // nothing writes a view, so a table owner for one could never be given.
    expect(rule.check(project)).toEqual([]);
  });

  it('throws when the schema barrel is absent from the project', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/adapters/stores.ts': 'const x = 1;\n',
    });

    expect(() => rule.check(project)).toThrow(/schema barrel/);
  });

  it('defensively drops names ending in Enum or Relations even outside the enum/relation modules', () => {
    const project = projectWith({
      [BARREL]:
        barrelSource() +
        "export { fooEnum } from './foo';\nexport { fooRelations } from './foo';\n",
    });

    // Neither synthetic name is a real table, so treating them as tables would
    // trip the "no owning slice" completeness check. A clean pass proves they
    // were filtered.
    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a slice writing a schema table that has no owner (owner completeness reports it once, at the barrel)', () => {
    const project = projectWith({
      [BARREL]: barrelSource([...TABLE_NAMES, 'ghostTable']),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const x = db.insert(ghostTable).values({});\n',
    });

    const violations = rule.check(project);

    // The write itself is not attributed (no owner to compare against); only the
    // completeness violation at the barrel fires.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(BARREL);
    expect(violations[0]?.message).toContain('no owning slice');
  });

  it('ignores a query-builder write whose first argument is a non-table identifier', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      // Mirrors the real feedback/domain/submit.ts shape: `db.insert(userId, input)`
      // passes a bare identifier that is not a schema table, so the matcher must
      // ignore it rather than mis-flag it.
      'apps/api/src/slices/feedback/domain/submit.ts': 'const x = db.insert(userId, input);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes the db package writing the table the db sentinel owns', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'packages/db/src/evidence.ts':
        'export async function recordServiceEvidence(db, isCI) {\n' +
        '  if (!isCI) return;\n' +
        '  await db.insert(serviceEvidence).values({});\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags the db package writing a slice-owned table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'packages/db/src/evidence.ts': 'const x = db.insert(users).values({});\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'db'");
    expect(violations[0]?.message).toContain("table 'users'");
    expect(violations[0]?.message).toContain("owned by 'identity'");
  });

  it('ignores a non-sql tagged template and a sql template with no interpolation', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/billing/adapters/stores.ts':
        'const a = other`INSERT INTO ${messages}`;\nconst b = sql`INSERT INTO messages VALUES (1)`;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a write from a file no owner tree claims', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/jobs/deletion-events-purge.ts':
        'const x = writer.delete(accountDeletionEvents);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('apps/api/src/jobs/deletion-events-purge.ts');
    expect(violations[0]?.message).toContain("table 'accountDeletionEvents'");
    expect(violations[0]?.message).toContain("owned by 'identity'");
    expect(violations[0]?.message).toContain('no owner tree');
  });

  it('flags a raw-SQL write from a file no owner tree claims', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/platform/dev/seed.ts':
        'const x = db.execute(sql`INSERT INTO ${wallets} (a) VALUES (1)`);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("table 'wallets'");
    expect(violations[0]?.message).toContain('no owner tree');
  });

  it('flags the api lib tree writing a slice-owned table', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/lib/idempotency/purge.ts': 'const x = db.delete(users);\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("'lib'");
    expect(violations[0]?.message).toContain("table 'users'");
    expect(violations[0]?.message).toContain("owned by 'identity'");
  });

  it('passes the api lib tree writing the tables the lib sentinel owns', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/lib/jobs/store.ts':
        'const a = db.insert(jobs).values({});\nconst b = db.delete(idempotencyKeys);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores non-table and non-identifier interpolations in a DML sql template', () => {
    const project = projectWith({
      [BARREL]: barrelSource(),
      'apps/api/src/slices/feedback/adapters/stores.ts':
        'const x = db.execute(sql`INSERT INTO ${feedback} (${sql.identifier(col)}) VALUES (${userId})`);\n',
    });

    // `${sql.identifier(col)}` is a call, `${userId}` is a non-table identifier;
    // only `${feedback}` counts, and feedback owns feedback, so no violation.
    expect(rule.check(project)).toEqual([]);
  });
});

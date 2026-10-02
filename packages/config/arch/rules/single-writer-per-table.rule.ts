import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile, relativePath } from '../lib/paths.js';
import type {
  CallExpression,
  Project,
  SourceFile,
  TaggedTemplateExpression,
  TemplateExpression,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Single-writer-per-table, structurally enforced. Every table has exactly one
 * owning slice; everyone else reaches it through the owner's published barrel
 * API (ARCHITECTURE.md §System map). Lint boundaries see imports, not which
 * table a `db.insert(...)` targets, so this rule closes that gap: it attributes
 * each write to the owner tree the writing file sits in and to the written
 * table, and fails when the two disagree with `TABLE_OWNER`.
 *
 * Attribution covers the scanned tree WHOLE, not the slices under it: a write
 * from a file no owner tree claims — a composition root, a cron entry, a dev
 * seed — has no owner to compare against, and is a violation for exactly that
 * reason. Reading the gate the other way round (attribute what sits in a slice,
 * pass everything else) is what let a live cross-slice delete sit outside every
 * rule while the gate reported green.
 *
 * The table set is derived at check time from the schema barrel
 * (`packages/db/src/schema/index.ts`) so a renamed or dropped table cannot
 * silently desync the map — a missing owner or a stale key is itself a
 * violation. Sentinel owners `'lib'` and `'db'` are deliberately non-slice
 * values, so any slice writing an infra table (`jobs`, `idempotency_keys`,
 * `service_evidence`) is flagged.
 *
 * Syntactic only (no `getType()`): query-builder writes are
 * `.insert/.update/.delete(TABLE)` with a bare table identifier as the first
 * argument (which alone excludes Hono route verbs, `Set.delete`, and
 * `storage.delete`); raw-SQL writes are `sql`…`` DML tagged templates
 * interpolating a table identifier.
 */

const SCHEMA_BARREL_SUFFIX = 'packages/db/src/schema/index.ts';
const SLICES_SEGMENT = 'apps/api/src/slices/';
const TEST_SUPPORT_TREE = 'apps/api/src/test-support/';
const API_LIB_TREE = 'apps/api/src/lib/';
const DB_PACKAGE_TREE = 'packages/db/';

/**
 * A file whose writes this rule does not attribute: a test file by name, or
 * anything in the api's test-support tree.
 *
 * Scaffolding seeds whatever tables the subject under test needs, across every
 * slice, and that breadth is what makes it scaffolding — ownership is a claim
 * about production writes. The tree exemption is this rule's own judgement and
 * deliberately not folded into the shared test-file predicate: rules that
 * police test seams, `no-evidence-from-mocked-seam` above all, must keep
 * reading these files.
 */
export function isTestScaffolding(filePath: string): boolean {
  return isTestFile(filePath) || filePath.includes(TEST_SUPPORT_TREE);
}

/**
 * The owning slice of every table. Sentinel owners `'lib'` and `'db'` are
 * intentionally not slice names. Keys and the derived schema set must match
 * exactly — completeness is asserted below in both directions.
 *
 * Published because it is the layer's one statement of table ownership: a rule
 * that needs an owner reads it here rather than deriving one from a table's
 * name, which is a different question with a different answer (`campaigns` is
 * growth-owned and carries no growth prefix).
 */
export const TABLE_OWNER: Record<string, string | string[]> = {
  users: 'identity',
  verificationTokens: 'identity',
  accountDeletionEvents: 'identity',
  userAcquisition: 'identity',
  termsAcceptances: 'identity',
  wallets: 'billing',
  ledgerEntries: 'billing',
  usageRecords: 'billing',
  llmCompletions: 'billing',
  mediaGenerations: 'billing',
  payments: 'billing',
  memberBudgets: 'billing',
  conversationSpending: 'billing',
  allowanceSpending: 'billing',
  publicStatsSnapshots: 'billing',
  conversations: 'conversations',
  conversationMembers: 'conversations',
  conversationForks: 'conversations',
  epochs: 'conversations',
  epochMembers: 'conversations',
  sharedLinks: 'conversations',
  sharedMessages: 'conversations',
  messages: 'chat',
  contentItems: 'chat',
  modelCatalog: 'models',
  newsletterSubscribers: 'newsletter',
  newsletterIssues: 'newsletter',
  newsletterDeliveries: 'newsletter',
  newsletterWebhookEvents: 'newsletter',
  adminAudit: 'admin',
  deviceTokens: 'notifications',
  notificationPreferences: 'notifications',
  feedback: 'feedback',
  customInstructions: 'account',
  preferences: 'account',
  bannerConfig: 'announcements',
  bannerDismissals: 'announcements',
  campaigns: 'growth',
  growthVisitors: 'growth',
  growthPaths: 'growth',
  growthReferrers: 'growth',
  growthCampaignPaths: 'growth',
  growthGeo: 'growth',
  growthDailyPathReach: 'growth',
  growthHourlyEvents: 'growth',
  growthHourlyFunnel: 'growth',
  growthHourlyProductEntry: 'growth',
  idempotencyKeys: 'lib',
  jobs: 'lib',
  serviceEvidence: 'db',
};

/**
 * The owning slice of every view. **A view is owned by the slice whose read
 * code selects from it** — not by the widest table it reads, which was the
 * earlier wording and was ill-defined: adding an unrelated column to `users`
 * would have flipped a view's owner without anyone touching the view. Nothing
 * writes a view, so ownership here is about who may read one; a
 * `select().from(<view>)` outside the owner tree is a violation.
 *
 * Keys and the derived view set must match exactly — completeness is asserted
 * below in both directions, the same way the table map is.
 */
const VIEW_OWNER: Record<string, string | string[]> = {
  marketingHourlyView: 'growth',
  marketingDailyView: 'growth',
  growthWeeklyView: 'growth',
  funnelWeeklyView: 'growth',
  acquisitionSourcesView: 'growth',
};

const WRITE_METHODS = new Set(['insert', 'update', 'delete']);
const DML = /INSERT INTO|UPDATE|DELETE FROM/i;

/** Every named export of the schema barrel bar the enum and relation modules, with its line. */
function schemaExports(barrel: SourceFile): Map<string, number> {
  const exports = new Map<string, number>();
  for (const declaration of barrel.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === './enums' || specifier === './relations') continue;
    for (const named of declaration.getNamedExports()) {
      exports.set(named.getName(), named.getStartLineNumber());
    }
  }
  return exports;
}

/**
 * The live table-export set with each export's line: every schema export bar a
 * defensive drop of any name ending `Enum`/`Relations`, and of the `View`
 * suffix the views carry. Without that last drop the completeness check would
 * demand a table owner for a view — a relation nothing writes, so no honest
 * answer exists.
 */
function deriveSchemaTables(barrel: SourceFile): Map<string, number> {
  const tables = new Map<string, number>();
  for (const [name, line] of schemaExports(barrel)) {
    if (name.endsWith('Enum') || name.endsWith('Relations') || name.endsWith('View')) continue;
    tables.set(name, line);
  }
  return tables;
}

/** The live view-export set, which is exactly the `View`-suffixed schema exports. */
function deriveSchemaViews(barrel: SourceFile): Map<string, number> {
  const views = new Map<string, number>();
  for (const [name, line] of schemaExports(barrel)) {
    if (name.endsWith('View')) views.set(name, line);
  }
  return views;
}

/** One owner map plus how a violation names it: the two registries are asserted by the same code. */
interface OwnerRegistry {
  readonly owners: Record<string, string | string[]>;
  readonly name: string;
  readonly noun: string;
}

/**
 * Missing-owner and stale-key violations for one owner map, anchored to the
 * schema barrel. Both relation kinds are asserted the same way and in both
 * directions, so neither map can drift from the schema unnoticed.
 */
function completenessViolations(
  relations: Map<string, number>,
  registry: OwnerRegistry,
  barrelPath: string
): ArchViolation[] {
  const { owners, name: registryName, noun } = registry;
  const violations: ArchViolation[] = [];
  for (const [relation, line] of relations) {
    if (!(relation in owners)) {
      violations.push({
        file: barrelPath,
        line,
        message: `${noun} '${relation}' has no owning slice — add it to ${registryName}`,
      });
    }
  }
  for (const key of Object.keys(owners)) {
    if (!relations.has(key)) {
      violations.push({
        file: barrelPath,
        line: 1,
        message: `${registryName} lists '${key}' which no longer exists in the schema — remove or rename it`,
      });
    }
  }
  return violations;
}

function sliceOf(filePath: string): string {
  const afterSlices = filePath.slice(filePath.indexOf(SLICES_SEGMENT) + SLICES_SEGMENT.length);
  return afterSlices.split('/')[0] ?? '';
}

/**
 * The owner a file's writes are attributed to, and how a violation names it.
 * The three trees are the three owner kinds `TABLE_OWNER` can hold: a slice, and
 * the two sentinels that are deliberately not slice names. Anything else — a
 * composition root, a cron entry, a dev seed, another package — is claimed by no
 * owner tree, which is what makes its writes reportable.
 */
interface OwnerContext {
  readonly owner: string;
  readonly subject: string;
}

function ownerContextOf(filePath: string): OwnerContext | undefined {
  if (filePath.includes(SLICES_SEGMENT)) {
    const slice = sliceOf(filePath);
    return { owner: slice, subject: `slice '${slice}'` };
  }
  if (filePath.includes(API_LIB_TREE)) return { owner: 'lib', subject: "the api's 'lib' tree" };
  if (filePath.includes(DB_PACKAGE_TREE)) return { owner: 'db', subject: "the 'db' package" };
  return undefined;
}

/** Normalizes a `string | string[]` owner to an array without a branch. */
export function ownersOf(owner: string | string[]): string[] {
  return [owner].flat();
}

function writeViolation(
  table: string,
  context: OwnerContext | undefined,
  filePath: string,
  line: number
): ArchViolation | undefined {
  const owner = TABLE_OWNER[table];
  if (owner === undefined) return undefined;
  const owners = ownersOf(owner);
  if (context !== undefined && owners.includes(context.owner)) return undefined;
  const subject = context?.subject ?? 'a file no owner tree claims';
  return {
    file: filePath,
    line,
    message: `${subject} writes table '${table}', owned by '${owners.join("' or '")}' — go through its published barrel API`,
  };
}

/** The table named by a `.insert/.update/.delete(TABLE)` call, if any. */
function queryBuilderTable(call: CallExpression, tables: Map<string, number>): string | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  if (!WRITE_METHODS.has(callee.getName())) return undefined;
  const firstArgument = call.getArguments()[0];
  if (firstArgument === undefined || !Node.isIdentifier(firstArgument)) return undefined;
  const name = firstArgument.getText();
  return tables.has(name) ? name : undefined;
}

/** The tagged template, if it is a `sql`…`` DML template with interpolation. */
function dmlSqlTemplate(tagged: TaggedTemplateExpression): TemplateExpression | undefined {
  const tag = tagged.getTag();
  if (!Node.isIdentifier(tag)) return undefined;
  if (tag.getText() !== 'sql') return undefined;
  const template = tagged.getTemplate();
  if (!Node.isTemplateExpression(template)) return undefined;
  if (!DML.test(template.getText())) return undefined;
  return template;
}

/** Table identifiers interpolated into a DML `sql`…`` tagged template. */
function rawSqlTables(tagged: TaggedTemplateExpression, tables: Map<string, number>): string[] {
  const template = dmlSqlTemplate(tagged);
  if (template === undefined) return [];
  const found: string[] = [];
  for (const span of template.getTemplateSpans()) {
    const expression = span.getExpression();
    if (Node.isIdentifier(expression) && tables.has(expression.getText())) {
      found.push(expression.getText());
    }
  }
  return found;
}

function queryBuilderViolations(
  sourceFile: SourceFile,
  filePath: string,
  context: OwnerContext | undefined,
  tables: Map<string, number>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const table = queryBuilderTable(call, tables);
    if (table === undefined) continue;
    const violation = writeViolation(table, context, filePath, call.getStartLineNumber());
    if (violation !== undefined) violations.push(violation);
  }
  return violations;
}

function rawSqlViolations(
  sourceFile: SourceFile,
  filePath: string,
  context: OwnerContext | undefined,
  tables: Map<string, number>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const tagged of sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
    for (const table of rawSqlTables(tagged, tables)) {
      const violation = writeViolation(table, context, filePath, tagged.getStartLineNumber());
      if (violation !== undefined) violations.push(violation);
    }
  }
  return violations;
}

/** The view named by a `.from(VIEW)` call, if any. */
function queryBuilderView(call: CallExpression, views: Map<string, number>): string | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  if (callee.getName() !== 'from') return undefined;
  const firstArgument = call.getArguments()[0];
  if (firstArgument === undefined || !Node.isIdentifier(firstArgument)) return undefined;
  const name = firstArgument.getText();
  return views.has(name) ? name : undefined;
}

/** View identifiers interpolated into any `sql`…`` tagged template, DML or not: a view is only ever read. */
function rawSqlViews(tagged: TaggedTemplateExpression, views: Map<string, number>): string[] {
  const tag = tagged.getTag();
  if (!Node.isIdentifier(tag) || tag.getText() !== 'sql') return [];
  const template = tagged.getTemplate();
  if (!Node.isTemplateExpression(template)) return [];
  const found: string[] = [];
  for (const span of template.getTemplateSpans()) {
    const expression = span.getExpression();
    if (Node.isIdentifier(expression) && views.has(expression.getText())) {
      found.push(expression.getText());
    }
  }
  return found;
}

function readViolation(
  view: string,
  context: OwnerContext | undefined,
  filePath: string,
  line: number
): ArchViolation | undefined {
  const owner = VIEW_OWNER[view];
  if (owner === undefined) return undefined;
  const owners = ownersOf(owner);
  if (context !== undefined && owners.includes(context.owner)) return undefined;
  const subject = context?.subject ?? 'a file no owner tree claims';
  return {
    file: filePath,
    line,
    message: `${subject} reads view '${view}', owned by '${owners.join("' or '")}' — a view belongs to the slice whose read code selects from it`,
  };
}

/**
 * View reads this file makes that its owner tree does not permit.
 *
 * The package that declares the views is skipped: it holds no read code, and
 * one view's definition legitimately renders another's SQL, which is a
 * reference to a view rather than a read of one.
 */
function queryBuilderReadViolations(
  sourceFile: SourceFile,
  filePath: string,
  context: OwnerContext | undefined,
  views: Map<string, number>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const view = queryBuilderView(call, views);
    if (view === undefined) continue;
    const violation = readViolation(view, context, filePath, call.getStartLineNumber());
    if (violation !== undefined) violations.push(violation);
  }
  return violations;
}

function rawSqlReadViolations(
  sourceFile: SourceFile,
  filePath: string,
  context: OwnerContext | undefined,
  views: Map<string, number>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const tagged of sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
    for (const view of rawSqlViews(tagged, views)) {
      const violation = readViolation(view, context, filePath, tagged.getStartLineNumber());
      if (violation !== undefined) violations.push(violation);
    }
  }
  return violations;
}

function viewReadViolations(
  sourceFile: SourceFile,
  filePath: string,
  views: Map<string, number>
): ArchViolation[] {
  if (filePath.includes(DB_PACKAGE_TREE)) return [];
  const context = ownerContextOf(filePath);
  return [
    ...queryBuilderReadViolations(sourceFile, filePath, context, views),
    ...rawSqlReadViolations(sourceFile, filePath, context, views),
  ];
}

function writeViolations(
  sourceFile: SourceFile,
  filePath: string,
  tables: Map<string, number>
): ArchViolation[] {
  const context = ownerContextOf(filePath);
  return [
    ...queryBuilderViolations(sourceFile, filePath, context, tables),
    ...rawSqlViolations(sourceFile, filePath, context, tables),
  ];
}

const rule: ArchRule = {
  name: 'single-writer-per-table',
  check(project: Project): ArchViolation[] {
    const barrel = project
      .getSourceFiles()
      .find((sourceFile) => relativePath(sourceFile).endsWith(SCHEMA_BARREL_SUFFIX));
    if (barrel === undefined) {
      throw new Error(
        `single-writer-per-table: schema barrel '${SCHEMA_BARREL_SUFFIX}' not found in project`
      );
    }

    const barrelPath = relativePath(barrel);
    const tables = deriveSchemaTables(barrel);
    const views = deriveSchemaViews(barrel);
    const violations: ArchViolation[] = [
      ...completenessViolations(
        tables,
        { owners: TABLE_OWNER, name: 'TABLE_OWNER', noun: 'table' },
        barrelPath
      ),
      ...completenessViolations(
        views,
        { owners: VIEW_OWNER, name: 'VIEW_OWNER', noun: 'view' },
        barrelPath
      ),
    ];

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (isTestScaffolding(filePath)) continue;
      violations.push(
        ...writeViolations(sourceFile, filePath, tables),
        ...viewReadViolations(sourceFile, filePath, views)
      );
    }

    return violations;
  },
};

export default rule;

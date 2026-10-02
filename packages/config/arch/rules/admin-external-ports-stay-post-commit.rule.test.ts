import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './admin-external-ports-stay-post-commit.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const OPS_FILE = 'apps/api/src/slices/admin/domain/operations/thing.ts';
const GROUPS_FILE = 'apps/api/src/slices/admin/domain/operations/groups.ts';

/** The registration that puts a type at an op's transaction-scoped position. */
function registration(deps: string, post: string): string {
  return `export const adminThingOperations: readonly AdminOpImplementation<\n  ${deps},\n  z.ZodObject,\n  ${post}\n>[] = [];\n`;
}

describe('admin-external-ports-stay-post-commit', () => {
  it('flags an external port on an op’s transaction-scoped dependencies', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly thingStores: ThingStores;\n' +
        '  readonly sender: EmailSender;\n' +
        '}\n' +
        'export interface AdminThingPostDeps {\n' +
        '  readonly realtime: RealtimeBroadcast;\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/EmailSender/);
    expect(violations[0]?.line).toBe(3);
  });

  it('accepts the same external port on the post-commit dependencies', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly thingStores: ThingStores;\n' +
        '}\n' +
        'export interface AdminThingPostDeps {\n' +
        '  readonly sender: EmailSender;\n' +
        '  readonly realtime: RealtimeBroadcast;\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a non-port dependency on the transaction-scoped half', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly identityStores: IdentityStores;\n' +
        '  readonly jobRegistry: JobRegistry;\n' +
        '  conversationsStores(writer: DbWriter): ConversationsStores;\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a port named in an unrelated file', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/domain/wallet.ts':
        'export interface WalletDeps {\n  readonly storage: Storage;\n}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an admin-slice interface that no op names as its dependencies', () => {
    const project = projectWith({
      [OPS_FILE]: 'export interface AdminThingHelpers {\n  readonly sender: EmailSender;\n}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a test file declaring the same shape', () => {
    const project = projectWith({
      'apps/api/src/slices/admin/domain/operations/thing.integration.test.ts':
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a port nested inside a member type', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly senders: readonly EmailSender[];\n' +
        '  resolve(): Promise<Storage>;\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('reads the context type as an anchor too', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly realtime: RealtimeBroadcast;\n}\n' +
        'export function prelude(ctx: AdminOpContext<AdminThingDeps>): void {}\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('follows the composite union down to the family it inherits from', () => {
    const project = projectWith({
      [OPS_FILE]: 'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n',
      [GROUPS_FILE]:
        'export interface AdminOperationsDeps extends AdminThingDeps {}\n' +
        registration('AdminOperationsDeps', 'AdminOperationsPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(OPS_FILE);
  });

  it('reports once when the composite and the family it inherits are both anchored', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
      [GROUPS_FILE]:
        'export interface AdminOperationsDeps extends AdminThingDeps {}\n' +
        registration('AdminOperationsDeps', 'AdminOperationsPostDeps'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads a definition call’s explicit type arguments as an anchor', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        'export const thingDo = defineAdminOp<AdminThingDeps, (typeof contract)["input"]>(\n' +
        '  contract,\n  {}\n);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads an alias standing in for a dependency interface', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export type AdminThingDeps = { readonly realtime: RealtimeBroadcast };\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an anchor whose dependency position names no declared type', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        'export type Ctx = AdminOpContext<{ readonly scratch: string }>;\n' +
        'export const registry = createAdminOpRegistry([]);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads the engine deps type as an anchor', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        'export type ThingEngineDeps = AdminOpEngineDeps<AdminThingDeps, AdminThingPostDeps>;\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads the registry type as an anchor', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        'export declare function thingRegistry(): AdminOpRegistry<\n' +
        '  AdminThingDeps,\n  AdminThingPostDeps\n>;\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reads the registry factory call as an anchor', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        'export const registry = createAdminOpRegistry<AdminThingDeps, AdminThingPostDeps>([]);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses a capability the post-commit half names, carried by no port list', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly evictUser: WidgetEvictionPort;\n' +
        '}\n' +
        'export interface AdminThingPostDeps {\n' +
        '  readonly evictUser: WidgetEvictionPort;\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/WidgetEvictionPort/);
    expect(violations[0]?.line).toBe(2);
  });

  it('keeps the port floor for a port no post-commit half names', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly sender: EmailSender;\n}\n' +
        'export interface AdminThingPostDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/EmailSender/);
  });

  it('accepts a dependency named on neither the post-commit half nor the port floor', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly thingStores: ThingStores;\n}\n' +
        'export interface AdminThingPostDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('derives from a post-commit half the composite union only inherits', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingPostDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n' +
        'export interface AdminOtherDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n',
      [GROUPS_FILE]:
        'export interface AdminOperationsDeps extends AdminOtherDeps {}\n' +
        'export interface AdminOperationsPostDeps extends AdminThingPostDeps {}\n' +
        registration('AdminOperationsDeps', 'AdminOperationsPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(OPS_FILE);
  });

  it('derives no name from a post-commit member whose type is not a bare name', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly thingStores: ThingStores;\n' +
        '  resolve(): Promise<ThingStores>;\n' +
        '  readonly log: string[];\n' +
        '}\n' +
        'export interface AdminThingPostDeps {\n' +
        '  readonly ephemeralLog: string[];\n' +
        '  readonly ephemeralFailure: { armed: boolean };\n' +
        '  readonly late: Promise<ThingStores>;\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('derives from an alias standing in for a post-commit half', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n' +
        'export type AdminThingPostDeps = { readonly evictUser: WidgetEvictionPort };\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/WidgetEvictionPort/);
  });

  it('derives nothing from an alias whose post-commit half is not an object type', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly index: Record<string, string>;\n}\n' +
        'export type AdminThingPostDeps = Record<never, never>;\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves a capability composed under an inline object type unrefused', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n' +
        '  readonly testEmail: { send(to: string): Promise<void> };\n' +
        '}\n' +
        'export interface AdminThingPostDeps {\n' +
        '  readonly testEmail: { send(to: string): Promise<void> };\n' +
        '}\n' +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('un-derives a capability once no post-commit half names it', () => {
    // The guard shrinks as well as grows, and no gate reports a shrink: this
    // pins that direction as a decision rather than leaving it an accident.
    const halves = (postCommitMember: string): Record<string, string> => ({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n' +
        `export interface AdminThingPostDeps {\n${postCommitMember}}\n` +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(
      rule.check(projectWith(halves('  readonly evictUser: WidgetEvictionPort;\n')))
    ).toHaveLength(1);
    expect(rule.check(projectWith(halves('')))).toEqual([]);
  });

  it('flags an external port written as an import type', () => {
    const project = projectWith({
      [OPS_FILE]:
        "export interface AdminThingDeps {\n  readonly sender: import('./ports.js').EmailSender;\n}\n" +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/EmailSender/);
  });

  it('derives a capability the post-commit half names as an import type', () => {
    const project = projectWith({
      [OPS_FILE]:
        'export interface AdminThingDeps {\n  readonly evictUser: WidgetEvictionPort;\n}\n' +
        "export interface AdminThingPostDeps {\n  readonly evictUser: import('./ports.js').WidgetEvictionPort;\n}\n" +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/WidgetEvictionPort/);
    expect(violations[0]?.line).toBe(2);
  });

  it('derives nothing from a post-commit member typed as a whole module', () => {
    const project = projectWith({
      [OPS_FILE]:
        "export interface AdminThingDeps {\n  readonly ports: import('./ports.js');\n}\n" +
        "export interface AdminThingPostDeps {\n  readonly ports: import('./ports.js');\n}\n" +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an external port written as a typeof import type', () => {
    const project = projectWith({
      [OPS_FILE]:
        "export interface AdminThingDeps {\n  readonly sender: typeof import('./ports.js').EmailSender;\n}\n" +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/EmailSender/);
  });

  it('derives a capability the post-commit half names as a typeof import type', () => {
    const project = projectWith({
      [OPS_FILE]:
        "export interface AdminThingDeps {\n  readonly evictUser: typeof import('./ports.js').widgetEvictionPort;\n}\n" +
        "export interface AdminThingPostDeps {\n  readonly evictUser: typeof import('./ports.js').widgetEvictionPort;\n}\n" +
        registration('AdminThingDeps', 'AdminThingPostDeps'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/widgetEvictionPort/);
    expect(violations[0]?.line).toBe(2);
  });

  it('ignores a type parameter standing at the dependency position', () => {
    const project = projectWith({
      'apps/api/src/slices/admin/domain/engine.ts':
        'export interface AdminOpEngineDeps<Deps, PostDeps> {\n' +
        '  readonly registry: AdminOpRegistry<Deps, PostDeps>;\n' +
        '}\n',
    });

    expect(rule.check(project)).toEqual([]);
  });
});

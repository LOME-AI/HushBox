import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, {
  CONSOLE_TELEMETRY_CALLERS,
} from './console-telemetry-only-where-nothing-composed.rule.js';

/**
 * Every declared caller must exist or the rule aborts, so each fixture project
 * carries a stub for all of them; a fixture overrides one by naming it.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const caller of CONSOLE_TELEMETRY_CALLERS) {
    if (caller in files) continue;
    project.createSourceFile(caller, 'export const placeholder = 1;\n');
  }
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/** The shape the rule exists to refuse: a capability factory minting its own sink. */
const PRIVATE_SINK =
  "import { createConsoleTelemetry } from '../lib/telemetry/index.js';\n" +
  'export function createMembershipPushNotify(env: Bindings, db: Database) {\n' +
  '  return build({ env, db, telemetry: createConsoleTelemetry() });\n' +
  '}\n';

describe('console-telemetry-only-where-nothing-composed', () => {
  it('passes when only the declared callers name the sink factory', () => {
    const project = projectWith({
      'apps/api/src/lib/telemetry/console-adapter.ts':
        'export function createConsoleTelemetry(sink = console) {\n  return sink;\n}\n',
      'apps/api/src/app.ts':
        "import { createConsoleTelemetry } from './lib/telemetry/index.js';\n" +
        "const logger = readPipelineVariable(c, 'logger') ?? createConsoleTelemetry();\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a composition-root capability factory minting a private sink', () => {
    const project = projectWith({ 'apps/api/src/composition/push-notify.ts': PRIVATE_SINK });

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({
      file: 'apps/api/src/composition/push-notify.ts',
      line: 1,
    });
    expect(violations[1]).toMatchObject({
      file: 'apps/api/src/composition/push-notify.ts',
      line: 3,
    });
    expect(violations[0]?.message).toContain('createConsoleTelemetry');
  });

  it('flags a caller reaching the sink through a re-exporting door', () => {
    const project = projectWith({
      'apps/api/src/slices/media/adapters/reclaim.ts':
        "import { createConsoleTelemetry } from '@hushbox/api/dev-seed';\n" +
        'export const telemetry = createConsoleTelemetry();\n',
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('flags a namespace import reaching the sink off the module object', () => {
    const project = projectWith({
      'apps/api/src/slices/media/adapters/reclaim.ts':
        "import * as telemetryModule from '../../../lib/telemetry/index.js';\n" +
        'export const telemetry = telemetryModule.createConsoleTelemetry();\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an aliased import, which renames the reference but not the sink', () => {
    const project = projectWith({
      'apps/api/src/slices/media/adapters/reclaim.ts':
        "import { createConsoleTelemetry as logger } from '../../../lib/telemetry/index.js';\n" +
        'export const telemetry = logger();\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('exempts test files, which may mint a sink to read what a unit emits', () => {
    const project = projectWith({
      'apps/api/src/composition/push-notify.test.ts': PRIVATE_SINK,
      'e2e/helpers/logging.setup.ts': PRIVATE_SINK,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a mention that names no reference', () => {
    const project = projectWith({
      'apps/api/src/composition/push-notify.ts':
        '// The room composes telemetry; nothing here calls createConsoleTelemetry.\n' +
        "export const note = 'createConsoleTelemetry';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('aborts when a declared caller names no file in the scanned tree', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const caller of CONSOLE_TELEMETRY_CALLERS.slice(1)) {
      project.createSourceFile(caller, 'export const placeholder = 1;\n');
    }

    expect(() => rule.check(project)).toThrow(/names no file/);
  });
});

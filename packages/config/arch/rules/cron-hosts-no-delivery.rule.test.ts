import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './cron-hosts-no-delivery.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const PORTS_PATH = 'apps/api/src/slices/notifications/ports/email-sender.ts';
const REGISTRY_PATH = 'apps/api/src/lib/jobs/registry.ts';
const ENTRY_PATH = 'apps/api/src/slices/admin/domain/digest.ts';
const FACTORY_PATH = 'apps/api/src/slices/notifications/adapters/email-sender-factory.ts';

const PORTS = `export interface EmailMessage {
  readonly to: string;
}
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
export interface BatchEmailSender extends EmailSender {
  sendBatch(messages: readonly EmailMessage[]): Promise<void>;
}\n`;

const REGISTRY = `export function enqueueOnlyDeps<Deps>(deps: Deps): () => Deps {
  return () => deps;
}\n`;

const FACTORY = `import type { BatchEmailSender } from '../ports/email-sender.js';
export function createEmailSenderFromEnv(env: Env): BatchEmailSender {
  return resend(env);
}\n`;

/**
 * A second factory whose port the checker CAN resolve, so a project can hold an
 * unresolvable one without the delivery-factory set emptying.
 */
const RESOLVING_FACTORY_PATH = 'apps/api/src/slices/notifications/adapters/mock-email-sender.ts';

const RESOLVING_FACTORY = `import type { BatchEmailSender } from '../ports/email-sender.js';
export function createMockEmailSender(): BatchEmailSender {
  return mock();
}\n`;

const AUDITOR_ENTRY = `export function createJobsHealthEntry(deps: Deps): CronEntry {
  return {
    name: 'jobs-health',
    run: async (): Promise<void> => {
      const stuck = await deps.probes.findStuck();
      if (stuck.length > 0) deps.telemetry.error('job stuck past its health bound');
    },
  };
}\n`;

function scanned(entry: string, extra: Record<string, string> = {}): Project {
  return projectWith({
    [PORTS_PATH]: PORTS,
    [REGISTRY_PATH]: REGISTRY,
    [FACTORY_PATH]: FACTORY,
    'apps/api/src/lib/jobs/health-entry.ts': AUDITOR_ENTRY,
    [ENTRY_PATH]: entry,
    ...extra,
  });
}

/** The live cron composition this rule must reach, and the marker it turns on. */
const LIVE_CRON = 'apps/api/src/scheduled.ts';
const LIVE_PORTS = 'apps/api/src/slices/notifications/ports/email-sender.ts';
/** The door the live factory names its port through; without it that port resolves to nothing. */
const LIVE_PORTS_BARREL = 'apps/api/src/slices/notifications/ports/index.ts';
const LIVE_FACTORY = 'apps/api/src/slices/notifications/adapters/email-sender-factory.ts';
const LIVE_MARKER = 'enqueueOnlyDeps({';

describe('cron-hosts-no-delivery', () => {
  it('accepts a read-only auditor entry', () => {
    expect(rule.check(scanned(AUDITOR_ENTRY))).toEqual([]);
  });

  it('flags a cron entry that sends inside its run', () => {
    const violations = rule.check(
      scanned(
        `export function createAdminDigestEntry(deps: Deps): CronEntry {
  return {
    name: 'admin-digest',
    run: async (): Promise<void> => {
      await deps.sender.sendBatch(deps.messages);
    },
  };
}\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRY_PATH });
    expect(violations[0]?.message).toMatch(/sendBatch/);
  });

  it('flags a cron entry written as an arrow const', () => {
    const violations = rule.check(
      scanned(
        `export const createAdminDigestEntry = (deps: Deps): CronEntry => {
  return {
    name: 'admin-digest',
    run: async (): Promise<void> => {
      await deps.sender.sendBatch(deps.messages);
    },
  };
};\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRY_PATH });
    expect(violations[0]?.message).toMatch(/sendBatch/);
  });

  it('flags a cron entry written as a function-expression const', () => {
    const violations = rule.check(
      scanned(
        `export const createAdminDigestEntry = function (deps: Deps): CronEntry {
  return {
    name: 'admin-digest',
    run: async (): Promise<void> => {
      await deps.sender.sendBatch(deps.messages);
    },
  };
};\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRY_PATH });
    expect(violations[0]?.message).toMatch(/sendBatch/);
  });

  it('flags a cron entry whose type sits on the binding rather than on the function', () => {
    const violations = rule.check(
      scanned(
        `type MakeDigestEntry = (deps: Deps) => CronEntry;
export const createAdminDigestEntry: MakeDigestEntry = (deps) => ({
  name: 'admin-digest',
  run: async (): Promise<void> => {
    await deps.sender.sendBatch(deps.messages);
  },
});\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRY_PATH });
    expect(violations[0]?.message).toMatch(/sendBatch/);
  });

  it('flags a cron entry whose inferred return type resolves to a CronEntry', () => {
    const violations = rule.check(
      scanned(
        `declare const entry: CronEntry;
export const createAdminDigestEntry = (deps: Deps) => {
  void deps.sender.sendBatch(deps.messages);
  return entry;
};\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRY_PATH });
    expect(violations[0]?.message).toMatch(/sendBatch/);
  });

  it('reads the function where the binding types itself as nothing callable', () => {
    const violations = rule.check(
      scanned(
        `type MakeDigestEntry = (deps: Deps) => CronEntry;
export const createAdminDigestEntry: MakeDigestEntry | undefined = (deps): CronEntry => ({
  name: 'admin-digest',
  run: async (): Promise<void> => {
    await deps.sender.sendBatch(deps.messages);
  },
});\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRY_PATH });
    expect(violations[0]?.message).toMatch(/sendBatch/);
  });

  it('flags delivery reached through a helper in the same module', () => {
    expect(
      rule.check(
        scanned(
          `async function mail(deps: Deps): Promise<void> {
  await deps.sender.send(deps.message);
}
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toHaveLength(1);
  });

  it('follows an arrow-function helper in the same module', () => {
    expect(
      rule.check(
        scanned(
          `const mail = async (deps: Deps): Promise<void> => {
  await deps.sender.send(deps.message);
};
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toHaveLength(1);
  });

  it('follows a function-expression helper in the same module', () => {
    expect(
      rule.check(
        scanned(
          `const mail = async function (deps: Deps): Promise<void> {
  await deps.sender.send(deps.message);
};
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toHaveLength(1);
  });

  it('follows a helper that calls itself', () => {
    expect(
      rule.check(
        scanned(
          `async function mail(deps: Deps): Promise<void> {
  await deps.sender.send(deps.message);
  if (deps.retry) await mail(deps);
}
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toHaveLength(1);
  });

  it('follows a mutually recursive pair of helpers', () => {
    expect(
      rule.check(
        scanned(
          `async function mail(deps: Deps): Promise<void> {
  await deps.sender.send(deps.message);
  await retry(deps);
}
async function retry(deps: Deps): Promise<void> {
  await mail(deps);
}
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toHaveLength(1);
  });

  it('accepts a name bound to something that is not a function', () => {
    expect(
      rule.check(
        scanned(
          `const mail = { sender: null };
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: async (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toEqual([]);
  });

  it('accepts a declared binding that has no initializer', () => {
    expect(
      rule.check(
        scanned(
          `declare const mail: (deps: Deps) => Promise<void>;
export function createAdminDigestEntry(deps: Deps): CronEntry {
  return { name: 'admin-digest', run: async (): Promise<void> => mail(deps) };
}\n`
        )
      )
    ).toEqual([]);
  });

  it('accepts a send that only the job handler beside the entry reaches', () => {
    expect(
      rule.check(
        scanned(
          `export function createAdminDigestJobRegistration(deps: Deps) {
  return {
    handler: async (): Promise<void> => {
      await deps.resolveSend().sender.sendBatch(deps.messages);
    },
  };
}
export function createAdminDigestEnqueueEntry(deps: Deps): CronEntry {
  return {
    name: 'admin-digest-enqueue',
    run: async (): Promise<void> => {
      await deps.db.transaction((tx) => enqueueWithinTx(tx, deps.resolveRegistry(), deps.job));
    },
  };
}\n`
        )
      )
    ).toEqual([]);
  });

  it('accepts a delivery port built as an enqueue-only dependency', () => {
    expect(
      rule.check(
        scanned(
          `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [
    createAdminDigestEnqueueEntry({
      resolveSend: enqueueOnlyDeps({ sender: createEmailSenderFromEnv(deps.env) }),
    }),
  ];
}\n`
        )
      )
    ).toEqual([]);
  });

  it('flags a delivery port built live in the cron composition', () => {
    const violations = rule.check(
      scanned(
        `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [createAdminDigestEnqueueEntry({ sender: createEmailSenderFromEnv(deps.env) })];
}\n`
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/enqueueOnlyDeps/);
  });

  it('flags a delivery port whose factory is written as an arrow const', () => {
    const violations = rule.check(
      scanned(
        `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [createAdminDigestEnqueueEntry({ sender: createEmailSenderFromEnv(deps.env) })];
}\n`,
        {
          [FACTORY_PATH]: `import type { BatchEmailSender } from '../ports/email-sender.js';
export const createEmailSenderFromEnv = (env: Env): BatchEmailSender => resend(env);\n`,
        }
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/enqueueOnlyDeps/);
  });

  it('flags a delivery port whose factory is written as a function-expression const', () => {
    const violations = rule.check(
      scanned(
        `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [createAdminDigestEnqueueEntry({ sender: createEmailSenderFromEnv(deps.env) })];
}\n`,
        {
          [FACTORY_PATH]: `import type { BatchEmailSender } from '../ports/email-sender.js';
export const createEmailSenderFromEnv = function (env: Env): BatchEmailSender {
  return resend(env);
};\n`,
        }
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/enqueueOnlyDeps/);
  });

  it('flags a delivery port whose factory declares the promise of that port', () => {
    const violations = rule.check(
      scanned(
        `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [createAdminDigestEnqueueEntry({ sender: createEmailSenderFromEnv(deps.env) })];
}\n`,
        {
          [FACTORY_PATH]: `import type { BatchEmailSender } from '../ports/email-sender.js';
export async function createEmailSenderFromEnv(env: Env): Promise<BatchEmailSender> {
  return resend(env);
}\n`,
        }
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/enqueueOnlyDeps/);
  });

  it('flags a delivery port whose factory types the binding rather than the function', () => {
    const violations = rule.check(
      scanned(
        `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [createAdminDigestEnqueueEntry({ sender: createEmailSenderFromEnv(deps.env) })];
}\n`,
        {
          [FACTORY_PATH]: `import type { BatchEmailSender } from '../ports/email-sender.js';
type MakeEmailSender = (env: Env) => BatchEmailSender;
export const createEmailSenderFromEnv: MakeEmailSender = (env) => resend(env);\n`,
        }
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/enqueueOnlyDeps/);
  });

  it('flags a delivery port whose factory has an inferred return resolving to that port', () => {
    const violations = rule.check(
      scanned(
        `export function cronEntriesFor(deps: Deps): CronEntry[] {
  return [createAdminDigestEnqueueEntry({ sender: createEmailSenderFromEnv(deps.env) })];
}\n`,
        {
          [FACTORY_PATH]: `import type { BatchEmailSender } from '../ports/email-sender.js';
declare const sender: BatchEmailSender;
export function createEmailSenderFromEnv(env: Env) {
  return sender;
}\n`,
        }
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/enqueueOnlyDeps/);
  });

  it('ignores a cron entry declared in a test file', () => {
    expect(
      rule.check(
        scanned(AUDITOR_ENTRY, {
          'apps/api/src/slices/admin/domain/digest.test.ts':
            "export function createFake(deps: Deps): CronEntry {\n  return { name: 'x', run: () => deps.sender.send(deps.message) };\n}\n",
        })
      )
    ).toEqual([]);
  });

  it('ignores a cron entry outside the API source tree', () => {
    expect(
      rule.check(
        scanned(AUDITOR_ENTRY, {
          'packages/realtime/src/session-sweep.ts':
            "export function createSweepEntry(deps: Deps): CronEntry {\n  return { name: 'sweep', run: () => deps.sender.send(deps.message) };\n}\n",
        })
      )
    ).toEqual([]);
  });

  it('throws when the scanned tree declares no cron entry', () => {
    expect(() =>
      rule.check(projectWith({ [PORTS_PATH]: PORTS, [REGISTRY_PATH]: REGISTRY }))
    ).toThrow(/no cron entry/);
  });

  it('throws when the scanned tree declares no delivery port', () => {
    expect(() =>
      rule.check(
        projectWith({
          [REGISTRY_PATH]: REGISTRY,
          'apps/api/src/lib/jobs/health-entry.ts': AUDITOR_ENTRY,
        })
      )
    ).toThrow(/no delivery port/);
  });

  it('throws when the enqueue-only marker is gone', () => {
    expect(() =>
      rule.check(
        projectWith({
          [PORTS_PATH]: PORTS,
          'apps/api/src/lib/jobs/health-entry.ts': AUDITOR_ENTRY,
        })
      )
    ).toThrow(/enqueueOnlyDeps/);
  });

  it('throws when the scanned tree declares no delivery-port factory', () => {
    expect(() =>
      rule.check(
        projectWith({
          [PORTS_PATH]: PORTS,
          [REGISTRY_PATH]: REGISTRY,
          'apps/api/src/lib/jobs/health-entry.ts': AUDITOR_ENTRY,
        })
      )
    ).toThrow(/no function producing a delivery port/);
  });

  it('throws when a function names a delivery port the checker cannot resolve', () => {
    expect(() =>
      rule.check(
        projectWith({
          [PORTS_PATH]: readFileSync(path.join(REPO_ROOT, PORTS_PATH), 'utf8'),
          [REGISTRY_PATH]: REGISTRY,
          'apps/api/src/lib/jobs/health-entry.ts': AUDITOR_ENTRY,
          [RESOLVING_FACTORY_PATH]: RESOLVING_FACTORY,
          [FACTORY_PATH]: readFileSync(path.join(REPO_ROOT, FACTORY_PATH), 'utf8'),
        })
      )
    ).toThrow(/BatchEmailSender/);
  });

  it('throws when an unresolvable delivery port is named inside a promise', () => {
    expect(() =>
      rule.check(
        projectWith({
          [PORTS_PATH]: PORTS,
          [REGISTRY_PATH]: REGISTRY,
          'apps/api/src/lib/jobs/health-entry.ts': AUDITOR_ENTRY,
          [RESOLVING_FACTORY_PATH]: RESOLVING_FACTORY,
          [FACTORY_PATH]: `import type { BatchEmailSender } from '../ports/index.js';
export async function createEmailSenderFromEnv(env: Env): Promise<BatchEmailSender> {
  return resend(env);
}\n`,
        })
      )
    ).toThrow(/Promise<BatchEmailSender>/);
  });

  describe('against the live cron composition it must reach', () => {
    function liveProject(cronSource: string): Project {
      return projectWith({
        [LIVE_CRON]: cronSource,
        [LIVE_PORTS]: readFileSync(path.join(REPO_ROOT, LIVE_PORTS), 'utf8'),
        [LIVE_PORTS_BARREL]: readFileSync(path.join(REPO_ROOT, LIVE_PORTS_BARREL), 'utf8'),
        [LIVE_FACTORY]: readFileSync(path.join(REPO_ROOT, LIVE_FACTORY), 'utf8'),
        [REGISTRY_PATH]: readFileSync(path.join(REPO_ROOT, REGISTRY_PATH), 'utf8'),
      });
    }

    const source = readFileSync(path.join(REPO_ROOT, LIVE_CRON), 'utf8');

    it('passes the composition that keeps its email sender enqueue-only', () => {
      expect(source).toContain(LIVE_MARKER);
      expect(rule.check(liveProject(source))).toEqual([]);
    });

    it('flags that same composition once the enqueue-only wrapper is gone', () => {
      const mutated = source.replace(LIVE_MARKER, 'liveDeps({');
      expect(mutated).not.toEqual(source);

      const violations = rule.check(liveProject(mutated));

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: LIVE_CRON });
    });
  });
});

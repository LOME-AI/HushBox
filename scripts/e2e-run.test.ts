import { describe, it, expect } from 'vitest';
import { portFor } from './lib/stack/port-plan.js';
import { stackModeFrom } from './lib/stack/stack-mode.js';
import { stackSlotFrom } from './lib/stack/stack-slot.js';
import { playwrightTestArgs, runE2eTests } from './e2e-run.js';

describe('playwrightTestArgs', () => {
  it('runs the whole suite when the caller passes nothing', () => {
    expect(playwrightTestArgs([])).toEqual(['test']);
  });

  it('forwards a caller’s arguments in order behind the test subcommand', () => {
    expect(playwrightTestArgs(['e2e/chat/smart-model.spec.ts', '--project=chromium'])).toEqual([
      'test',
      'e2e/chat/smart-model.spec.ts',
      '--project=chromium',
    ]);
  });

  it('drops the separator pnpm inserts ahead of a caller’s arguments', () => {
    expect(
      playwrightTestArgs(['--', 'e2e/chat/smart-model.spec.ts', '-g', 'renders a cost'])
    ).toEqual(['test', 'e2e/chat/smart-model.spec.ts', '-g', 'renders a cost']);
  });

  it('drops the separator behind arguments the script itself supplied', () => {
    expect(
      playwrightTestArgs([
        '--project=chromium',
        '--',
        'e2e/chat/smart-model.spec.ts',
        '-g',
        'a name',
      ])
    ).toEqual(['test', '--project=chromium', 'e2e/chat/smart-model.spec.ts', '-g', 'a name']);
  });

  it('leaves a second separator for playwright to answer for', () => {
    expect(playwrightTestArgs(['--', '--', 'e2e/chat/smart-model.spec.ts'])).toEqual([
      'test',
      '--',
      'e2e/chat/smart-model.spec.ts',
    ]);
  });
});

interface RecordedSpawn {
  command: string;
  args: readonly string[];
  ports: readonly number[];
}

function recorder(): {
  recorded: RecordedSpawn[];
  spawn: (command: string, args: readonly string[], ports: readonly number[]) => Promise<number>;
} {
  const recorded: RecordedSpawn[] = [];
  return {
    recorded,
    spawn: (command, args, ports): Promise<number> => {
      recorded.push({ command, args, ports });
      return Promise.resolve(0);
    },
  };
}

/** The stack the loaded environment names, which the declared servers bind on. */
const STACK = {
  slot: stackSlotFrom(process.env),
  mode: stackModeFrom(process.env),
} as const;

describe('runE2eTests', () => {
  it("runs playwright's test subcommand behind the caller's arguments", async () => {
    const { recorded, spawn } = recorder();

    await runE2eTests(['--project=chromium'], process.env, spawn);

    expect(recorded[0]).toMatchObject({
      command: 'playwright',
      args: ['test', '--project=chromium'],
    });
  });

  it('claims the port of every server the run declares', async () => {
    const { recorded, spawn } = recorder();

    await runE2eTests([], process.env, spawn);

    expect(recorded[0]?.ports).toEqual(
      expect.arrayContaining(
        (['preview', 'api', 'apiInspector', 'admin', 'sandbox'] as const).map((service) =>
          portFor(service, STACK)
        )
      )
    );
  });

  it('claims no port of a mode-banded server another command starts', async () => {
    const { recorded, spawn } = recorder();

    await runE2eTests([], process.env, spawn);

    // The bundler, the static site, the database studio and the audit console
    // share this band and are started elsewhere. Claiming one would make a dead
    // starter's orphan read live and attributed to this run, which no reclaimer
    // may then touch.
    for (const elsewhere of ['vite', 'astro', 'studio', 'docket'] as const) {
      expect(recorded[0]?.ports).not.toContain(portFor(elsewhere, STACK));
    }
  });

  it('hands back what the test run exited with', async () => {
    await expect(runE2eTests([], process.env, () => Promise.resolve(3))).resolves.toBe(3);
  });
});

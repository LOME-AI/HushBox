import { describe, it, expect } from 'vitest';
import { runDevServers } from './dev.js';

interface RecordedSpawn {
  command: string;
  args: readonly string[];
  ports: readonly number[];
}

/**
 * A generated environment carrying every mode-banded port of one stack, each a
 * different number so an assertion names one service and no other.
 */
const BANDED_PORTS: NodeJS.ProcessEnv = {
  HB_VITE_PORT: '10000',
  HB_PREVIEW_PORT: '10200',
  HB_API_PORT: '10400',
  HB_ASTRO_PORT: '11000',
  HB_EMULATOR_VNC_PORT: '11400',
  HB_README_PREVIEW_PORT: '11600',
  HB_STUDIO_PORT: '12000',
  HB_ADMIN_PORT: '12200',
  HB_CRAWLER_VIEW_PORT: '12400',
  HB_SANDBOX_PORT: '12600',
  HB_DOCKET_PORT: '12800',
  HB_API_INSPECTOR_PORT: '13100',
};

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

describe('runDevServers', () => {
  it("runs turbo's dev task", async () => {
    const { recorded, spawn } = recorder();

    await runDevServers(BANDED_PORTS, spawn);

    expect(recorded[0]).toMatchObject({ command: 'turbo', args: ['dev'] });
  });

  it('claims the port of every server the workspace starts a dev task for', async () => {
    const { recorded, spawn } = recorder();

    await runDevServers(BANDED_PORTS, spawn);

    expect(recorded[0]?.ports).toEqual(
      expect.arrayContaining([10_000, 10_400, 11_000, 12_000, 12_200, 12_400, 12_600, 13_100])
    );
  });

  it('claims no port of a mode-banded server another command starts', async () => {
    const { recorded, spawn } = recorder();

    await runDevServers(BANDED_PORTS, spawn);

    // The preview server, the audit console, the readme preview and the
    // emulator's remote display share this band and are started elsewhere.
    // Claiming one would make a dead starter's orphan read live and attributed
    // here, which no reclaimer may then touch.
    expect(recorded[0]?.ports).not.toContain(10_200);
    expect(recorded[0]?.ports).not.toContain(11_400);
    expect(recorded[0]?.ports).not.toContain(11_600);
    expect(recorded[0]?.ports).not.toContain(12_800);
  });

  it('claims the ports of the stack the run loaded, which its servers read too', async () => {
    const { recorded, spawn } = recorder();

    await runDevServers({ ...BANDED_PORTS, HB_VITE_PORT: '10001' }, spawn);

    expect(recorded[0]?.ports).toContain(10_001);
  });

  it('hands back what the servers exited with', async () => {
    await expect(runDevServers(BANDED_PORTS, () => Promise.resolve(3))).resolves.toBe(3);
  });
});

/**
 * `pnpm db:up` client-authentication gate. Every other local entry point makes
 * the stack ready through `scripts/ensure-stack-cli.ts`, which repairs the
 * method the cluster asks for as one of its steps; this one brings the
 * containers up by itself and would otherwise skip it, leaving a volume older
 * than the compose setting refusing the driver's pipelined connect on every
 * call. Reuses the single repair (`ensurePostgresAcceptsPassword`); this file
 * is only real-IO wiring, mirroring ensure-stack-cli.ts.
 */
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { postgresRoleFrom } from './lib/stack/compose-env.js';
import { ensurePostgresAcceptsPassword } from './lib/stack/postgres-auth-method.js';
import { createDockerPostgresAuthDeps } from './lib/stack/postgres-auth-method-docker.js';

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */
async function main(): Promise<void> {
  const deps = createDockerPostgresAuthDeps(
    async (args) => {
      const result = await execa('docker', [...args], {
        cwd: process.cwd(),
        env: process.env,
        reject: false,
      });
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    {
      role: postgresRoleFrom(process.env),
      report: (message) => {
        console.log(message);
      },
    }
  );
  await ensurePostgresAcceptsPassword(deps);
}

if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */

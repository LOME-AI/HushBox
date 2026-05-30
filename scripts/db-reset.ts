import { execa } from 'execa';
import { config } from 'dotenv';
import path from 'node:path';
import { startDocker, runMigrations, runSeed } from './dev.js';

interface DockerContainer {
  Service: string;
}

async function isPostgresRunning(): Promise<boolean> {
  const result = await execa('docker', [
    'compose',
    'ps',
    '--status',
    'running',
    '--format',
    'json',
  ]);

  if (!result.stdout.trim()) {
    return false;
  }

  // Output is newline-delimited JSON (one object per line)
  const lines = result.stdout.trim().split('\n');
  const containers = lines.map((line) => JSON.parse(line) as DockerContainer);
  return containers.some((c) => c.Service === 'postgres');
}

async function resetDatabase(): Promise<void> {
  // Env files are the caller's responsibility — regenerating here would clobber
  // a preceding `pnpm generate:env --mode=e2e` and silently strip `VITE_E2E`
  // before the build reads it.
  config({ path: path.resolve(process.cwd(), '.env.development') });
  config({ path: path.resolve(process.cwd(), '.env.scripts') });

  const wasRunning = await isPostgresRunning();
  console.log(`Database was ${wasRunning ? 'running' : 'not running'}`);

  console.log('Destroying database volumes...');
  await execa('docker', ['compose', 'down', '-v'], { stdio: 'inherit' });

  if (wasRunning) {
    console.log('Restarting database...');
    await startDocker();
    await runMigrations();
    await runSeed();
    console.log('Database reset complete');
  } else {
    console.log('Database volumes destroyed (not restarting - was not running)');
  }
}

resetDatabase().catch((error: unknown) => {
  console.error('Database reset failed:', error);
  process.exit(1);
});

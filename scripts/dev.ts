import { execa } from 'execa';
import { config } from 'dotenv';
import path from 'node:path';
import { generateEnvFiles } from './generate-env.js';
import { seed } from './seed.js';

const DOCKER_SERVICES = ['postgres', 'neon-proxy', 'redis', 'serverless-redis-http'];

export async function startDocker(): Promise<void> {
  console.log('Starting Docker services...');
  await execa('docker', ['compose', 'up', '-d', '--wait', ...DOCKER_SERVICES], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('Docker services ready');
}

export async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');
  await execa('pnpm', ['--filter', '@hushbox/db', 'db:migrate'], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('Migrations complete');
}

export function startDrizzleStudio(): void {
  console.log('Starting Drizzle Studio...');
  const subprocess = execa('pnpm', ['--filter', '@hushbox/db', 'db:studio'], {
    stdio: 'ignore',
    env: process.env,
  });
  // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget subprocess, function must stay synchronous
  subprocess.catch(() => {
    console.warn('Drizzle Studio failed to start (non-fatal)');
  });
  console.log('Drizzle Studio available at https://local.drizzle.studio');
}

export async function runSeed(): Promise<void> {
  console.log('Seeding database...');
  await seed();
}

export async function startTurbo(): Promise<void> {
  console.log('Starting dev servers...');
  await execa('turbo', ['dev'], {
    stdio: 'inherit',
    env: process.env,
  });
}

export async function main(): Promise<void> {
  generateEnvFiles(process.cwd());
  config({ path: path.resolve(process.cwd(), '.env.development') });
  config({ path: path.resolve(process.cwd(), '.env.scripts') });
  await startDocker();
  await runMigrations();
  startDrizzleStudio();
  await runSeed();
  await startTurbo();
}

// Only run main if this is the entry point
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Dev startup failed:', error);
      process.exit(1);
    }
  })();
}

import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export async function runWranglerDev(): Promise<number> {
  const port = process.env['HB_API_PORT'];
  if (!port) {
    throw new Error('HB_API_PORT is not set — run pnpm generate:env first');
  }
  const result = await execa('wrangler', ['dev', '--port', port], {
    stdio: 'inherit',
    reject: false,
  });
  return typeof result.exitCode === 'number' ? result.exitCode : 1;
}

/* v8 ignore start -- CLI entry point exercised via apps/api dev script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runWranglerDev());
}
/* v8 ignore stop */

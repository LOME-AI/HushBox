import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export async function runDrizzleStudio(): Promise<number> {
  const port = process.env['HB_STUDIO_PORT'];
  if (!port) {
    throw new Error('HB_STUDIO_PORT is not set — run pnpm generate:env first');
  }
  const result = await execa('drizzle-kit', ['studio', `--port=${port}`], {
    stdio: 'inherit',
    reject: false,
  });
  return typeof result.exitCode === 'number' ? result.exitCode : 1;
}

/* v8 ignore start -- CLI entry point exercised via packages/db db:studio script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runDrizzleStudio());
}
/* v8 ignore stop */

import { execa } from 'execa';
import concurrently from 'concurrently';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export interface PreviewConfig {
  name: string;
  command: string;
}

export async function runBuild(): Promise<void> {
  await execa('pnpm', ['--filter', '@hushbox/web', 'build', '--mode', 'development'], {
    stdio: 'inherit',
  });
}

export async function runConcurrent(): Promise<void> {
  const port = process.env['HB_PREVIEW_PORT'];
  if (!port) {
    throw new Error('HB_PREVIEW_PORT is not set — run pnpm generate:env first');
  }
  const commands: PreviewConfig[] = [
    { name: 'api', command: 'pnpm --filter @hushbox/api dev' },
    { name: 'web', command: `pnpm --filter @hushbox/web preview --port ${port} --open` },
  ];
  const { result } = concurrently(commands, {
    killOthers: ['failure', 'success'],
    prefix: 'name',
  });
  await result;
}

/* v8 ignore start -- CLI entry point exercised via root preview script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    await runBuild();
    await runConcurrent();
  });
}
/* v8 ignore stop */

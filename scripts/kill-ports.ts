import killPort from 'kill-port';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export function resolvePorts(envNames: readonly string[]): number[] {
  const ports: number[] = [];
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    ports.push(parsed);
  }
  return ports;
}

export async function killPorts(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    try {
      await killPort(port);
    } catch {
      // Match `lsof | xargs -r kill -9 || true` — silent when port not in use.
    }
  }
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    await killPorts(resolvePorts(process.argv.slice(2)));
  });
}
/* v8 ignore stop */

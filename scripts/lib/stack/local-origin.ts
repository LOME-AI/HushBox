import { portEnvName } from './dev-ports.js';
import type { ServiceKey } from './port-plan.js';

const GENERATE_HINT =
  'Run `pnpm generate:env`, and run this command through `scripts/with-env.ts` so the generated files are loaded.';

/** The highest port a host can bind, so a value above it can never be one. */
const MAX_PORT = 65_535;

/**
 * Where one service of this checkout's stack listens, read from the variable
 * {@link portEnvName} mints for it. Every port is allocated per slot, so a
 * literal names a port nothing binds in any checkout; there is no default to
 * fall back to either, because a silent fallback would send the caller at
 * another slot's stack instead of failing (CODE-RULES bans env fallbacks).
 */
export function localOriginFor(service: ServiceKey): string {
  const variable = portEnvName(service);
  const raw = process.env[variable];
  if (raw === undefined || raw === '') {
    throw new Error(`${variable} is not set. ${GENERATE_HINT}`);
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT) {
    throw new Error(`${variable} is not a port: "${raw}". ${GENERATE_HINT}`);
  }

  return `http://localhost:${String(port)}`;
}

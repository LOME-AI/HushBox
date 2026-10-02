#!/usr/bin/env tsx
/**
 * Service Evidence Verification Script
 *
 * Verifies that required external services were actually called during CI.
 * Works with recordServiceEvidence() from @hushbox/db.
 *
 * Usage:
 *   pnpm verify:evidence --require=openrouter-catalog
 *   pnpm verify:evidence --require=openrouter-catalog,openrouter-inference
 */
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  verifyServiceEvidence,
  SERVICE_NAMES,
  type ServiceName,
} from '@hushbox/db';
import { isMainModule } from './lib/cli/is-main.js';
import { parseOrExit } from './lib/cli/run-cli.js';
import { messageChain } from './lib/cli/run-main.js';
import {
  formatUsage,
  isHelpRequest,
  parseCommandLine,
  type CommandSpec,
} from './lib/cli/command-line.js';

const VALID_SERVICES = Object.values(SERVICE_NAMES);

interface ParsedArgs {
  require: ServiceName[];
}

export const COMMAND_LINE = {
  command: 'pnpm verify:evidence',
  summary: 'Checks that each named service left the evidence a real call would.',
  flags: [
    {
      flag: '--require',
      kind: 'value',
      placeholder: '<service,service>',
      summary: 'The services whose evidence must be present.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/**
 * Parse CLI arguments
 */
export function parseCliArgs(args: string[]): ParsedArgs | { error: string } {
  let parsed;
  try {
    parsed = parseCommandLine(COMMAND_LINE, args);
  } catch (error: unknown) {
    return { error: messageChain(error) };
  }
  // The entry point answers a usage request before reaching here, so this
  // branch serves a caller that parses without one.
  if (parsed.kind === 'help') return { error: parsed.usage };

  const servicesRaw = parsed.flags['--require'];
  if (servicesRaw === undefined) {
    return {
      error: 'Usage: pnpm verify:evidence --require=openrouter-catalog,openrouter-inference',
    };
  }

  const services = servicesRaw.split(',').map((s) => s.trim()) as ServiceName[];

  for (const service of services) {
    if (!VALID_SERVICES.includes(service)) {
      return { error: `Invalid service: ${service}. Valid services: ${VALID_SERVICES.join(', ')}` };
    }
  }

  return { require: services };
}

/**
 * Format verification result for display
 */
export function formatResult(
  result: { success: boolean; missing: ServiceName[] },
  required: ServiceName[]
): string {
  if (result.success) {
    return `✓ Verified real service calls: ${required.join(', ')}`;
  }

  return [
    `✗ Missing evidence for: ${result.missing.join(', ')}`,
    '  Tests may have used mocks or been skipped.',
  ].join('\n');
}

/* v8 ignore start -- CLI entry point uses process.exit, tested via integration */
/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(formatUsage(COMMAND_LINE));
    return;
  }
  const parsed = parseOrExit(parseCliArgs, argv);

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const db = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });

  const result = await verifyServiceEvidence(db, parsed.require);
  await db.$client.end();
  const output = formatResult(result, parsed.require);

  if (result.success) {
    console.log(output);
  } else {
    console.error(output);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  void main();
}
/* v8 ignore stop */

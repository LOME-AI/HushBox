#!/usr/bin/env tsx
/**
 * Service Evidence Verification Script
 *
 * Verifies that required external services were actually called during CI.
 * Works with recordServiceCall() from @lome-chat/shared.
 *
 * Usage:
 *   pnpm verify:evidence --require=openrouter
 *   pnpm verify:evidence --require=openrouter,hookdeck
 */
import { verifyEvidence, type ServiceName } from '@lome-chat/shared';

const VALID_SERVICES: ServiceName[] = ['openrouter', 'hookdeck'];

export interface ParsedArgs {
  require: ServiceName[];
}

/**
 * Parse CLI arguments
 */
export function parseCliArgs(args: string[]): ParsedArgs | { error: string } {
  const requireArg = args.find((arg) => arg.startsWith('--require='));

  if (!requireArg) {
    return { error: 'Usage: pnpm verify:evidence --require=openrouter,hookdeck' };
  }

  const servicesRaw = requireArg.replace('--require=', '');
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
function main(): void {
  const parsed = parseCliArgs(process.argv.slice(2));

  if ('error' in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }

  const result = verifyEvidence(parsed.require);
  const output = formatResult(result, parsed.require);

  if (result.success) {
    console.log(output);
  } else {
    console.error(output);
    process.exit(1);
  }
}

// Only run main when executed directly
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main();
}
/* v8 ignore stop */

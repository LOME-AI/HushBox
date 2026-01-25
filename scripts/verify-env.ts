#!/usr/bin/env tsx
/**
 * Environment Verification Script
 *
 * Validates that generated env files produce correct createEnvUtilities() output.
 * Mirrors the real code paths used by backend (Cloudflare Workers) and frontend (Vite).
 *
 * Usage:
 *   pnpm verify:env --mode=development
 *   pnpm verify:env --mode=ciVitest
 *   pnpm verify:env --mode=ciE2E
 *   pnpm verify:env --mode=production
 */
import { readFile } from 'node:fs/promises';
import { createEnvUtilities, type EnvContext, type EnvUtilities } from '@lome-chat/shared';

export type Mode = 'development' | 'ciVitest' | 'ciE2E' | 'production';

interface FrontendEnvVariables {
  VITE_CI?: string | undefined;
  VITE_E2E?: string | undefined;
}

interface Mismatch {
  key: keyof EnvUtilities;
  expected: boolean;
  actual: boolean;
}

interface VerificationResult {
  success: boolean;
  actual: EnvUtilities;
  expected: EnvUtilities;
  mismatches: Mismatch[];
  source: string;
  input: EnvContext;
}

interface BackendPaths {
  devVarsPath: string;
  wranglerTomlPath: string;
}

interface FrontendPaths {
  envDevelopmentPath: string;
}

function stripQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

/**
 * Parse .dev.vars file to extract NODE_ENV, CI, E2E
 * Handles both quoted and unquoted values (e.g., NODE_ENV="development" or NODE_ENV=development)
 */
export async function parseDevVariables(filePath: string): Promise<EnvContext> {
  const content = await readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const variables: Record<string, string> = {};

  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    variables[match[1]] = stripQuotes(match[2]);
  }

  return {
    ...(variables['NODE_ENV'] !== undefined && { NODE_ENV: variables['NODE_ENV'] }),
    ...(variables['CI'] !== undefined && { CI: variables['CI'] }),
    ...(variables['E2E'] !== undefined && { E2E: variables['E2E'] }),
  };
}

/**
 * Parse wrangler.toml [vars] section to extract NODE_ENV
 */
export async function parseWranglerToml(filePath: string): Promise<EnvContext> {
  const content = await readFile(filePath, 'utf8');

  // Simple TOML parsing for [vars] section
  const variablesMatch = /\[vars\]([\s\S]*?)(?:\[|$)/.exec(content);
  if (!variablesMatch?.[1]) {
    return {};
  }

  const variablesSection = variablesMatch[1];
  const variables: Record<string, string> = {};

  const lineRegex = /^([A-Z_]+)\s*=\s*"([^"]*)"$/gm;
  let match;
  while ((match = lineRegex.exec(variablesSection)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      variables[key] = value;
    }
  }

  return {
    ...(variables['NODE_ENV'] !== undefined && { NODE_ENV: variables['NODE_ENV'] }),
    ...(variables['CI'] !== undefined && { CI: variables['CI'] }),
    ...(variables['E2E'] !== undefined && { E2E: variables['E2E'] }),
  };
}

/**
 * Parse .env.development file to extract VITE_CI
 */
export async function parseEnvDevelopment(filePath: string): Promise<FrontendEnvVariables> {
  const content = await readFile(filePath, 'utf8');
  const lines = content.split('\n');

  const variables: Record<string, string> = {};
  for (const line of lines) {
    const match = /^(VITE_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) {
        variables[key] = value;
      }
    }
  }

  return {
    VITE_CI: variables['VITE_CI'],
    VITE_E2E: variables['VITE_E2E'],
  };
}

/**
 * Get expected EnvUtilities output for a given mode
 */
export function getExpectedEnvUtilities(mode: Mode): EnvUtilities {
  const expectations: Record<Mode, EnvUtilities> = {
    development: {
      isDev: true,
      isLocalDev: true,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    },
    ciVitest: {
      isDev: true,
      isLocalDev: false,
      isProduction: false,
      isCI: true,
      isE2E: false,
      requiresRealServices: true,
    },
    ciE2E: {
      isDev: true,
      isLocalDev: false,
      isProduction: false,
      isCI: true,
      isE2E: true,
      requiresRealServices: true,
    },
    production: {
      isDev: false,
      isLocalDev: false,
      isProduction: true,
      isCI: false,
      isE2E: false,
      requiresRealServices: true,
    },
  };

  return expectations[mode];
}

/**
 * Compare actual vs expected EnvUtils and return mismatches
 */
function compareEnvUtilities(actual: EnvUtilities, expected: EnvUtilities): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const keys: (keyof EnvUtilities)[] = [
    'isDev',
    'isLocalDev',
    'isProduction',
    'isCI',
    'isE2E',
    'requiresRealServices',
  ];

  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      mismatches.push({
        key,
        expected: expected[key],
        actual: actual[key],
      });
    }
  }

  return mismatches;
}

/**
 * Verify backend environment for a given mode
 */
export async function verifyBackendEnv(
  mode: Mode,
  paths: BackendPaths
): Promise<VerificationResult> {
  let envContext: EnvContext;
  let source: string;

  if (mode === 'production') {
    envContext = await parseWranglerToml(paths.wranglerTomlPath);
    source = paths.wranglerTomlPath;
  } else {
    envContext = await parseDevVariables(paths.devVarsPath);
    source = paths.devVarsPath;
  }

  const actual = createEnvUtilities(envContext);
  const expected = getExpectedEnvUtilities(mode);
  const mismatches = compareEnvUtilities(actual, expected);

  return {
    success: mismatches.length === 0,
    actual,
    expected,
    mismatches,
    source,
    input: envContext,
  };
}

/**
 * Verify frontend environment for a given mode
 */
export async function verifyFrontendEnv(
  mode: Mode,
  paths: FrontendPaths
): Promise<VerificationResult> {
  let envContext: EnvContext;
  let source: string;

  if (mode === 'production') {
    // Production frontend uses Vite MODE=production, no .env.development
    envContext = { NODE_ENV: 'production' };
    source = 'Vite MODE=production (no file)';
  } else {
    // Dev/CI modes use .env.development for VITE_CI
    const frontendVariables = await parseEnvDevelopment(paths.envDevelopmentPath);
    // Frontend uses import.meta.env.MODE which is 'development' in dev/CI builds
    envContext = {
      NODE_ENV: 'development',
      ...(frontendVariables.VITE_CI !== undefined && { CI: frontendVariables.VITE_CI }),
      ...(frontendVariables.VITE_E2E !== undefined && { E2E: frontendVariables.VITE_E2E }),
    };
    source = `${paths.envDevelopmentPath} + MODE=development`;
  }

  const actual = createEnvUtilities(envContext);
  const expected = getExpectedEnvUtilities(mode);
  const mismatches = compareEnvUtilities(actual, expected);

  return {
    success: mismatches.length === 0,
    actual,
    expected,
    mismatches,
    source,
    input: envContext,
  };
}

/**
 * Format EnvUtilities as a string for display
 */
export function formatEnvUtilities(env: EnvUtilities): string {
  return `isDev=${String(env.isDev)}, isLocalDev=${String(env.isLocalDev)}, isProduction=${String(env.isProduction)}, isCI=${String(env.isCI)}, isE2E=${String(env.isE2E)}, requiresRealServices=${String(env.requiresRealServices)}`;
}

/**
 * Format EnvContext as a string for display
 */
export function formatEnvContext(ctx: EnvContext): string {
  return `NODE_ENV=${ctx.NODE_ENV ?? 'undefined'}, CI=${ctx.CI ?? 'undefined'}, E2E=${ctx.E2E ?? 'undefined'}`;
}

/**
 * Parse CLI arguments and return the mode
 */
export function parseCliArgs(args: string[]): { mode: Mode } | { error: string } {
  const modeArgument = args.find((argument) => argument.startsWith('--mode='));

  if (!modeArgument) {
    return { error: 'Usage: pnpm verify:env --mode=<development|ciVitest|ciE2E|production>' };
  }

  const mode = modeArgument.replace('--mode=', '');
  const validModes: Mode[] = ['development', 'ciVitest', 'ciE2E', 'production'];

  if (!validModes.includes(mode as Mode)) {
    return { error: `Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}` };
  }

  return { mode: mode as Mode };
}

export interface VerifyAllResult {
  backend: VerificationResult | { error: string };
  frontend: VerificationResult | { error: string };
  success: boolean;
}

/**
 * Run verification for both backend and frontend
 */
export async function verifyAll(
  mode: Mode,
  paths: BackendPaths & FrontendPaths
): Promise<VerifyAllResult> {
  let backend: VerificationResult | { error: string };
  let frontend: VerificationResult | { error: string };

  try {
    backend = await verifyBackendEnv(mode, paths);
  } catch (error) {
    backend = { error: (error as Error).message };
  }

  try {
    frontend = await verifyFrontendEnv(mode, paths);
  } catch (error) {
    frontend = { error: (error as Error).message };
  }

  const backendSuccess = !('error' in backend) && backend.success;
  const frontendSuccess = !('error' in frontend) && frontend.success;

  return {
    backend,
    frontend,
    success: backendSuccess && frontendSuccess,
  };
}

/**
 * Print verification result for a target (backend/frontend)
 */
export function printVerificationResult(
  target: 'Backend' | 'Frontend',
  result: VerificationResult | { error: string }
): void {
  if ('error' in result) {
    console.error(`  ✗ ${target} verification error: ${result.error}`);
    return;
  }

  if (result.success) {
    console.log(`  ✓ ${target} environment verification passed`);
    console.log(`    Source: ${result.source}`);
    console.log(`    Input: ${formatEnvContext(result.input)}`);
    console.log(`    Output: ${formatEnvUtilities(result.actual)}`);
  } else {
    console.error(`  ✗ ${target} environment verification FAILED`);
    console.error(`    Source: ${result.source}`);
    console.error(`    Input: ${formatEnvContext(result.input)}`);
    for (const mismatch of result.mismatches) {
      console.error(`    Expected: ${mismatch.key}=${String(mismatch.expected)}`);
      console.error(`    Actual:   ${mismatch.key}=${String(mismatch.actual)}`);
    }
  }
}

/* v8 ignore start -- CLI entry point uses process.exit, tested via integration */
/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));

  if ('error' in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }

  const { mode } = parsed;

  const paths = {
    devVarsPath: 'apps/api/.dev.vars',
    wranglerTomlPath: 'apps/api/wrangler.toml',
    envDevelopmentPath: '.env.development',
  };

  console.log(`\nVerifying environment for mode: ${mode}`);

  const result = await verifyAll(mode, paths);

  console.log('\nBackend:');
  printVerificationResult('Backend', result.backend);

  console.log('\nFrontend:');
  printVerificationResult('Frontend', result.frontend);

  if (!result.success) {
    console.error('\nEnvironment verification failed. Check env.config.ts or generate-env.ts.');
    process.exit(1);
  }

  console.log('\n✓ All environment verifications passed');
}

// Only run main when executed directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Unexpected error:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */

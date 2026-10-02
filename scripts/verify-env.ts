#!/usr/bin/env tsx
/**
 * Environment Verification Script
 *
 * Validates that generated env files produce correct createEnvUtilities() output.
 * Mirrors the real code paths used by backend (Cloudflare Workers) and frontend (Vite).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CLASSIFICATION_VARIABLES,
  createEnvUtilities,
  getModeValue,
  Mode,
  resolveRaw,
  type EnvContext,
  type EnvMode,
  type EnvUtilities,
  type VariableConfig,
} from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { isMainModule } from './lib/cli/is-main.js';
import { parseOrExit } from './lib/cli/run-cli.js';
import { messageChain } from './lib/cli/run-main.js';
import {
  formatUsage,
  isHelpRequest,
  parseCommandLine,
  type CommandSpec,
} from './lib/cli/command-line.js';
import { generatedEnvPaths } from './generate-env.js';
import { frontendModeFor, writesStackFiles } from './lib/stack/stack-mode.js';
import { clearUnemittedClassification, ENV_MODE_VARIABLE } from './with-env.js';

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
  frontendEnvPath: string;
}

interface ScriptsPaths {
  scriptsEnvPath: string;
}

export type VerifiedEnvPaths = BackendPaths & FrontendPaths & ScriptsPaths;

/**
 * The generated files a mode's verification reads.
 *
 * The three generated files come from {@link generatedEnvPaths}, the one answer
 * to where a mode's files land, so a mode is verified against exactly what its
 * own generation writes; wrangler.toml is a committed file carrying a generated
 * block, named here rather than resolved. Verifying the fixed development
 * triple instead is what left CI's e2e job checking files a fresh checkout
 * never generates.
 */
export function envPathsFor(mode: EnvMode): VerifiedEnvPaths {
  const paths = generatedEnvPaths(mode);
  return {
    devVarsPath: paths.backend,
    wranglerTomlPath: path.join('apps', 'api', 'wrangler.toml'),
    frontendEnvPath: paths.frontend,
    scriptsEnvPath: paths.scripts,
  };
}

function stripQuotes(value: string): string {
  const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
  return isDoubleQuoted || isSingleQuoted ? value.slice(1, -1) : value;
}

/**
 * Read a generated env file's `KEY=value` pairs.
 * Handles both quoted and unquoted values (e.g., NODE_ENV="development" or NODE_ENV=development)
 */
async function readEnvFileVariables(filePath: string): Promise<Record<string, string>> {
  const content = await readFile(filePath, 'utf8');
  const variables: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    variables[match[1]] = stripQuotes(match[2]);
  }

  return variables;
}

/**
 * Parse .dev.vars file to extract the variables the derived flags rest on.
 */
export async function parseDevVariables(filePath: string): Promise<EnvContext> {
  return buildEnvContext(await readEnvFileVariables(filePath));
}

/**
 * The classification variables a record carries, as an {@link EnvContext}.
 *
 * Which names those are comes from {@link CLASSIFICATION_VARIABLES} rather than
 * from a list spelled here: the loader clears exactly that set, and a verifier
 * reading a different one would model an environment no command ever runs in.
 */
function buildEnvContext(variables: Record<string, string | undefined>): EnvContext {
  const context: EnvContext = {};
  for (const name of CLASSIFICATION_VARIABLES) {
    const value = variables[name];
    if (value !== undefined) context[name] = value;
  }
  return context;
}

/**
 * Parse wrangler.toml [vars] section to extract NODE_ENV
 */
export async function parseWranglerToml(filePath: string): Promise<EnvContext> {
  const content = await readFile(filePath, 'utf8');

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

  return buildEnvContext(variables);
}

/**
 * Parse a generated frontend env file to extract VITE_CI and VITE_E2E.
 *
 * Read through the same parser as the backend file rather than one of its own:
 * a second parser that did not strip the quotes the generator writes handed
 * every flag back quoted, which the old truthiness coercion read as set and an
 * exact comparison reads as absent. The bundler's own loader strips them, so
 * the quoted form was never what a bundle carries.
 */
export async function parseFrontendEnv(filePath: string): Promise<FrontendEnvVariables> {
  const variables = await readEnvFileVariables(filePath);

  return {
    VITE_CI: variables['VITE_CI'],
    VITE_E2E: variables['VITE_E2E'],
  };
}

/**
 * Get expected EnvUtilities output for a given mode, as its backend answers it.
 *
 * A frontend answers one mode differently; {@link getExpectedFrontendEnvUtilities}
 * states which and why.
 */
export function getExpectedEnvUtilities(mode: EnvMode): EnvUtilities {
  const expectations: Record<EnvMode, EnvUtilities> = {
    development: {
      isDev: true,
      isLocalDev: true,
      isDevServer: true,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    },
    test: {
      isDev: true,
      isLocalDev: true,
      isDevServer: true,
      isProduction: false,
      isCI: false,
      isE2E: false,
      requiresRealServices: false,
    },
    ciVitest: {
      isDev: true,
      isLocalDev: false,
      isDevServer: false,
      isProduction: false,
      isCI: true,
      isE2E: false,
      requiresRealServices: true,
    },
    e2e: {
      isDev: true,
      isLocalDev: true,
      isDevServer: false,
      isProduction: false,
      isCI: false,
      isE2E: true,
      requiresRealServices: false,
    },
    ciE2E: {
      isDev: true,
      isLocalDev: false,
      isDevServer: false,
      isProduction: false,
      isCI: true,
      isE2E: true,
      requiresRealServices: true,
    },
    production: {
      isDev: false,
      isLocalDev: false,
      isDevServer: false,
      isProduction: true,
      isCI: false,
      isE2E: false,
      requiresRealServices: true,
    },
  };

  return expectations[mode];
}

/**
 * Where a mode's frontend answers differently from its backend, and why.
 *
 * The backend reads NODE_ENV out of the generated file, which the env registry
 * gives every non-production mode as `development`. A frontend carries Vite's
 * `MODE`, which is {@link frontendModeFor}'s answer for the mode. Those two
 * words agree for every mode whose frontend build resolves the development
 * stack, and an end-to-end bundle is a development environment by the E2E term
 * whatever word it carries; production's two words are both `production`. So
 * the modes whose destinations disagree are the two of the test stack, whose
 * stack is its own. Their bundles are not development builds, which is what a
 * frontend under the vitest runner already answers; the local one loses the two
 * terms derived from that word as well, having no CI flag holding them down
 * already.
 */
const FRONTEND_EXPECTATION_DELTAS: Partial<Record<EnvMode, Partial<EnvUtilities>>> = {
  test: { isDev: false, isLocalDev: false, isDevServer: false },
  ciVitest: { isDev: false },
};

/** Get expected EnvUtilities output for a given mode, as its frontend answers it. */
export function getExpectedFrontendEnvUtilities(mode: EnvMode): EnvUtilities {
  return { ...getExpectedEnvUtilities(mode), ...FRONTEND_EXPECTATION_DELTAS[mode] };
}

/**
 * Compare actual vs expected EnvUtils and return mismatches
 */
function compareEnvUtilities(actual: EnvUtilities, expected: EnvUtilities): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const keys: (keyof EnvUtilities)[] = [
    'isDev',
    'isLocalDev',
    'isDevServer',
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
 * Build a VerificationResult from a resolved env context and source label.
 * Shared by verifyBackendEnv and verifyFrontendEnv to avoid duplicating
 * the createEnvUtilities → compare → return-result pattern.
 */
export function verifyEnvSource(
  mode: EnvMode,
  envContext: EnvContext,
  source: string,
  expected: EnvUtilities = getExpectedEnvUtilities(mode)
): VerificationResult {
  const actual = createEnvUtilities(envContext);
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
 * Verify backend environment for a given mode
 */
export async function verifyBackendEnv(
  mode: EnvMode,
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

  return verifyEnvSource(mode, envContext, source);
}

/**
 * Verify frontend environment for a given mode
 */
export async function verifyFrontendEnv(
  mode: EnvMode,
  paths: FrontendPaths
): Promise<VerificationResult> {
  // VITE_CI/VITE_E2E come from the frontend file this mode generates, which
  // {@link envPathsFor} resolved from the mode. Every mode has one, production
  // included, so every mode is checked the same way: taking a mode's word for
  // its own flags is what would report green over a file that is absent or
  // carries another environment's.
  const frontendVariables = await parseFrontendEnv(paths.frontendEnvPath);
  // The frontends pass Vite's `MODE` as NODE_ENV, and the build scripts hand
  // the bundler the mode whose file it just wrote, so that name is the word the
  // bundle carries. Hardcoding `development` here is what let an end-to-end
  // bundle answer `isDev` from a word it never contains.
  const buildMode = frontendModeFor(mode);
  const envContext: EnvContext = {
    NODE_ENV: buildMode,
    ...(frontendVariables.VITE_CI !== undefined && { CI: frontendVariables.VITE_CI }),
    ...(frontendVariables.VITE_E2E !== undefined && { E2E: frontendVariables.VITE_E2E }),
  };

  return verifyEnvSource(
    mode,
    envContext,
    `${paths.frontendEnvPath} + MODE=${buildMode}`,
    getExpectedFrontendEnvUtilities(mode)
  );
}

/**
 * Verify the environment a process running under this mode actually sees.
 *
 * The checks that read a generated file on its own say what the registry
 * declared and nothing about what the machine already held. `with-env`
 * loads that file over the machine's environment and then clears the
 * classification variables the generating mode does not state, so this models
 * both halves — the override and the clearing, in that order — and compares the
 * result against the same table. Modelling only the override is what reported
 * green in the very phase the table was being violated.
 *
 * The scripts file is read alongside the backend one because it carries the
 * mode declaration the clearing is keyed on, and a suite is invoked by the local
 * name of the stack it loads rather than by the mode that generated it — so
 * taking this command's own flag for that mode would check an environment no
 * suite process has. The frontend file is not read: its variables cannot be
 * classification ones, which is what the destination assertion over
 * `CLASSIFICATION_VARIABLES` refuses to let change.
 *
 * The mode that runs no stack loads no file, so no local process carries its
 * values and there is none to check: what runs under production is a deployed
 * Worker whose environment is the one `wrangler.toml` carries, which the
 * backend check already reads. Merging this machine's variables into that would
 * model a path that does not exist.
 */
export async function verifyProcessEnv(
  mode: EnvMode,
  paths: BackendPaths & ScriptsPaths,
  processEnv: NodeJS.ProcessEnv
): Promise<VerificationResult | null> {
  if (!writesStackFiles(mode)) return null;

  const loaded: NodeJS.ProcessEnv = {
    ...processEnv,
    ...(await readEnvFileVariables(paths.devVarsPath)),
    ...(await readEnvFileVariables(paths.scriptsEnvPath)),
  };
  clearUnemittedClassification(loaded);
  return verifyEnvSource(
    mode,
    buildEnvContext(loaded),
    `${paths.devVarsPath} loaded over this process`
  );
}

export interface ScriptsVerificationResult {
  success: boolean;
  source: string;
  expected: EnvMode;
  actual: string | undefined;
}

/**
 * Verify that a mode's generated scripts file declares that same mode.
 *
 * `with-env` reads that one variable to decide which generated triple every
 * nested command loads, so a scripts file naming another mode silently moves a
 * whole command tree onto the wrong ports and the wrong database. The check is
 * equality rather than agreement about the stack, because the two modes that
 * share a stack write the same files under different names, and a file left
 * behind by the other one is a file this mode did not write. Nothing else
 * verifies the scripts file, and the derived-flag checks cannot: it carries no
 * NODE_ENV, CI or E2E.
 */
export async function verifyScriptsEnv(
  mode: EnvMode,
  paths: ScriptsPaths
): Promise<ScriptsVerificationResult> {
  const expected = mode;
  const variables = await readEnvFileVariables(paths.scriptsEnvPath);
  const actual = variables[ENV_MODE_VARIABLE];

  return {
    success: actual === expected,
    source: paths.scriptsEnvPath,
    expected,
    actual,
  };
}

/**
 * Format EnvUtilities as a string for display
 */
export function formatEnvUtilities(env: EnvUtilities): string {
  return `isDev=${String(env.isDev)}, isLocalDev=${String(env.isLocalDev)}, isDevServer=${String(env.isDevServer)}, isProduction=${String(env.isProduction)}, isCI=${String(env.isCI)}, isE2E=${String(env.isE2E)}, requiresRealServices=${String(env.requiresRealServices)}`;
}

/**
 * Format EnvContext as a string for display
 */
export function formatEnvContext(ctx: EnvContext): string {
  return `NODE_ENV=${ctx.NODE_ENV ?? 'undefined'}, CI=${ctx.CI ?? 'undefined'}, E2E=${ctx.E2E ?? 'undefined'}`;
}

export const COMMAND_LINE = {
  command: 'pnpm verify:env',
  summary: "Checks this checkout's generated environment files against the registry.",
  flags: [
    {
      flag: '--mode',
      kind: 'value',
      placeholder: '<mode>',
      summary: 'Which mode\u2019s files to verify.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/**
 * Parse CLI arguments and return the mode
 */
export function parseCliArgs(args: string[]): { mode: EnvMode } | { error: string } {
  const validModes: EnvMode[] = Object.values(Mode);
  let parsed;
  try {
    parsed = parseCommandLine(COMMAND_LINE, args);
  } catch (error: unknown) {
    return { error: messageChain(error) };
  }
  // The entry point answers a usage request before reaching here, so this
  // branch serves a caller that parses without one.
  if (parsed.kind === 'help') return { error: parsed.usage };

  const mode = parsed.flags['--mode'];
  if (mode === undefined) {
    return { error: `Usage: pnpm verify:env --mode=<${validModes.join('|')}>` };
  }
  if (!validModes.includes(mode as EnvMode)) {
    return { error: `Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}` };
  }

  return { mode: mode as EnvMode };
}

/** A scripts-file check, or `null` for a mode whose verification checks none. */
export type ScriptsCheck = ScriptsVerificationResult | { error: string } | null;

/** A loaded-process check, or `null` for a mode no local process runs under. */
export type ProcessCheck = VerificationResult | { error: string } | null;

export interface VerifyAllResult {
  backend: VerificationResult | { error: string };
  frontend: VerificationResult | { error: string };
  scripts: ScriptsCheck;
  process: ProcessCheck;
  success: boolean;
}

/** A check passes when it ran without an error and matched, or did not apply. */
function passed(check: { success: boolean } | { error: string } | null): boolean {
  return check === null || (!('error' in check) && check.success);
}

/**
 * Run verification for the backend, the frontend, the scripts file and the
 * environment a process under this mode loads.
 *
 * A mode that runs no stack has no scripts file to check: it binds no port and
 * starts nothing, so the only scripts file the stack it maps to owns belongs to
 * whatever is running under that stack, and its own generation writes none.
 */
export async function verifyAll(
  mode: EnvMode,
  paths: VerifiedEnvPaths,
  processEnv: NodeJS.ProcessEnv
): Promise<VerifyAllResult> {
  let backend: VerificationResult | { error: string };
  let frontend: VerificationResult | { error: string };
  let scripts: ScriptsCheck = null;
  let processCheck: ProcessCheck;

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

  if (writesStackFiles(mode)) {
    try {
      scripts = await verifyScriptsEnv(mode, paths);
    } catch (error) {
      scripts = { error: (error as Error).message };
    }
  }

  try {
    processCheck = await verifyProcessEnv(mode, paths, processEnv);
  } catch (error) {
    processCheck = { error: (error as Error).message };
  }

  return {
    backend,
    frontend,
    scripts,
    process: processCheck,
    success: passed(backend) && passed(frontend) && passed(scripts) && passed(processCheck),
  };
}

/**
 * A registry key that is declared for a mode but fails to resolve to a present
 * value for it (e.g. a `ref()` chain terminating in a mode that omits the key).
 */
export interface MissingKey {
  mode: EnvMode;
  key: string;
}

/**
 * The modes whose per-key completeness is asserted: every mode the registry
 * declares. `e2e` is one of them because it generates its own env files, so a
 * key that fails to resolve for it breaks a real stack rather than a
 * convenience.
 */
export const VERIFIED_MODES: EnvMode[] = Object.values(Mode);

/**
 * Assert per-key presence per mode against the env registry. For each mode, a
 * key the registry DECLARES for that mode (`getModeValue` returns a value) must
 * also RESOLVE to a present value (`resolveRaw` returns a literal or a secret
 * directive, never `undefined`). A declared key that resolves to `undefined` —
 * a dangling `ref()` — is a missing required key. Derived-flag verification
 * cannot see this: it only checks the handful of NODE_ENV/CI/E2E keys the flags
 * derive from. The registry is the sole source of which keys each mode requires.
 */
export function findMissingKeys(
  registry: Record<string, VariableConfig>,
  modes: readonly EnvMode[] = VERIFIED_MODES
): MissingKey[] {
  const missing: MissingKey[] = [];
  for (const mode of modes) {
    for (const [key, config] of Object.entries(registry)) {
      const declared = getModeValue(config, mode) !== undefined;
      if (!declared) continue;
      if (resolveRaw(config, mode) === undefined) {
        missing.push({ mode, key });
      }
    }
  }
  return missing;
}

/** Per-key failure message naming the specific missing key and its mode. */
export function missingKeyMessage(missing: MissingKey): string {
  return `  ✗ Missing required env key "${missing.key}" for mode "${missing.mode}"`;
}

/**
 * Verify per-key completeness of the env registry across {@link VERIFIED_MODES}
 * and print a per-key message for every missing key. Returns `true` when every
 * declared key resolves in every verified mode.
 */
export function verifyRegistryKeys(registry: Record<string, VariableConfig> = envConfig): boolean {
  const missing = findMissingKeys(registry);
  if (missing.length === 0) return true;
  console.error('\n  Env registry per-key completeness FAILED:');
  for (const entry of missing) {
    console.error(missingKeyMessage(entry));
  }
  return false;
}

/**
 * Print verification result for a target (backend/frontend)
 */
export function printVerificationResult(
  target: 'Backend' | 'Frontend' | 'Process',
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

/**
 * Print the scripts-file check, or the line saying why there is none to check.
 */
export function printScriptsResult(result: ScriptsCheck): void {
  if (result === null) {
    console.log('  - Skipped: this mode runs no stack, so its generation writes no scripts file');
    return;
  }

  if ('error' in result) {
    console.error(`  \u2717 Scripts environment verification error: ${result.error}`);
    return;
  }

  if (result.success) {
    console.log('  \u2713 Scripts environment verification passed');
    console.log(`    Source: ${result.source}`);
    console.log(`    ${ENV_MODE_VARIABLE}=${result.expected}`);
    return;
  }

  console.error('  \u2717 Scripts environment verification FAILED');
  console.error(`    Source: ${result.source}`);
  console.error(`    Expected: ${ENV_MODE_VARIABLE}=${result.expected}`);
  console.error(`    Actual:   ${ENV_MODE_VARIABLE}=${result.actual ?? 'undefined'}`);
}

/**
 * Print the loaded-process check, or the line saying why there is none.
 */
export function printProcessResult(result: ProcessCheck): void {
  if (result === null) {
    console.log('  - Skipped: this mode runs no stack, so no local process loads its values');
    return;
  }

  printVerificationResult('Process', result);
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
  const { mode } = parseOrExit(parseCliArgs, argv);

  const paths = envPathsFor(mode);

  console.log(`\nVerifying environment for mode: ${mode}`);

  const result = await verifyAll(mode, paths, process.env);

  console.log('\nBackend:');
  printVerificationResult('Backend', result.backend);

  console.log('\nFrontend:');
  printVerificationResult('Frontend', result.frontend);

  console.log('\nScripts:');
  printScriptsResult(result.scripts);

  console.log('\nProcess:');
  printProcessResult(result.process);

  console.log('\nRegistry per-key completeness:');
  const registryOk = verifyRegistryKeys();

  if (!result.success || !registryOk) {
    console.error('\nEnvironment verification failed. Check env.config.ts or generate-env.ts.');
    process.exit(1);
  }

  console.log('\n✓ All environment verifications passed');
}

if (isMainModule(import.meta.url)) {
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  envConfig,
  isSecretRef,
  isDuplicateRef,
  getDuplicateKey,
  type VarConfig,
} from '../packages/shared/src/env.config.js';

export type EnvMode = 'development' | 'ciVitest' | 'ciE2E' | 'production';

/**
 * Resolve a value from a VarConfig for a given mode.
 * Handles: literal values, $SECRET_NAME references, duplicate_x references.
 * Returns null if the value is not set for this mode.
 */
export function resolveValue(
  config: VarConfig,
  targetMode: EnvMode,
  getEnvVar: (name: string) => string | undefined = (name) => process.env[name]
): string | null {
  const raw = config[targetMode];
  if (raw === undefined) {
    return null;
  }

  // Handle duplicate references (e.g., 'duplicate_development')
  if (isDuplicateRef(raw)) {
    const refKey = getDuplicateKey(raw) as EnvMode;
    return resolveValue(config, refKey, getEnvVar);
  }

  // Handle secret references (e.g., '$HELCIM_API_TOKEN_SANDBOX')
  if (isSecretRef(raw)) {
    const secretName = raw.slice(1); // Remove leading $
    const value = getEnvVar(secretName);
    if (value === undefined) {
      throw new Error(`Missing secret: ${secretName}`);
    }
    return value;
  }

  // Literal value
  return raw;
}

/**
 * Generate all environment files from the single source of truth (env.config.ts).
 *
 * Section-based routing:
 * - worker: .dev.vars + wrangler.toml [vars] (NOT .env.development)
 * - workerSecrets: .dev.vars + .env.development (prod via wrangler secret put)
 * - frontend: .env.development (prod values baked at build time)
 * - local: .env.development only (tooling, never goes to worker)
 *
 * Modes:
 * - development (default): Generate files with development values only
 * - ciVitest: Generate files for CI unit tests (not typically used)
 * - ciE2E: Include CI secrets from process.env for E2E tests
 * - production: Ensure wrangler.toml has production values
 */
export function generateEnvFiles(rootDir: string, mode: EnvMode = 'development'): void {
  const devVarsLines: string[] = ['# Auto-generated - do not edit'];
  const envDevLines: string[] = [
    '# Auto-generated from packages/shared/src/env.config.ts',
    '# Do not edit directly - run: pnpm generate:env',
    '',
  ];

  const missing: string[] = [];
  const resolve = (config: VarConfig): string | null => {
    try {
      return resolveValue(config, mode);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Missing secret:')) {
        const secretName = e.message.replace('Missing secret: ', '');
        missing.push(secretName);
        return null;
      }
      throw e;
    }
  };

  // worker section → .dev.vars + wrangler.toml [vars] (NOT .env.development)
  devVarsLines.push('', '# Worker vars');
  for (const [key, config] of Object.entries(envConfig.worker) as [string, VarConfig][]) {
    const value = resolve(config);
    if (value !== null) {
      devVarsLines.push(`${key}=${value}`);
    }
  }

  // workerSecrets section → .dev.vars + .env.development
  devVarsLines.push('', '# Worker secrets');
  envDevLines.push('# Worker secrets (needed by scripts)');
  for (const [key, config] of Object.entries(envConfig.workerSecrets) as [string, VarConfig][]) {
    const value = resolve(config);
    if (value !== null) {
      devVarsLines.push(`${key}=${value}`);
      envDevLines.push(`${key}=${value}`);
    }
  }

  // frontend section → .env.development
  envDevLines.push('', '# Frontend (exposed to browser)');
  const envLocalLines: string[] = ['# Auto-generated CI secrets - do not edit'];
  for (const [key, config] of Object.entries(envConfig.frontend) as [string, VarConfig][]) {
    const value = resolve(config);
    if (value !== null) {
      envDevLines.push(`${key}=${value}`);
      // In CI modes, also write to .env.local for Vite to pick up
      if (mode === 'ciVitest' || mode === 'ciE2E') {
        envLocalLines.push(`${key}=${value}`);
      }
    }
  }

  // local section → .env.development only
  envDevLines.push('', '# Local only (not deployed)');
  for (const [key, config] of Object.entries(envConfig.local) as [string, VarConfig][]) {
    const value = resolve(config);
    if (value !== null) {
      envDevLines.push(`${key}=${value}`);
    }
  }

  // Check for missing secrets
  if (missing.length > 0) {
    throw new Error(`Missing required secrets in process.env: ${missing.join(', ')}`);
  }

  // Write files
  writeFileSync(resolvePath(rootDir, '.env.development'), envDevLines.join('\n') + '\n');
  console.log('  Generated .env.development');

  writeFileSync(resolvePath(rootDir, 'apps/api/.dev.vars'), devVarsLines.join('\n') + '\n');
  console.log('  Generated apps/api/.dev.vars');

  // Write .env.local for CI frontend secrets (only if there's content)
  if ((mode === 'ciVitest' || mode === 'ciE2E') && envLocalLines.length > 1) {
    writeFileSync(resolvePath(rootDir, '.env.local'), envLocalLines.join('\n') + '\n');
    console.log('  Generated .env.local (CI frontend secrets)');
  }

  // Update wrangler.toml [vars] with production values
  updateWranglerToml(rootDir);

  // Update CI workflow with generated env sections
  updateCiWorkflow(rootDir);

  console.log('✓ All environment files generated');
}

function updateWranglerToml(rootDir: string): void {
  const tomlPath = resolvePath(rootDir, 'apps/api/wrangler.toml');
  let content = readFileSync(tomlPath, 'utf-8');

  // Remove existing [vars] section if present
  content = content.replace(/\n?\[vars\][\s\S]*?(?=\n\[[^\]]+\]|$)/, '');

  // Build new [vars] section with production values from worker section
  const varsLines: string[] = ['', '[vars]'];
  for (const [key, config] of Object.entries(envConfig.worker) as [string, VarConfig][]) {
    // Only include literal production values (not secret refs)
    const prodValue = config.production;
    if (prodValue && !isSecretRef(prodValue) && !isDuplicateRef(prodValue)) {
      varsLines.push(`${key} = "${prodValue}"`);
    }
  }

  // Add comment about secrets
  varsLines.push('');
  varsLines.push('# Secrets deployed via CI (GitHub Secrets → wrangler secret put):');
  for (const key of Object.keys(envConfig.workerSecrets)) {
    varsLines.push(`# - ${key}`);
  }

  writeFileSync(tomlPath, content.trimEnd() + varsLines.join('\n') + '\n');
  console.log('  Updated apps/api/wrangler.toml [vars]');
}

function parseArgs(args: string[]): EnvMode {
  const modeArg = args.find((arg) => arg.startsWith('--mode='));
  if (modeArg) {
    const mode = modeArg.split('=')[1] ?? '';
    if (
      mode === 'development' ||
      mode === 'ciVitest' ||
      mode === 'ciE2E' ||
      mode === 'production'
    ) {
      return mode;
    }
    throw new Error(`Invalid mode: ${mode}. Valid modes: development, ciVitest, ciE2E, production`);
  }
  return 'development';
}

/**
 * Extract the GitHub secret name from a value.
 * For '$SECRET_NAME', returns 'SECRET_NAME'.
 * For literal values, returns the key name (for production secrets like DATABASE_URL).
 */
function getGitHubSecretName(value: string | undefined, fallbackKey: string): string {
  if (value && isSecretRef(value)) {
    return value.slice(1); // Remove leading $
  }
  return fallbackKey;
}

/**
 * Replace a marked section in the CI workflow file.
 * Detects indentation from the BEGIN marker and applies it to generated content.
 */
function replaceSection(content: string, marker: string, newContent: string): string {
  // Match the marker including leading whitespace to detect indentation
  const regex = new RegExp(
    `([ ]*)# BEGIN GENERATED: ${marker}\\n[\\s\\S]*?# END GENERATED: ${marker}`,
    'g'
  );

  return content.replace(regex, (_, indent: string) => {
    // Apply the detected indentation to each line of the new content
    const indentedContent = newContent
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n');
    return `${indent}# BEGIN GENERATED: ${marker}\n${indentedContent}${indent}# END GENERATED: ${marker}`;
  });
}

/**
 * Resolve a ciE2E value to its secret name, following duplicate references.
 * Returns the secret name if it's a secret reference, or null if not.
 */
function resolveCiE2ESecret(config: VarConfig): string | null {
  let value = config.ciE2E;
  if (!value) return null;

  // Follow duplicate references
  while (value && isDuplicateRef(value)) {
    const refKey = getDuplicateKey(value) as keyof VarConfig;
    value = config[refKey];
  }

  // Check if it's a secret reference
  if (value && isSecretRef(value)) {
    return value.slice(1); // Remove leading $
  }

  return null;
}

/**
 * Generate the e2e-env section (secrets for E2E tests).
 * Only includes variables where ciE2E resolves to a secret reference.
 */
function generateE2EEnv(): string {
  const lines: string[] = ['env:'];

  // workerSecrets that have ciE2E secret references
  for (const [key, config] of Object.entries(envConfig.workerSecrets) as [string, VarConfig][]) {
    const secretName = resolveCiE2ESecret(config);
    if (secretName) {
      lines.push(`  ${key}: \${{ secrets.${secretName} }}`);
    }
  }

  // frontend vars that have ciE2E secret references
  for (const [key, config] of Object.entries(envConfig.frontend) as [string, VarConfig][]) {
    const secretName = resolveCiE2ESecret(config);
    if (secretName) {
      lines.push(`  ${key}: \${{ secrets.${secretName} }}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the build-env section (production frontend values).
 */
function generateBuildEnv(): string {
  const lines: string[] = ['env:'];

  for (const [key, config] of Object.entries(envConfig.frontend) as [string, VarConfig][]) {
    const prodValue = config.production;
    if (prodValue) {
      if (isSecretRef(prodValue)) {
        // Secret reference - use GitHub secrets syntax
        const secretName = prodValue.slice(1);
        lines.push(`  ${key}: \${{ secrets.${secretName} }}`);
      } else if (!isDuplicateRef(prodValue)) {
        // Literal value
        lines.push(`  ${key}: ${prodValue}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the deploy-secrets section (wrangler secret put commands).
 */
function generateDeploySecrets(): string {
  const lines: string[] = [];

  for (const [key, config] of Object.entries(envConfig.workerSecrets) as [string, VarConfig][]) {
    const prodValue = config.production;
    if (prodValue) {
      const secretName = getGitHubSecretName(prodValue, key);
      lines.push(`echo "\${{ secrets.${secretName} }}" | pnpm exec wrangler secret put ${key}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the verify-secrets section (for loop of secret names).
 */
function generateVerifySecrets(): string {
  const secretKeys = Object.keys(envConfig.workerSecrets);
  return `for secret in ${secretKeys.join(' ')}; do\n`;
}

/**
 * Update CI workflow with generated env sections.
 * Skips if ci.yml doesn't exist (e.g., in test fixtures).
 */
export function updateCiWorkflow(rootDir: string): void {
  const ciPath = resolvePath(rootDir, '.github/workflows/ci.yml');

  if (!existsSync(ciPath)) {
    return;
  }

  let content = readFileSync(ciPath, 'utf-8');

  // Generate and replace each section
  content = replaceSection(content, 'e2e-env', generateE2EEnv());
  content = replaceSection(content, 'build-env', generateBuildEnv());
  content = replaceSection(content, 'deploy-secrets', generateDeploySecrets());
  content = replaceSection(content, 'verify-secrets', generateVerifySecrets());

  writeFileSync(ciPath, content);
  console.log('  Updated .github/workflows/ci.yml');
}

// CLI entry point
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  const mode = parseArgs(process.argv.slice(2));
  generateEnvFiles(process.cwd(), mode);
}

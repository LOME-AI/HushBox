import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  envConfig,
  Dest,
  Mode,
  isSecret,
  isProductionSecret,
  getDestinations,
  resolveValue,
  resolveRaw,
  type EnvMode,
  type VarConfig,
} from '../packages/shared/src/env.config.js';

/**
 * Generate all environment files from the single source of truth (env.config.ts).
 *
 * Destinations:
 * - Dest.Backend  → .dev.vars (local) / wrangler.toml + secrets (prod)
 * - Dest.Frontend → .env.development (Vite, VITE_* vars only)
 * - Dest.Scripts  → .env.scripts (migrations, seed, etc.)
 *
 * Modes:
 * - development (default): Generate files with development values
 * - ciVitest: Generate files for CI unit tests
 * - ciE2E: Include CI secrets from process.env for E2E tests
 * - production: Ensure wrangler.toml has production values
 */
export function generateEnvFiles(rootDir: string, mode: EnvMode = Mode.Development): void {
  const missing: string[] = [];

  const getSecret = (name: string): string => {
    const val = process.env[name];
    if (!val) {
      missing.push(name);
      return ''; // Placeholder, will throw after collecting all missing
    }
    return val;
  };

  // Helper to generate lines for a destination
  const generateLines = (dest: Dest): string[] =>
    Object.entries(envConfig)
      .filter(([, config]) => getDestinations(config as VarConfig, mode).includes(dest))
      .map(([key, config]) => {
        const val = resolveValue(config as VarConfig, mode, getSecret);
        // Return null if val is null (defensive, filtered out by subsequent .filter())
        /* istanbul ignore next -- @preserve defensive check */
        if (val === null) return null;
        return `${key}=${val}`;
      })
      .filter((line): line is string => line !== null);

  // Generate lines for each destination
  const backendLines = generateLines(Dest.Backend);
  const frontendLines = generateLines(Dest.Frontend);
  const scriptsLines = generateLines(Dest.Scripts);

  // Check for missing secrets
  if (missing.length > 0) {
    throw new Error(`Missing required secrets in process.env: ${missing.join(', ')}`);
  }

  // Write .dev.vars (Backend)
  const devVarsContent = ['# Auto-generated - do not edit', '', ...backendLines].join('\n') + '\n';
  writeFileSync(resolvePath(rootDir, 'apps/api/.dev.vars'), devVarsContent);
  console.log('  Generated apps/api/.dev.vars');

  // Write .env.development (Frontend)
  const envDevContent =
    [
      '# Auto-generated from packages/shared/src/env.config.ts',
      '# Do not edit directly - run: pnpm generate:env',
      '',
      ...frontendLines,
    ].join('\n') + '\n';
  writeFileSync(resolvePath(rootDir, '.env.development'), envDevContent);
  console.log('  Generated .env.development');

  // Write .env.scripts (Scripts)
  const envScriptsContent =
    ['# Auto-generated - do not edit', '', ...scriptsLines].join('\n') + '\n';
  writeFileSync(resolvePath(rootDir, '.env.scripts'), envScriptsContent);
  console.log('  Generated .env.scripts');

  // Update wrangler.toml [vars] with production values
  updateWranglerToml(rootDir);

  // Update CI workflow with generated env sections
  updateCiWorkflow(rootDir);

  console.log('✓ All environment files generated');
}

/**
 * Update wrangler.toml with [vars] section containing production non-secret values.
 */
function updateWranglerToml(rootDir: string): void {
  const tomlPath = resolvePath(rootDir, 'apps/api/wrangler.toml');
  let content = readFileSync(tomlPath, 'utf-8');

  // Remove existing [vars] section if present
  content = content.replace(/\n?\[vars\][\s\S]*?(?=\n\[[^\]]+\]|$)/, '');

  // Build new [vars] section with production non-secret values from backend
  const varsLines: string[] = ['', '[vars]'];
  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VarConfig, Mode.Production);
    if (!destinations.includes(Dest.Backend)) continue;

    const raw = resolveRaw(config as VarConfig, Mode.Production);
    // Only include literal production values (not secrets)
    if (raw && typeof raw === 'string') {
      varsLines.push(`${key} = "${raw}"`);
    }
  }

  // Add comment about secrets (always has secrets with current envConfig)
  const secretKeys = getBackendSecretKeys();
  /* istanbul ignore next -- @preserve always true with current config */
  if (secretKeys.length > 0) {
    varsLines.push('');
    varsLines.push('# Secrets deployed via CI (GitHub Secrets → wrangler secret put):');
    for (const key of secretKeys) {
      varsLines.push(`# - ${key}`);
    }
  }

  writeFileSync(tomlPath, content.trimEnd() + varsLines.join('\n') + '\n');
  console.log('  Updated apps/api/wrangler.toml [vars]');
}

/**
 * Get the list of backend keys that are secrets (for wrangler secret put).
 */
function getBackendSecretKeys(): string[] {
  return Object.entries(envConfig)
    .filter(([, config]) => {
      const destinations = getDestinations(config as VarConfig, Mode.Production);
      return destinations.includes(Dest.Backend) && isProductionSecret(config as VarConfig);
    })
    .map(([key]) => key);
}

/**
 * Replace a marked section in the CI workflow file.
 * Detects indentation from the BEGIN marker and applies it to generated content.
 */
function replaceSection(content: string, marker: string, newContent: string): string {
  const regex = new RegExp(
    `([ ]*)# BEGIN GENERATED: ${marker}\\n[\\s\\S]*?# END GENERATED: ${marker}`,
    'g'
  );

  return content.replace(regex, (_, indent: string) => {
    const indentedContent = newContent
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n');
    return `${indent}# BEGIN GENERATED: ${marker}\n${indentedContent}${indent}# END GENERATED: ${marker}`;
  });
}

/**
 * Generate a secrets env section for a given mode.
 * Uses the secret name for BOTH the env var name AND GitHub secret reference.
 */
function generateSecretsEnv(mode: EnvMode): string {
  const lines: string[] = ['env:'];

  for (const [, config] of Object.entries(envConfig)) {
    const raw = resolveRaw(config as VarConfig, mode);
    if (raw && isSecret(raw)) {
      lines.push(`  ${raw.name}: \${{ secrets.${raw.name} }}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the build-env section (production frontend values).
 */
function generateBuildEnv(): string {
  const lines: string[] = ['env:'];

  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VarConfig, Mode.Production);
    if (!destinations.includes(Dest.Frontend)) continue;

    const raw = resolveRaw(config as VarConfig, Mode.Production);
    // All frontend vars have production values
    /* istanbul ignore next -- @preserve defensive check */
    if (!raw) continue;

    if (isSecret(raw)) {
      lines.push(`  ${key}: \${{ secrets.${raw.name} }}`);
      /* istanbul ignore next -- @preserve frontend prod is always secret or literal */
    } else if (typeof raw === 'string') {
      lines.push(`  ${key}: ${raw}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the deploy-secrets section (wrangler secret put commands).
 */
function generateDeploySecrets(): string {
  const lines: string[] = [];

  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VarConfig, Mode.Production);
    if (!destinations.includes(Dest.Backend)) continue;

    const raw = resolveRaw(config as VarConfig, Mode.Production);
    if (raw && isSecret(raw)) {
      lines.push(`echo "\${{ secrets.${raw.name} }}" | pnpm exec wrangler secret put ${key}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the verify-secrets section (for loop of secret names).
 */
function generateVerifySecrets(): string {
  const secretKeys = getBackendSecretKeys();
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
  content = replaceSection(content, 'vitest-env', generateSecretsEnv(Mode.CiVitest));
  content = replaceSection(content, 'e2e-env', generateSecretsEnv(Mode.CiE2E));
  content = replaceSection(content, 'build-env', generateBuildEnv());
  content = replaceSection(content, 'deploy-secrets', generateDeploySecrets());
  content = replaceSection(content, 'verify-secrets', generateVerifySecrets());

  writeFileSync(ciPath, content);
  console.log('  Updated .github/workflows/ci.yml');
}

export function parseArgs(args: string[]): EnvMode {
  const modeArg = args.find((arg) => arg.startsWith('--mode='));
  if (modeArg) {
    const parts = modeArg.split('=');
    const mode = parts[1] ?? '';
    const validModes = Object.values(Mode);
    if (validModes.includes(mode as Mode)) {
      return mode as EnvMode;
    }
    throw new Error(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
  }
  return Mode.Development;
}

// CLI entry point
/* v8 ignore start */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  const mode = parseArgs(process.argv.slice(2));
  generateEnvFiles(process.cwd(), mode);
}
/* v8 ignore stop */

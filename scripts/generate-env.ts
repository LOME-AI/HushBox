import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envConfig, isEmptySecret, type VarConfig } from '../packages/shared/src/env.config.js';

export type EnvMode = 'local' | 'ci-e2e';

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
 * - local (default): Generate files with development values only
 * - ci-e2e: Include CI/prod secrets from process.env, add CI=true and E2E=true flags
 */
export function generateEnvFiles(rootDir: string, mode: EnvMode = 'local'): void {
  const devVarsLines: string[] = ['# Auto-generated - do not edit'];
  const envDevLines: string[] = [
    '# Auto-generated from packages/shared/src/env.config.ts',
    '# Do not edit directly - run: pnpm generate:env',
    '',
  ];

  // worker section → .dev.vars + wrangler.toml [vars] (NOT .env.development)
  devVarsLines.push('', '# Worker vars');
  for (const [key, config] of Object.entries(envConfig.worker) as [string, VarConfig][]) {
    if (config.development) {
      devVarsLines.push(`${key}=${config.development}`);
    }
  }

  // workerSecrets section → .dev.vars + .env.development
  devVarsLines.push('', '# Worker secrets');
  envDevLines.push('# Worker secrets (needed by scripts)');
  for (const [key, config] of Object.entries(envConfig.workerSecrets) as [string, VarConfig][]) {
    if (config.development) {
      devVarsLines.push(`${key}=${config.development}`);
      envDevLines.push(`${key}=${config.development}`);
    }
  }

  // frontend section → .env.development
  envDevLines.push('', '# Frontend (exposed to browser)');
  for (const [key, config] of Object.entries(envConfig.frontend) as [string, VarConfig][]) {
    if (config.development) {
      envDevLines.push(`${key}=${config.development}`);
    }
  }

  // local section → .env.development only
  envDevLines.push('', '# Local only (not deployed)');
  for (const [key, config] of Object.entries(envConfig.local) as [string, VarConfig][]) {
    if (config.development) {
      envDevLines.push(`${key}=${config.development}`);
    }
  }

  // CI E2E mode: add flags and secrets from process.env
  if (mode === 'ci-e2e') {
    devVarsLines.push('', '# CI flags');
    devVarsLines.push('CI=true');
    devVarsLines.push('E2E=true');

    const missing: string[] = [];

    // Backend CI/prod secrets from process.env
    devVarsLines.push('', '# CI/prod secrets');
    for (const [key, config] of Object.entries(envConfig.workerSecrets) as [string, VarConfig][]) {
      if (isEmptySecret(config)) {
        const value = process.env[key];
        if (!value) {
          missing.push(key);
        } else {
          devVarsLines.push(`${key}=${value}`);
        }
      }
    }

    // Frontend CI/prod secrets → .env.local
    const envLocalLines: string[] = ['# Auto-generated CI secrets - do not edit'];
    for (const [key, config] of Object.entries(envConfig.frontend) as [string, VarConfig][]) {
      if (isEmptySecret(config)) {
        const value = process.env[key];
        if (!value) {
          missing.push(key);
        } else {
          envLocalLines.push(`${key}=${value}`);
        }
      }
    }

    if (missing.length > 0) {
      throw new Error(`Missing required CI secrets in process.env: ${missing.join(', ')}`);
    }

    // Write .env.local for frontend CI secrets
    if (envLocalLines.length > 1) {
      writeFileSync(resolve(rootDir, '.env.local'), envLocalLines.join('\n') + '\n');
      console.log('  Generated .env.local (CI frontend secrets)');
    }
  }

  // Write files
  writeFileSync(resolve(rootDir, '.env.development'), envDevLines.join('\n') + '\n');
  console.log('  Generated .env.development');

  writeFileSync(resolve(rootDir, 'apps/api/.dev.vars'), devVarsLines.join('\n') + '\n');
  console.log('  Generated apps/api/.dev.vars');

  // Update wrangler.toml [vars] with production values
  updateWranglerToml(rootDir);

  // Update CI workflow with generated env sections
  updateCiWorkflow(rootDir);

  console.log('✓ All environment files generated');
}

function updateWranglerToml(rootDir: string): void {
  const tomlPath = resolve(rootDir, 'apps/api/wrangler.toml');
  let content = readFileSync(tomlPath, 'utf-8');

  // Remove existing [vars] section if present
  content = content.replace(/\n?\[vars\][\s\S]*?(?=\n\[[^\]]+\]|$)/, '');

  // Build new [vars] section with production values from worker section
  const varsLines: string[] = ['', '[vars]'];
  for (const [key, config] of Object.entries(envConfig.worker) as [string, VarConfig][]) {
    if (config.production) {
      varsLines.push(`${key} = "${config.production}"`);
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
    if (mode === 'local' || mode === 'ci-e2e') {
      return mode;
    }
    throw new Error(`Invalid mode: ${mode}. Valid modes: local, ci-e2e`);
  }
  return 'local';
}

/**
 * Get the GitHub secret reference for a key, using ciSecretName if specified.
 */
function getCiSecretRef(key: string, config: VarConfig, useProduction: boolean): string {
  const secretName = useProduction
    ? (config.ciSecretNameProduction ?? key)
    : (config.ciSecretNameSandbox ?? key);
  return `\${{ secrets.${secretName} }}`;
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
 * Generate the e2e-env section (sandbox secrets for E2E tests).
 */
function generateE2EEnv(): string {
  const lines: string[] = ['env:'];

  // All CI/prod secrets from workerSecrets
  for (const [key, config] of Object.entries(envConfig.workerSecrets) as [string, VarConfig][]) {
    if (isEmptySecret(config)) {
      lines.push(`  ${key}: ${getCiSecretRef(key, config, false)}`);
    }
  }

  // All CI/prod secrets from frontend
  for (const [key, config] of Object.entries(envConfig.frontend) as [string, VarConfig][]) {
    if (isEmptySecret(config)) {
      lines.push(`  ${key}: ${getCiSecretRef(key, config, false)}`);
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
    if (config.production) {
      lines.push(`  ${key}: ${config.production}`);
    } else if (isEmptySecret(config)) {
      // Frontend secrets with production CI secret names
      lines.push(`  ${key}: ${getCiSecretRef(key, config, true)}`);
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
    const secretRef = getCiSecretRef(key, config, true);
    lines.push(`echo "${secretRef}" | pnpm exec wrangler secret put ${key}`);
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
  const ciPath = resolve(rootDir, '.github/workflows/ci.yml');

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

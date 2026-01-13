import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEnvFiles, updateCiWorkflow } from './generate-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = resolve(__dirname, '__test-fixtures__');

describe('generateEnvFiles', () => {
  beforeEach(() => {
    // Create test directory structure
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'apps/api'), { recursive: true });

    // Create minimal wrangler.toml
    writeFileSync(
      join(TEST_DIR, 'apps/api/wrangler.toml'),
      `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
port = 8787
`
    );

    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('generates .env.development', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR);

      expect(existsSync(join(TEST_DIR, '.env.development'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain('Auto-generated');
      expect(content).toContain('pnpm generate:env');
    });

    it('does NOT include worker vars (they only go to .dev.vars)', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      // NODE_ENV, BETTER_AUTH_URL, FRONTEND_URL are in worker section
      expect(content).not.toContain('NODE_ENV=');
      expect(content).not.toContain('BETTER_AUTH_URL=');
      expect(content).not.toContain('FRONTEND_URL=');
    });

    it('includes workerSecrets with development values', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain(
        'DATABASE_URL=postgres://postgres:postgres@localhost:4444/lome_chat'
      );
      expect(content).toContain('BETTER_AUTH_SECRET=');
    });

    it('does not include CI/prod secrets (empty {} vars)', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
      expect(content).not.toContain('HELCIM_API_TOKEN');
      expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
    });

    it('includes frontend vars with development values', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain('VITE_API_URL=http://localhost:8787');
    });

    it('includes local vars', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, '.env.development'), 'utf-8');
      expect(content).toContain(
        'MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lome_chat'
      );
      expect(content).toContain('# Local only');
    });
  });

  describe('generates .dev.vars', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR);

      expect(existsSync(join(TEST_DIR, 'apps/api/.dev.vars'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('Auto-generated');
    });

    it('includes worker vars', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('NODE_ENV=development');
      expect(content).toContain('BETTER_AUTH_URL=http://localhost:8787');
      expect(content).toContain('FRONTEND_URL=http://localhost:5173');
    });

    it('includes workerSecrets with development values', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('DATABASE_URL=');
      expect(content).toContain('BETTER_AUTH_SECRET=');
    });

    it('does not include CI/prod secrets in local mode', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
    });

    it('does not include VITE_ vars (frontend only)', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).not.toContain('VITE_');
    });

    it('does not include local vars (tooling only)', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });
  });

  describe('updates wrangler.toml', () => {
    it('adds [vars] section', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('[vars]');
    });

    it('includes production values for worker vars', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('NODE_ENV = "production"');
      expect(content).toContain('BETTER_AUTH_URL = "https://api.lome-chat.com"');
      expect(content).toContain('FRONTEND_URL = "https://lome-chat.com"');
    });

    it('includes comments about workerSecrets', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('Secrets deployed via CI');
      // All workerSecrets (both with dev values and CI/prod secrets)
      expect(content).toContain('DATABASE_URL');
      expect(content).toContain('BETTER_AUTH_SECRET');
      expect(content).toContain('RESEND_API_KEY');
      expect(content).toContain('OPENROUTER_API_KEY');
      expect(content).toContain('HELCIM_API_TOKEN');
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER');
    });

    it('does not include local vars in secrets comment', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });

    it('preserves existing wrangler.toml content', () => {
      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).toContain('name = "test-api"');
      expect(content).toContain('[dev]');
      expect(content).toContain('port = 8787');
    });

    it('replaces existing [vars] section if present', () => {
      // Add existing [vars] section
      writeFileSync(
        join(TEST_DIR, 'apps/api/wrangler.toml'),
        `name = "test-api"

[vars]
OLD_VAR = "should-be-replaced"

[dev]
port = 8787
`
      );

      generateEnvFiles(TEST_DIR);

      const content = readFileSync(join(TEST_DIR, 'apps/api/wrangler.toml'), 'utf-8');
      expect(content).not.toContain('OLD_VAR');
      expect(content).toContain('NODE_ENV = "production"');
    });
  });

  describe('ciE2E mode', () => {
    beforeEach(() => {
      // Set up mock CI secrets in process.env
      // For ciE2E mode: RESEND_API_KEY (via duplicate_ciVitest), HELCIM secrets, VITE_HELCIM_JS_TOKEN, VITE_CI
      process.env['RESEND_API_KEY'] = 'test-resend-key';
      process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test-helcim-token';
      process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test-helcim-verifier';
      process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test-vite-helcim-token';
    });

    afterEach(() => {
      // Clean up env vars
      delete process.env['RESEND_API_KEY'];
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
    });

    it('adds CI=true and E2E=true flags to .dev.vars', () => {
      generateEnvFiles(TEST_DIR, 'ciE2E');

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('CI=true');
      expect(content).toContain('E2E=true');
    });

    it('includes ciE2E secrets from process.env in .dev.vars', () => {
      generateEnvFiles(TEST_DIR, 'ciE2E');

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      // RESEND_API_KEY comes via duplicate_ciVitest which references $RESEND_API_KEY
      expect(content).toContain('RESEND_API_KEY=test-resend-key');
      // HELCIM secrets are ciE2E-only
      expect(content).toContain('HELCIM_API_TOKEN=test-helcim-token');
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER=test-helcim-verifier');
      // OPENROUTER should NOT be present (only in ciVitest, not ciE2E)
      expect(content).not.toContain('OPENROUTER_API_KEY');
    });

    it('generates .env.local with frontend CI secrets', () => {
      generateEnvFiles(TEST_DIR, 'ciE2E');

      expect(existsSync(join(TEST_DIR, '.env.local'))).toBe(true);
      const content = readFileSync(join(TEST_DIR, '.env.local'), 'utf-8');
      expect(content).toContain('VITE_HELCIM_JS_TOKEN=test-vite-helcim-token');
      expect(content).toContain('VITE_CI=true');
    });

    it('throws if required ciE2E secrets are missing', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR, 'ciE2E');
      }).toThrow('Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX');
    });

    it('throws listing all missing secrets', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR, 'ciE2E');
      }).toThrow(
        'Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX, HELCIM_WEBHOOK_VERIFIER_SANDBOX'
      );
    });
  });
});

describe('updateCiWorkflow', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, '.github/workflows'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const createCiYml = (content: string): void => {
    writeFileSync(join(TEST_DIR, '.github/workflows/ci.yml'), content);
  };

  const readCiYml = (): string => {
    return readFileSync(join(TEST_DIR, '.github/workflows/ci.yml'), 'utf-8');
  };

  describe('e2e-env section', () => {
    it('generates env block with ciE2E secrets only', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
rest of file`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      // These have ciE2E values
      expect(content).toContain('RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}');
      expect(content).toContain('HELCIM_API_TOKEN: ${{ secrets.HELCIM_API_TOKEN_SANDBOX }}');
      // OPENROUTER should NOT be present (only in ciVitest, not ciE2E)
      expect(content).not.toContain('OPENROUTER_API_KEY');
    });

    it('uses sandbox secret names for Helcim secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain('HELCIM_API_TOKEN: ${{ secrets.HELCIM_API_TOKEN_SANDBOX }}');
      expect(content).toContain(
        'HELCIM_WEBHOOK_VERIFIER: ${{ secrets.HELCIM_WEBHOOK_VERIFIER_SANDBOX }}'
      );
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_SANDBOX }}'
      );
    });

    it('preserves content outside markers', () => {
      createCiYml(`name: CI
before
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
after`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain('name: CI');
      expect(content).toContain('before');
      expect(content).toContain('after');
    });
  });

  describe('build-env section', () => {
    it('generates frontend production values', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain('VITE_API_URL: https://api.lome-chat.com');
    });

    it('uses ciSecretNameProduction for frontend secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
      );
    });
  });

  describe('deploy-secrets section', () => {
    it('generates wrangler secret put commands for all workerSecrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain(
        'echo "${{ secrets.DATABASE_URL }}" | pnpm exec wrangler secret put DATABASE_URL'
      );
      expect(content).toContain(
        'echo "${{ secrets.BETTER_AUTH_SECRET }}" | pnpm exec wrangler secret put BETTER_AUTH_SECRET'
      );
      expect(content).toContain(
        'echo "${{ secrets.RESEND_API_KEY }}" | pnpm exec wrangler secret put RESEND_API_KEY'
      );
      expect(content).toContain(
        'echo "${{ secrets.OPENROUTER_API_KEY }}" | pnpm exec wrangler secret put OPENROUTER_API_KEY'
      );
    });

    it('uses ciSecretNameProduction for Helcim deploy secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain(
        'echo "${{ secrets.HELCIM_API_TOKEN_PRODUCTION }}" | pnpm exec wrangler secret put HELCIM_API_TOKEN'
      );
      expect(content).toContain(
        'echo "${{ secrets.HELCIM_WEBHOOK_VERIFIER_PRODUCTION }}" | pnpm exec wrangler secret put HELCIM_WEBHOOK_VERIFIER'
      );
    });
  });

  describe('verify-secrets section', () => {
    it('generates for loop with all workerSecrets keys', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: verify-secrets
old content
# END GENERATED: verify-secrets`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).toContain(
        'for secret in DATABASE_URL BETTER_AUTH_SECRET RESEND_API_KEY OPENROUTER_API_KEY HELCIM_API_TOKEN HELCIM_WEBHOOK_VERIFIER; do'
      );
    });
  });

  describe('multiple sections', () => {
    it('updates all sections in a single call', () => {
      createCiYml(`name: CI

# BEGIN GENERATED: e2e-env
old e2e
# END GENERATED: e2e-env

# BEGIN GENERATED: build-env
old build
# END GENERATED: build-env

# BEGIN GENERATED: deploy-secrets
old deploy
# END GENERATED: deploy-secrets

# BEGIN GENERATED: verify-secrets
old verify
# END GENERATED: verify-secrets
`);

      updateCiWorkflow(TEST_DIR);

      const content = readCiYml();
      expect(content).not.toContain('old e2e');
      expect(content).not.toContain('old build');
      expect(content).not.toContain('old deploy');
      expect(content).not.toContain('old verify');
      expect(content).toContain('RESEND_API_KEY:');
      expect(content).toContain('VITE_API_URL:');
      expect(content).toContain('wrangler secret put');
      expect(content).toContain('for secret in');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEnvFiles } from './generate-env.js';

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

  describe('ci-e2e mode', () => {
    beforeEach(() => {
      // Set up mock CI secrets in process.env
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
      process.env.HELCIM_API_TOKEN = 'test-helcim-token';
      process.env.HELCIM_WEBHOOK_VERIFIER = 'test-helcim-verifier';
      process.env.VITE_HELCIM_JS_TOKEN = 'test-vite-helcim-token';
    });

    afterEach(() => {
      // Clean up env vars
      delete process.env.RESEND_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.HELCIM_API_TOKEN;
      delete process.env.HELCIM_WEBHOOK_VERIFIER;
      delete process.env.VITE_HELCIM_JS_TOKEN;
    });

    it('adds CI=true and E2E=true flags to .dev.vars', () => {
      generateEnvFiles(TEST_DIR, 'ci-e2e');

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('CI=true');
      expect(content).toContain('E2E=true');
    });

    it('includes CI/prod secrets from process.env in .dev.vars', () => {
      generateEnvFiles(TEST_DIR, 'ci-e2e');

      const content = readFileSync(join(TEST_DIR, 'apps/api/.dev.vars'), 'utf-8');
      expect(content).toContain('RESEND_API_KEY=test-resend-key');
      expect(content).toContain('OPENROUTER_API_KEY=test-openrouter-key');
      expect(content).toContain('HELCIM_API_TOKEN=test-helcim-token');
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER=test-helcim-verifier');
    });

    it('generates .env.local with frontend CI/prod secrets', () => {
      generateEnvFiles(TEST_DIR, 'ci-e2e');

      expect(existsSync(join(TEST_DIR, '.env.local'))).toBe(true);
      const content = readFileSync(join(TEST_DIR, '.env.local'), 'utf-8');
      expect(content).toContain('VITE_HELCIM_JS_TOKEN=test-vite-helcim-token');
    });

    it('throws if required CI secrets are missing', () => {
      delete process.env.RESEND_API_KEY;

      expect(() => {
        generateEnvFiles(TEST_DIR, 'ci-e2e');
      }).toThrow('Missing required CI secrets in process.env: RESEND_API_KEY');
    });

    it('throws listing all missing secrets', () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      expect(() => {
        generateEnvFiles(TEST_DIR, 'ci-e2e');
      }).toThrow('Missing required CI secrets in process.env: RESEND_API_KEY, OPENROUTER_API_KEY');
    });
  });
});

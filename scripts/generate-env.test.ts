import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEnvFiles, updateCiWorkflow, parseArgs, escapeEnvValue } from './generate-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR_ENV = path.resolve(__dirname, '__test-fixtures-env__');
const TEST_DIR_CI = path.resolve(__dirname, '__test-fixtures-ci__');
const TEST_DIR_EDGE = path.resolve(__dirname, '__test-fixtures-edge__');

describe('generateEnvFiles', () => {
  beforeEach(() => {
    // Create test directory structure
    mkdirSync(TEST_DIR_ENV, { recursive: true });
    mkdirSync(path.join(TEST_DIR_ENV, 'apps/api'), { recursive: true });

    // Create minimal wrangler.toml
    writeFileSync(
      path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'),
      `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
port = 8787
`
    );

    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(TEST_DIR_ENV, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('generates .dev.vars (Backend)', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR_ENV);

      expect(existsSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('Auto-generated');
    });

    it('includes backend vars with development values', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('NODE_ENV="development"');
      expect(content).toContain('API_URL="http://localhost:8787"');
      expect(content).toContain('FRONTEND_URL="http://localhost:5173"');
      expect(content).toContain('DATABASE_URL="');
      expect(content).toContain('OPAQUE_MASTER_SECRET="');
      expect(content).toContain('IRON_SESSION_SECRET="');
    });

    it('does not include CI/prod secrets in development mode', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
      expect(content).not.toContain('HELCIM_API_TOKEN');
    });

    it('does not include VITE_ vars (frontend only)', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('VITE_');
    });

    it('does not include scripts vars (scripts only)', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });
  });

  describe('generates .env.development (Frontend)', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR_ENV);

      expect(existsSync(path.join(TEST_DIR_ENV, '.env.development'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).toContain('Auto-generated');
      expect(content).toContain('pnpm generate:env');
    });

    it('includes frontend vars with development values', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).toContain('VITE_API_URL="http://localhost:8787"');
    });

    it('does NOT include backend vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('NODE_ENV=');
      expect(content).not.toContain('FRONTEND_URL=');
      // Use regex to check DATABASE_URL is not a standalone var
      expect(content).not.toMatch(/^DATABASE_URL=/m);
      expect(content).not.toContain('OPAQUE_MASTER_SECRET=');
      expect(content).not.toContain('IRON_SESSION_SECRET=');
    });

    it('does not include CI/prod secrets', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
      expect(content).not.toContain('HELCIM_API_TOKEN');
      expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
    });

    it('does not include scripts vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });
  });

  describe('generates .env.scripts (Scripts)', () => {
    it('creates the file', () => {
      generateEnvFiles(TEST_DIR_ENV);

      expect(existsSync(path.join(TEST_DIR_ENV, '.env.scripts'))).toBe(true);
    });

    it('includes header comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain('Auto-generated');
    });

    it('includes scripts vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain(
        'MIGRATION_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/hushbox"'
      );
    });

    it('includes DATABASE_URL in development (goes to Backend + Scripts)', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).toContain('DATABASE_URL="postgres://');
    });

    it('does not include frontend vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.scripts'), 'utf8');
      expect(content).not.toContain('VITE_');
    });
  });

  describe('updates wrangler.toml', () => {
    it('adds [vars] section', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('[vars]');
    });

    it('includes production values for backend non-secret vars', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('NODE_ENV = "production"');
      expect(content).toContain('API_URL = "https://api.hushbox.ai"');
      expect(content).toContain('FRONTEND_URL = "https://hushbox.ai"');
    });

    it('includes comments about backend secrets', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('Secrets deployed via CI');
      expect(content).toContain('DATABASE_URL');
      expect(content).toContain('OPAQUE_MASTER_SECRET');
      expect(content).toContain('IRON_SESSION_SECRET');
      expect(content).toContain('RESEND_API_KEY');
      expect(content).toContain('OPENROUTER_API_KEY');
      expect(content).toContain('HELCIM_API_TOKEN');
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER');
    });

    it('does not include scripts vars in secrets comment', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).not.toContain('MIGRATION_DATABASE_URL');
    });

    it('preserves existing wrangler.toml content', () => {
      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).toContain('name = "test-api"');
      expect(content).toContain('[dev]');
      expect(content).toContain('port = 8787');
    });

    it('replaces existing [vars] section if present', () => {
      writeFileSync(
        path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'),
        `name = "test-api"

[vars]
OLD_VAR = "should-be-replaced"

[dev]
port = 8787
`
      );

      generateEnvFiles(TEST_DIR_ENV);

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/wrangler.toml'), 'utf8');
      expect(content).not.toContain('OLD_VAR');
      expect(content).toContain('NODE_ENV = "production"');
    });
  });

  describe('ciE2E mode', () => {
    beforeEach(() => {
      // Set up mock CI secrets in process.env
      process.env['RESEND_API_KEY'] = 'test-resend-key';
      process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test-helcim-token';
      process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test-helcim-verifier';
      process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test-vite-helcim-token';
    });

    afterEach(() => {
      delete process.env['RESEND_API_KEY'];
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
    });

    it('adds CI=true and E2E=true flags to .dev.vars', () => {
      generateEnvFiles(TEST_DIR_ENV, 'ciE2E');

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('CI="true"');
      expect(content).toContain('E2E="true"');
    });

    it('includes ciE2E secrets from process.env in .dev.vars', () => {
      generateEnvFiles(TEST_DIR_ENV, 'ciE2E');

      const content = readFileSync(path.join(TEST_DIR_ENV, 'apps/api/.dev.vars'), 'utf8');
      expect(content).toContain('HELCIM_API_TOKEN="test-helcim-token"');
      expect(content).toContain('HELCIM_WEBHOOK_VERIFIER="test-helcim-verifier"');
      // RESEND and OPENROUTER should NOT be present (not in ciE2E)
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
    });

    it('includes frontend CI secrets in .env.development', () => {
      generateEnvFiles(TEST_DIR_ENV, 'ciE2E');

      const content = readFileSync(path.join(TEST_DIR_ENV, '.env.development'), 'utf8');
      expect(content).toContain('VITE_HELCIM_JS_TOKEN="test-vite-helcim-token"');
      expect(content).toContain('VITE_CI="true"');
    });

    it('throws if required ciE2E secrets are missing', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E');
      }).toThrow('Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX');
    });

    it('throws listing all missing secrets', () => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

      expect(() => {
        generateEnvFiles(TEST_DIR_ENV, 'ciE2E');
      }).toThrow(
        'Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX, HELCIM_WEBHOOK_VERIFIER_SANDBOX'
      );
    });
  });
});

describe('updateCiWorkflow', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR_CI, { recursive: true });
    mkdirSync(path.join(TEST_DIR_CI, '.github/workflows'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR_CI, { recursive: true, force: true });
  });

  const createCiYml = (content: string): void => {
    writeFileSync(path.join(TEST_DIR_CI, '.github/workflows/ci.yml'), content);
  };

  const readCiYml = (): string => {
    return readFileSync(path.join(TEST_DIR_CI, '.github/workflows/ci.yml'), 'utf8');
  };

  describe('e2e-env section', () => {
    it('generates env block using secret names for ciE2E secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
rest of file`);

      updateCiWorkflow(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'HELCIM_API_TOKEN_SANDBOX: ${{ secrets.HELCIM_API_TOKEN_SANDBOX }}'
      );
      expect(content).toContain(
        'HELCIM_WEBHOOK_VERIFIER_SANDBOX: ${{ secrets.HELCIM_WEBHOOK_VERIFIER_SANDBOX }}'
      );
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN_SANDBOX: ${{ secrets.VITE_HELCIM_JS_TOKEN_SANDBOX }}'
      );
      // RESEND and OPENROUTER should NOT be present in e2e-env (not in ciE2E)
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('OPENROUTER_API_KEY');
    });

    it('preserves content outside markers', () => {
      createCiYml(`name: CI
before
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
after`);

      updateCiWorkflow(TEST_DIR_CI);

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

      updateCiWorkflow(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain('VITE_API_URL: https://api.hushbox.ai');
    });

    it('uses production secret names for frontend secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

      updateCiWorkflow(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
      );
    });
  });

  describe('deploy-secrets section', () => {
    it('generates wrangler secret put commands for all backend secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateCiWorkflow(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'echo "${{ secrets.DATABASE_URL }}" | pnpm exec wrangler secret put DATABASE_URL'
      );
      expect(content).toContain(
        'echo "${{ secrets.OPAQUE_MASTER_SECRET }}" | pnpm exec wrangler secret put OPAQUE_MASTER_SECRET'
      );
      expect(content).toContain(
        'echo "${{ secrets.IRON_SESSION_SECRET }}" | pnpm exec wrangler secret put IRON_SESSION_SECRET'
      );
      expect(content).toContain(
        'echo "${{ secrets.RESEND_API_KEY }}" | pnpm exec wrangler secret put RESEND_API_KEY'
      );
      expect(content).toContain(
        'echo "${{ secrets.OPENROUTER_API_KEY_PRODUCTION }}" | pnpm exec wrangler secret put OPENROUTER_API_KEY'
      );
    });

    it('uses production secret names for Helcim deploy secrets', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

      updateCiWorkflow(TEST_DIR_CI);

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
    it('generates for loop with all backend secret keys', () => {
      createCiYml(`name: CI
# BEGIN GENERATED: verify-secrets
old content
# END GENERATED: verify-secrets`);

      updateCiWorkflow(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).toContain(
        'for secret in DATABASE_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN OPAQUE_MASTER_SECRET IRON_SESSION_SECRET RESEND_API_KEY OPENROUTER_API_KEY HELCIM_API_TOKEN HELCIM_WEBHOOK_VERIFIER; do'
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

      updateCiWorkflow(TEST_DIR_CI);

      const content = readCiYml();
      expect(content).not.toContain('old e2e');
      expect(content).not.toContain('old build');
      expect(content).not.toContain('old deploy');
      expect(content).not.toContain('old verify');
      // e2e-env has Helcim secrets (not RESEND - production only)
      expect(content).toContain('HELCIM_API_TOKEN_SANDBOX:');
      expect(content).toContain('VITE_API_URL:');
      // deploy-secrets has RESEND for production
      expect(content).toContain('wrangler secret put RESEND_API_KEY');
      expect(content).toContain('for secret in');
    });
  });
});

describe('updateCiWorkflow edge cases', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR_EDGE, { recursive: true });
    mkdirSync(path.join(TEST_DIR_EDGE, '.github/workflows'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR_EDGE, { recursive: true, force: true });
  });

  it('handles file with no markers gracefully', () => {
    writeFileSync(path.join(TEST_DIR_EDGE, '.github/workflows/ci.yml'), 'name: CI\njobs: {}');

    // Should not throw
    updateCiWorkflow(TEST_DIR_EDGE);

    const content = readFileSync(path.join(TEST_DIR_EDGE, '.github/workflows/ci.yml'), 'utf8');
    expect(content).toBe('name: CI\njobs: {}');
  });

  it('does nothing if ci.yml does not exist', () => {
    rmSync(path.join(TEST_DIR_EDGE, '.github/workflows'), { recursive: true, force: true });
    mkdirSync(path.join(TEST_DIR_EDGE, '.github/workflows'), { recursive: true });
    // ci.yml doesn't exist

    // Should not throw
    expect(() => {
      updateCiWorkflow(TEST_DIR_EDGE);
    }).not.toThrow();
  });
});

describe('parseArgs', () => {
  it('returns development by default', () => {
    expect(parseArgs([])).toBe('development');
  });

  it('returns development when no mode flag provided', () => {
    expect(parseArgs(['--other=flag'])).toBe('development');
  });

  it('parses --mode=development', () => {
    expect(parseArgs(['--mode=development'])).toBe('development');
  });

  it('parses --mode=ciVitest', () => {
    expect(parseArgs(['--mode=ciVitest'])).toBe('ciVitest');
  });

  it('parses --mode=ciE2E', () => {
    expect(parseArgs(['--mode=ciE2E'])).toBe('ciE2E');
  });

  it('parses --mode=production', () => {
    expect(parseArgs(['--mode=production'])).toBe('production');
  });

  it('throws for invalid mode', () => {
    expect(() => parseArgs(['--mode=invalid'])).toThrow(
      'Invalid mode: invalid. Valid modes: development, ciVitest, ciE2E, production'
    );
  });

  it('throws for empty mode', () => {
    expect(() => parseArgs(['--mode='])).toThrow('Invalid mode: . Valid modes:');
  });
});

describe('escapeEnvValue', () => {
  it('wraps simple values in double quotes', () => {
    expect(escapeEnvValue('simple')).toBe('"simple"');
  });

  it('handles values with equals signs', () => {
    expect(escapeEnvValue('abc123=xyz')).toBe('"abc123=xyz"');
  });

  it('handles values with hash characters (comments)', () => {
    expect(escapeEnvValue('value#comment')).toBe('"value#comment"');
  });

  it('handles values with spaces', () => {
    expect(escapeEnvValue('hello world')).toBe('"hello world"');
  });

  it('handles values with multiple special characters', () => {
    expect(escapeEnvValue('abc=def#ghi jkl')).toBe('"abc=def#ghi jkl"');
  });

  it('escapes internal double quotes', () => {
    expect(escapeEnvValue('say "hello"')).toBe(String.raw`"say \"hello\""`);
  });

  it('escapes backslashes', () => {
    expect(escapeEnvValue(String.raw`path\to\file`)).toBe(String.raw`"path\\to\\file"`);
  });

  it('escapes backslashes before double quotes', () => {
    expect(escapeEnvValue(String.raw`value\"quoted`)).toBe(String.raw`"value\\\"quoted"`);
  });

  it('handles empty values', () => {
    expect(escapeEnvValue('')).toBe('""');
  });

  it('handles values with newlines', () => {
    expect(escapeEnvValue('line1\nline2')).toBe('"line1\nline2"');
  });
});

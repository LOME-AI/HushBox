import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASSIFICATION_VARIABLES,
  Destination,
  Mode,
  getDestinations,
  ref,
  secret,
  type VariableConfig,
} from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import {
  parseDevVariables,
  parseWranglerToml,
  parseFrontendEnv,
  envPathsFor,
  getExpectedEnvUtilities,
  verifyBackendEnv,
  verifyFrontendEnv,
  verifyScriptsEnv,
  formatEnvUtilities,
  formatEnvContext,
  parseCliArgs,
  verifyAll,
  printVerificationResult,
  VERIFIED_MODES,
  findMissingKeys,
  missingKeyMessage,
  printScriptsResult,
  printProcessResult,
  verifyEnvSource,
  verifyProcessEnv,
  verifyRegistryKeys,
} from './verify-env.js';
import { frontendModeFor } from './lib/stack/stack-mode.js';
import { ENV_MODE_VARIABLE } from './with-env.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { isOutsideRoot } from './lib/path-containment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PREFIX = 'hushbox-verify-env-';

/**
 * A machine carrying none of the variables the flags derive from, so a
 * fixture's outcome is the fixture's alone.
 */
const NOTHING_AMBIENT: NodeJS.ProcessEnv = {};

/**
 * Runs one test against a fresh fixture tree, staged outside the repository.
 *
 * `scripts` is a workspace the architecture layer scans whole, so a fixture
 * tree under this file's own directory is a directory ts-morph enumerates: a
 * concurrent scan dies on it mid-life, and one that survives the glob is read
 * as repository source. Location is what closes both, not timing.
 */
function withFixtureTree(body: (fixtureDir: string) => Promise<void>): () => Promise<void> {
  return () => withScratchDirectory(FIXTURE_PREFIX, body);
}

describe('verify-env', () => {
  it(
    'stages its fixture tree outside the repository',
    withFixtureTree((fixtureDir) => {
      expect(isOutsideRoot(path, REPO_ROOT, fixtureDir)).toBe(true);
      return Promise.resolve();
    })
  );

  describe('parseDevVariables', () => {
    it(
      'parses NODE_ENV, CI, and E2E from .dev.vars file',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV=development
CI=true
E2E=true
DATABASE_URL=postgres://localhost
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await parseDevVariables(path.join(fixtureDir, '.dev.vars'));

        expect(result).toEqual({
          NODE_ENV: 'development',
          CI: 'true',
          E2E: 'true',
        });
      })
    );

    it(
      'strips double quotes from values',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV="development"
CI="true"
DATABASE_URL="postgres://localhost"
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await parseDevVariables(path.join(fixtureDir, '.dev.vars'));

        expect(result).toEqual({
          NODE_ENV: 'development',
          CI: 'true',
          E2E: undefined,
        });
      })
    );

    it(
      'strips single quotes from values',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV='production'
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await parseDevVariables(path.join(fixtureDir, '.dev.vars'));

        expect(result).toEqual({
          NODE_ENV: 'production',
          CI: undefined,
          E2E: undefined,
        });
      })
    );

    it(
      'returns undefined for missing variables',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV=production
DATABASE_URL=postgres://localhost
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await parseDevVariables(path.join(fixtureDir, '.dev.vars'));

        expect(result).toEqual({
          NODE_ENV: 'production',
          CI: undefined,
          E2E: undefined,
        });
      })
    );

    it(
      'throws if file does not exist',
      withFixtureTree(async (fixtureDir) => {
        await expect(
          parseDevVariables(path.join(fixtureDir, 'nonexistent.vars'))
        ).rejects.toThrow();
      })
    );
  });

  describe('parseWranglerToml', () => {
    it(
      'parses NODE_ENV from [vars] section',
      withFixtureTree(async (fixtureDir) => {
        const content = `name = "hushbox-api"
main = "src/index.ts"

[vars]
NODE_ENV = "production"
API_URL = "https://api.hushbox.ai"
FRONTEND_URL = "https://hushbox.ai"
`;
        await writeFile(path.join(fixtureDir, 'wrangler.toml'), content);

        const result = await parseWranglerToml(path.join(fixtureDir, 'wrangler.toml'));

        expect(result).toEqual({
          NODE_ENV: 'production',
          CI: undefined,
          E2E: undefined,
        });
      })
    );

    it(
      'throws if file does not exist',
      withFixtureTree(async (fixtureDir) => {
        await expect(
          parseWranglerToml(path.join(fixtureDir, 'nonexistent.toml'))
        ).rejects.toThrow();
      })
    );

    it(
      'returns undefined values when no [vars] section exists',
      withFixtureTree(async (fixtureDir) => {
        const content = `name = "hushbox-api"
main = "src/index.ts"
`;
        await writeFile(path.join(fixtureDir, 'wrangler.toml'), content);

        const result = await parseWranglerToml(path.join(fixtureDir, 'wrangler.toml'));

        expect(result).toEqual({
          NODE_ENV: undefined,
          CI: undefined,
          E2E: undefined,
        });
      })
    );
  });

  describe('parseFrontendEnv', () => {
    it(
      'parses VITE_CI from .env.development file',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await parseFrontendEnv(path.join(fixtureDir, '.env.development'));

        expect(result).toEqual({
          VITE_CI: 'true',
          VITE_E2E: undefined,
        });
      })
    );

    it(
      'returns undefined for missing VITE_CI',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await parseFrontendEnv(path.join(fixtureDir, '.env.development'));

        expect(result).toEqual({
          VITE_CI: undefined,
          VITE_E2E: undefined,
        });
      })
    );

    it(
      'strips the quotes the generator writes, which the bundler also strips',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_CI="true"
VITE_E2E="true"
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await parseFrontendEnv(path.join(fixtureDir, '.env.development'));

        expect(result).toEqual({
          VITE_CI: 'true',
          VITE_E2E: 'true',
        });
      })
    );

    it(
      'parses VITE_E2E from .env.development file',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
VITE_E2E=true
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await parseFrontendEnv(path.join(fixtureDir, '.env.development'));

        expect(result).toEqual({
          VITE_CI: 'true',
          VITE_E2E: 'true',
        });
      })
    );
  });

  describe('getExpectedEnvUtilities', () => {
    it('declares an expectation for every mode the shared table declares', () => {
      for (const mode of Object.values(Mode)) {
        expect(getExpectedEnvUtilities(mode)).toBeDefined();
      }
    });

    it('returns correct expectations for development mode', () => {
      const expected = getExpectedEnvUtilities('development');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      });
    });

    it('returns correct expectations for ciVitest mode', () => {
      const expected = getExpectedEnvUtilities('ciVitest');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: false,
        isDevServer: false,
        isProduction: false,
        isCI: true,
        isE2E: false,
        requiresRealServices: true,
      });
    });

    it('returns correct expectations for the local mode of the test stack', () => {
      const expected = getExpectedEnvUtilities('test');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: true,
        isDevServer: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      });
    });

    it('returns correct expectations for e2e mode', () => {
      const expected = getExpectedEnvUtilities('e2e');

      expect(expected).toEqual({
        isDev: true,
        isLocalDev: true,
        isDevServer: false,
        isProduction: false,
        isCI: false,
        isE2E: true,
        requiresRealServices: false,
      });
    });

    it('returns correct expectations for production mode', () => {
      const expected = getExpectedEnvUtilities('production');

      expect(expected).toEqual({
        isDev: false,
        isLocalDev: false,
        isDevServer: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      });
    });

    // The one profile a consumer can select the credentialled runner phase by,
    // since the runtime flags carry no mode to select on instead. The table
    // forces a new mode to declare a profile but not to declare a distinct one,
    // so nothing else stops a second mode from joining that selection.
    it('gives the CI-and-not-E2E profile to exactly one mode', () => {
      const matching = VERIFIED_MODES.filter((mode) => {
        const expected = getExpectedEnvUtilities(mode);
        return expected.isCI && !expected.isE2E;
      });

      expect(matching).toEqual([Mode.CiVitest]);
    });
  });

  describe('verifyBackendEnv', () => {
    it(
      'returns success when env matches expectations for development',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV=development
DATABASE_URL=postgres://localhost
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await verifyBackendEnv('development', {
          devVarsPath: path.join(fixtureDir, '.dev.vars'),
          wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isLocalDev).toBe(true);
        expect(result.actual.isCI).toBe(false);
      })
    );

    it(
      'returns success when env matches expectations for ciVitest',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV=development
CI=true
DATABASE_URL=postgres://localhost
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await verifyBackendEnv('ciVitest', {
          devVarsPath: path.join(fixtureDir, '.dev.vars'),
          wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isCI).toBe(true);
        expect(result.actual.isLocalDev).toBe(false);
      })
    );

    it(
      'returns success when env matches expectations for e2e',
      withFixtureTree(async (fixtureDir) => {
        const content = `NODE_ENV=development
E2E=true
DATABASE_URL=postgres://localhost
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await verifyBackendEnv('e2e', {
          devVarsPath: path.join(fixtureDir, '.dev.vars'),
          wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isCI).toBe(false);
        expect(result.actual.isE2E).toBe(true);
      })
    );

    it(
      'returns success when env matches expectations for production',
      withFixtureTree(async (fixtureDir) => {
        const content = `name = "hushbox-api"

[vars]
NODE_ENV = "production"
`;
        await writeFile(path.join(fixtureDir, 'wrangler.toml'), content);

        const result = await verifyBackendEnv('production', {
          devVarsPath: path.join(fixtureDir, '.dev.vars'),
          wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isProduction).toBe(true);
      })
    );

    it(
      'returns failure with diff when env does not match expectations',
      withFixtureTree(async (fixtureDir) => {
        // Missing CI=true for ciVitest mode
        const content = `NODE_ENV=development
DATABASE_URL=postgres://localhost
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), content);

        const result = await verifyBackendEnv('ciVitest', {
          devVarsPath: path.join(fixtureDir, '.dev.vars'),
          wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
        });

        expect(result.success).toBe(false);
        expect(result.mismatches).toContainEqual({
          key: 'isCI',
          expected: true,
          actual: false,
        });
      })
    );
  });

  describe('verifyFrontendEnv', () => {
    it(
      'returns success when env matches expectations for development',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await verifyFrontendEnv('development', {
          frontendEnvPath: path.join(fixtureDir, '.env.development'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isLocalDev).toBe(true);
      })
    );

    it(
      'returns success when env matches expectations for ciVitest',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await verifyFrontendEnv('ciVitest', {
          frontendEnvPath: path.join(fixtureDir, '.env.development'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isCI).toBe(true);
      })
    );

    it(
      'expects no development build of the vitest mode, whose backend is one',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await verifyFrontendEnv('ciVitest', {
          frontendEnvPath: path.join(fixtureDir, '.env.development'),
        });

        // The backend reads `development` out of its generated file for this
        // mode; the frontend carries the name of the stack the mode builds for,
        // which is neither the development stack nor an end-to-end one.
        expect(result.expected.isDev).toBe(false);
        expect(getExpectedEnvUtilities('ciVitest').isDev).toBe(true);
      })
    );

    it(
      'expects no development build of the local vitest mode either, whose backend is one',
      withFixtureTree(async (fixtureDir) => {
        const frontendEnvPath = path.join(fixtureDir, '.env.test');
        await writeFile(frontendEnvPath, 'VITE_API_URL=http://localhost:8787\n');

        const result = await verifyFrontendEnv('test', { frontendEnvPath });

        expect(result.success).toBe(true);
        expect(result.expected.isDev).toBe(false);
        expect(result.expected.isLocalDev).toBe(false);
        expect(result.expected.isDevServer).toBe(false);
        expect(getExpectedEnvUtilities('test').isLocalDev).toBe(true);
      })
    );

    it(
      'returns success when env matches expectations for e2e',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
VITE_E2E=true
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await verifyFrontendEnv('e2e', {
          frontendEnvPath: path.join(fixtureDir, '.env.development'),
        });

        expect(result.success).toBe(true);
        expect(result.actual.isCI).toBe(false);
        expect(result.actual.isE2E).toBe(true);
      })
    );

    it(
      'returns failure when VITE_E2E is missing for e2e mode',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await verifyFrontendEnv('e2e', {
          frontendEnvPath: path.join(fixtureDir, '.env.development'),
        });

        expect(result.success).toBe(false);
        expect(result.mismatches).toContainEqual({
          key: 'isE2E',
          expected: true,
          actual: false,
        });
      })
    );

    it(
      'reads the production mode from its own generated file',
      withFixtureTree(async (fixtureDir) => {
        const frontendEnvPath = path.join(fixtureDir, '.env.production');
        await writeFile(frontendEnvPath, 'VITE_API_URL=https://api.hushbox.ai\n');

        const result = await verifyFrontendEnv('production', { frontendEnvPath });

        expect(result.success).toBe(true);
        expect(result.actual.isProduction).toBe(true);
        expect(result.source).toBe(`${frontendEnvPath} + MODE=production`);
      })
    );

    /**
     * The production build reads this file and nothing else, so a verification
     * that passed without one would report a build green whose bundle bakes
     * whatever the build process happened to hold.
     */
    it(
      'fails the production mode when that file is absent',
      withFixtureTree(async (fixtureDir) => {
        await expect(
          verifyFrontendEnv('production', {
            frontendEnvPath: path.join(fixtureDir, '.env.production'),
          })
        ).rejects.toThrow();
      })
    );

    it(
      'refuses an end-to-end flag in the production file',
      withFixtureTree(async (fixtureDir) => {
        const frontendEnvPath = path.join(fixtureDir, '.env.production');
        await writeFile(frontendEnvPath, 'VITE_E2E=true\n');

        const result = await verifyFrontendEnv('production', { frontendEnvPath });

        expect(result.success).toBe(false);
        expect(result.mismatches).toContainEqual({ key: 'isE2E', expected: false, actual: true });
      })
    );

    it(
      'returns failure when VITE_CI is missing for CI mode',
      withFixtureTree(async (fixtureDir) => {
        const content = `VITE_API_URL=http://localhost:8787
`;
        await writeFile(path.join(fixtureDir, '.env.development'), content);

        const result = await verifyFrontendEnv('ciVitest', {
          frontendEnvPath: path.join(fixtureDir, '.env.development'),
        });

        expect(result.success).toBe(false);
        expect(result.mismatches).toContainEqual({
          key: 'isCI',
          expected: true,
          actual: false,
        });
      })
    );

    it(
      'feeds each mode the NODE_ENV its own frontend build carries',
      withFixtureTree(async (fixtureDir) => {
        const frontendEnvPath = path.join(fixtureDir, '.env.development');
        await writeFile(frontendEnvPath, 'VITE_API_URL=http://localhost:8787\n');

        for (const mode of VERIFIED_MODES) {
          const result = await verifyFrontendEnv(mode, { frontendEnvPath });

          expect(result.input.NODE_ENV).toBe(frontendModeFor(mode));
        }
      })
    );

    it(
      'names that same MODE in the source it reports',
      withFixtureTree(async (fixtureDir) => {
        const frontendEnvPath = path.join(fixtureDir, '.env.development');
        await writeFile(frontendEnvPath, 'VITE_API_URL=http://localhost:8787\n');

        for (const mode of VERIFIED_MODES) {
          const result = await verifyFrontendEnv(mode, { frontendEnvPath });

          expect(result.source).toBe(`${frontendEnvPath} + MODE=${frontendModeFor(mode)}`);
        }
      })
    );
  });

  describe('formatEnvUtilities', () => {
    it('formats EnvUtilities object as a string', () => {
      const env = {
        isDev: true,
        isLocalDev: false,
        isDevServer: false,
        isProduction: false,
        isCI: true,
        isE2E: false,
        requiresRealServices: true,
      };

      const result = formatEnvUtilities(env);

      expect(result).toBe(
        'isDev=true, isLocalDev=false, isDevServer=false, isProduction=false, isCI=true, isE2E=false, requiresRealServices=true'
      );
    });
  });

  describe('formatEnvContext', () => {
    it('formats EnvContext with all values', () => {
      const ctx = { NODE_ENV: 'development', CI: 'true', E2E: 'true' };

      const result = formatEnvContext(ctx);

      expect(result).toBe('NODE_ENV=development, CI=true, E2E=true');
    });

    it('formats EnvContext with undefined values', () => {
      const ctx = { NODE_ENV: 'production' };

      const result = formatEnvContext(ctx);

      expect(result).toBe('NODE_ENV=production, CI=undefined, E2E=undefined');
    });

    it('formats EnvContext with NODE_ENV missing', () => {
      const ctx = { CI: 'true' };

      const result = formatEnvContext(ctx);

      expect(result).toBe('NODE_ENV=undefined, CI=true, E2E=undefined');
    });
  });

  describe('parseCliArgs', () => {
    it('returns mode when valid --mode= argument is provided', () => {
      const result = parseCliArgs(['--mode=development']);

      expect(result).toEqual({ mode: 'development' });
    });

    it('returns mode for ciVitest', () => {
      const result = parseCliArgs(['--mode=ciVitest']);

      expect(result).toEqual({ mode: 'ciVitest' });
    });

    it('returns mode for e2e', () => {
      const result = parseCliArgs(['--mode=e2e']);

      expect(result).toEqual({ mode: 'e2e' });
    });

    it('returns mode for ciE2E', () => {
      const result = parseCliArgs(['--mode=ciE2E']);

      expect(result).toEqual({ mode: Mode.CiE2E });
    });

    it('returns mode for production', () => {
      const result = parseCliArgs(['--mode=production']);

      expect(result).toEqual({ mode: 'production' });
    });

    it('accepts every mode the shared table declares', () => {
      for (const mode of Object.values(Mode)) {
        expect(parseCliArgs([`--mode=${mode}`])).toEqual({ mode });
      }
    });

    it('returns error when no --mode= argument is provided', () => {
      const result = parseCliArgs([]);

      expect(result).toEqual({
        error: 'Usage: pnpm verify:env --mode=<development|test|ciVitest|e2e|ciE2E|production>',
      });
    });

    it('returns error for invalid mode', () => {
      const result = parseCliArgs(['--mode=invalid']);

      expect(result).toEqual({
        error:
          'Invalid mode: invalid. Valid modes: development, test, ciVitest, e2e, ciE2E, production',
      });
    });

    it('keeps the mode list to its table-derived messages, with none spelled in the file head', () => {
      const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'verify-env.ts'), 'utf8');
      const head = /\/\*\*[\s\S]*?\*\//.exec(source)?.[0] ?? '';
      const words: string[] = head.match(/[A-Za-z0-9]+/g) ?? [];

      expect(head).not.toBe('');
      expect(Object.values(Mode).filter((mode) => words.includes(mode))).toEqual([]);
    });

    it('refuses an argument it does not recognise rather than reading past it', () => {
      const result = parseCliArgs(['--verbose', '--mode=production']);

      expect(result).toEqual({ error: expect.stringContaining('--verbose') as unknown as string });
    });

    it('answers a usage request with the usage text', () => {
      const result = parseCliArgs(['--help']);

      expect(result).toEqual({
        error: expect.stringContaining('pnpm verify:env') as unknown as string,
      });
    });
  });

  describe('verifyAll', () => {
    it(
      'returns success when both backend and frontend pass',
      withFixtureTree(async (fixtureDir) => {
        const devVariablesContent = `NODE_ENV=development
`;
        const envDevContent = `VITE_API_URL=http://localhost:8787
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), devVariablesContent);
        await writeFile(path.join(fixtureDir, '.env.development'), envDevContent);
        await writeFile(
          path.join(fixtureDir, '.env.scripts'),
          `${ENV_MODE_VARIABLE}="development"\n`
        );

        const result = await verifyAll(
          'development',
          {
            devVarsPath: path.join(fixtureDir, '.dev.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
            frontendEnvPath: path.join(fixtureDir, '.env.development'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(true);
        expect('error' in result.backend).toBe(false);
        expect('error' in result.frontend).toBe(false);
      })
    );

    it(
      'returns failure when backend fails',
      withFixtureTree(async (fixtureDir) => {
        // Missing CI=true for ciVitest
        const devVariablesContent = `NODE_ENV=development
`;
        const envDevContent = `VITE_API_URL=http://localhost:8787
VITE_CI=true
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), devVariablesContent);
        await writeFile(path.join(fixtureDir, '.env.development'), envDevContent);
        await writeFile(
          path.join(fixtureDir, '.env.scripts'),
          `${ENV_MODE_VARIABLE}="development"\n`
        );

        const result = await verifyAll(
          'ciVitest',
          {
            devVarsPath: path.join(fixtureDir, '.dev.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
            frontendEnvPath: path.join(fixtureDir, '.env.development'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(false);
      })
    );

    it(
      'returns error object when backend file is missing',
      withFixtureTree(async (fixtureDir) => {
        const envDevContent = `VITE_API_URL=http://localhost:8787
`;
        await writeFile(path.join(fixtureDir, '.env.development'), envDevContent);
        await writeFile(
          path.join(fixtureDir, '.env.scripts'),
          `${ENV_MODE_VARIABLE}="development"\n`
        );

        const result = await verifyAll(
          'development',
          {
            devVarsPath: path.join(fixtureDir, 'nonexistent.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
            frontendEnvPath: path.join(fixtureDir, '.env.development'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(false);
        expect('error' in result.backend).toBe(true);
        expect(result.process !== null && 'error' in result.process).toBe(true);
      })
    );

    it(
      'returns error object when frontend file is missing',
      withFixtureTree(async (fixtureDir) => {
        const devVariablesContent = `NODE_ENV=development
`;
        await writeFile(path.join(fixtureDir, '.dev.vars'), devVariablesContent);
        await writeFile(
          path.join(fixtureDir, '.env.scripts'),
          `${ENV_MODE_VARIABLE}="development"\n`
        );

        const result = await verifyAll(
          'ciVitest',
          {
            devVarsPath: path.join(fixtureDir, '.dev.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
            frontendEnvPath: path.join(fixtureDir, 'nonexistent.env'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(false);
        expect('error' in result.frontend).toBe(true);
      })
    );

    it(
      'returns failure when the scripts file names another stack',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\n');
        await writeFile(
          path.join(fixtureDir, '.env.development'),
          'VITE_API_URL=http://localhost\n'
        );
        await writeFile(path.join(fixtureDir, '.env.scripts'), `${ENV_MODE_VARIABLE}="e2e"\n`);

        const result = await verifyAll(
          'development',
          {
            devVarsPath: path.join(fixtureDir, '.dev.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
            frontendEnvPath: path.join(fixtureDir, '.env.development'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(false);
        expect(result.scripts).toEqual({
          success: false,
          source: path.join(fixtureDir, '.env.scripts'),
          expected: 'development',
          actual: 'e2e',
        });
      })
    );

    it(
      'returns an error object when the scripts file is missing',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\n');
        await writeFile(
          path.join(fixtureDir, '.env.development'),
          'VITE_API_URL=http://localhost\n'
        );

        const result = await verifyAll(
          'development',
          {
            devVarsPath: path.join(fixtureDir, '.dev.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, 'nonexistent.scripts'),
            frontendEnvPath: path.join(fixtureDir, '.env.development'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(false);
        expect(result.scripts !== null && 'error' in result.scripts).toBe(true);
      })
    );

    it(
      'checks no scripts file for production, which runs no stack',
      withFixtureTree(async (fixtureDir) => {
        const toml = `[vars]\nNODE_ENV = "production"\n`;
        await writeFile(path.join(fixtureDir, 'wrangler.toml'), toml);
        await writeFile(
          path.join(fixtureDir, '.env.production'),
          'VITE_API_URL=https://api.hushbox.ai\n'
        );

        const result = await verifyAll(
          'production',
          {
            devVarsPath: path.join(fixtureDir, 'nonexistent.vars'),
            wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
            scriptsEnvPath: path.join(fixtureDir, 'nonexistent.scripts'),
            frontendEnvPath: path.join(fixtureDir, '.env.production'),
          },
          NOTHING_AMBIENT
        );

        expect(result.success).toBe(true);
        expect(result.scripts).toBeNull();
      })
    );
  });

  describe('the process-side check', () => {
    /** One fixture's paths, with the scripts file that declares the generating mode. */
    function pathsIn(
      fixtureDir: string,
      devVariables = '.dev.vars'
    ): {
      devVarsPath: string;
      wranglerTomlPath: string;
      scriptsEnvPath: string;
    } {
      return {
        devVarsPath: path.join(fixtureDir, devVariables),
        wranglerTomlPath: path.join(fixtureDir, 'wrangler.toml'),
        scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
      };
    }

    /** Writes the scripts file `generate-env` would have written for a mode. */
    async function declareGeneratingMode(fixtureDir: string, mode: string): Promise<void> {
      await writeFile(path.join(fixtureDir, '.env.scripts'), `${ENV_MODE_VARIABLE}="${mode}"\n`);
    }

    it(
      'passes when the machine own classification is cleared by a mode that states none',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\n');
        await writeFile(path.join(fixtureDir, '.env.test'), 'VITE_API_URL=http://localhost\n');
        await declareGeneratingMode(fixtureDir, 'test');

        const result = await verifyAll(
          'test',
          { ...pathsIn(fixtureDir), frontendEnvPath: path.join(fixtureDir, '.env.test') },
          { CI: 'true' }
        );

        expect(result.success).toBe(true);
      })
    );

    it(
      'keeps the flag the generating mode does state, so the machine value still counts',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\n');
        await declareGeneratingMode(fixtureDir, 'ciVitest');

        const check = await verifyProcessEnv('ciVitest', pathsIn(fixtureDir), { CI: 'true' });

        expect(check !== null && !('error' in check) && check.success).toBe(true);
      })
    );

    it(
      'verifies the continuous-integration shape: files stating CI, checked under the mode that wrote them',
      withFixtureTree(async (fixtureDir) => {
        // The shape of a continuous-integration vitest job: the files were
        // generated under the runner mode, and the suite loads the stack those
        // files belong to under its local name.
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\nCI=true\n');
        await declareGeneratingMode(fixtureDir, 'ciVitest');

        const check = await verifyProcessEnv('ciVitest', pathsIn(fixtureDir), {});

        expect(check !== null && !('error' in check) && check.input.CI).toBe('true');
        expect(check !== null && !('error' in check) && check.actual.isCI).toBe(true);
        expect(check !== null && !('error' in check) && check.success).toBe(true);
      })
    );

    it(
      'clears by the mode the files declare, and reports the divergence when the mode asked about is another',
      withFixtureTree(async (fixtureDir) => {
        // The only fixture that separates the two candidate keys. The files were
        // generated under a runner mode and state CI; the mode asked about is
        // the local sibling, which states none. Keyed on the declaration the
        // value survives and the check reports it against the local table it was
        // asked for — fail-closed, and the mismatch names the flag that moved.
        // Keyed on the mode asked about instead, the value would be gone and the
        // check would pass, seeing nothing.
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\nCI=true\n');
        await declareGeneratingMode(fixtureDir, 'ciVitest');

        const check = await verifyProcessEnv('test', pathsIn(fixtureDir), {});

        expect(check !== null && !('error' in check) && check.input.CI).toBe('true');
        expect(check !== null && !('error' in check) && check.actual.isCI).toBe(true);
        expect(check !== null && !('error' in check) && check.success).toBe(false);
        expect(check !== null && !('error' in check) && check.mismatches).toContainEqual({
          key: 'isCI',
          expected: false,
          actual: true,
        });
      })
    );

    it(
      'reports the flag a generated file failed to state',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\n');
        await declareGeneratingMode(fixtureDir, 'ciVitest');

        const check = await verifyProcessEnv('ciVitest', pathsIn(fixtureDir), {});

        expect(check).not.toBeNull();
        expect(check !== null && !('error' in check) && check.mismatches).toContainEqual({
          key: 'isCI',
          expected: true,
          actual: false,
        });
      })
    );

    it(
      'clears a stale line a mode no longer states, which the file still carries',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\nCI=true\n');
        await declareGeneratingMode(fixtureDir, 'test');

        const check = await verifyProcessEnv('test', pathsIn(fixtureDir), {});

        expect(check !== null && !('error' in check) && check.success).toBe(true);
      })
    );

    it(
      'takes NODE_ENV from the machine where the file states none',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'DATABASE_URL=postgres://localhost\n');
        await declareGeneratingMode(fixtureDir, 'test');

        const check = await verifyProcessEnv('test', pathsIn(fixtureDir), {
          NODE_ENV: 'development',
        });

        expect(check !== null && !('error' in check) && check.success).toBe(true);
      })
    );

    it(
      'refuses a file set that declares no generating mode',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.dev.vars'), 'NODE_ENV=development\n');
        await writeFile(
          path.join(fixtureDir, '.env.scripts'),
          'DATABASE_URL=postgres://localhost\n'
        );

        await expect(verifyProcessEnv('test', pathsIn(fixtureDir), {})).rejects.toThrow(
          ENV_MODE_VARIABLE
        );
      })
    );

    it('builds its context only from variables a backend file can state, in every mode that states one', () => {
      const registry: Record<string, VariableConfig> = envConfig;
      expect(CLASSIFICATION_VARIABLES.length).toBeGreaterThan(0);
      for (const name of CLASSIFICATION_VARIABLES) {
        const entry = registry[name];
        expect(
          entry,
          `${name} is read out of the loaded process but the registry declares no such variable`
        ).toBeDefined();
        const emitting = Object.values(Mode).filter(
          (mode) => entry !== undefined && getDestinations(entry, mode).length > 0
        );
        expect(emitting.length, `${name} is stated by no mode at all`).toBeGreaterThan(0);
        for (const mode of emitting) {
          expect(
            entry === undefined ? undefined : getDestinations(entry, mode),
            `${name} is read out of the loaded process, so the backend file of ${mode} has to be able to state it`
          ).toContain(Destination.Backend);
        }
      }
    });

    it(
      'throws when the mode’s file cannot be read, which verifyAll reports',
      withFixtureTree(async (fixtureDir) => {
        await expect(
          verifyProcessEnv('test', pathsIn(fixtureDir, 'nonexistent.vars'), {})
        ).rejects.toThrow();
      })
    );

    it(
      'checks no process for production, which no local process runs under',
      withFixtureTree(async (fixtureDir) => {
        const check = await verifyProcessEnv(
          'production',
          pathsIn(fixtureDir, 'nonexistent.vars'),
          { CI: 'true' }
        );

        expect(check).toBeNull();
      })
    );
  });

  describe('printProcessResult', () => {
    it('prints the line saying why a mode has no process to check', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      printProcessResult(null);

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Skipped'));
      log.mockRestore();
    });

    it('prints the failure when the loaded process disagrees with the table', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      printProcessResult(
        verifyEnvSource('test', { NODE_ENV: 'development', CI: 'true' }, 'the loaded process')
      );

      expect(error).toHaveBeenCalledWith(expect.stringContaining('FAILED'));
      error.mockRestore();
    });
  });

  describe('envPathsFor', () => {
    it('resolves the unsuffixed triple for the development mode', () => {
      expect(envPathsFor('development')).toEqual({
        devVarsPath: path.join('apps', 'api', '.dev.vars'),
        wranglerTomlPath: path.join('apps', 'api', 'wrangler.toml'),
        frontendEnvPath: '.env.development',
        scriptsEnvPath: '.env.scripts',
      });
    });

    it('resolves the e2e triple for the CI e2e mode, which generates it', () => {
      expect(envPathsFor('ciE2E')).toEqual({
        devVarsPath: path.join('apps', 'api', '.dev.vars.e2e'),
        wranglerTomlPath: path.join('apps', 'api', 'wrangler.toml'),
        frontendEnvPath: '.env.e2e',
        scriptsEnvPath: '.env.scripts.e2e',
      });
    });

    it('resolves the e2e triple for the local e2e mode', () => {
      expect(envPathsFor('e2e').frontendEnvPath).toBe('.env.e2e');
    });

    it('resolves the test triple for the CI vitest mode, whose stack is its own', () => {
      expect(envPathsFor('ciVitest').scriptsEnvPath).toBe('.env.scripts.test');
    });

    it('resolves a frontend file of its own for production, which runs no stack', () => {
      expect(envPathsFor('production').frontendEnvPath).toBe('.env.production');
    });
  });

  describe('verifyScriptsEnv', () => {
    it(
      'passes when the scripts file names the mode it was generated under',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(
          path.join(fixtureDir, '.env.scripts.e2e'),
          `${ENV_MODE_VARIABLE}="ciE2E"\n`
        );

        const result = await verifyScriptsEnv('ciE2E', {
          scriptsEnvPath: path.join(fixtureDir, '.env.scripts.e2e'),
        });

        expect(result).toEqual({
          success: true,
          source: path.join(fixtureDir, '.env.scripts.e2e'),
          expected: 'ciE2E',
          actual: 'ciE2E',
        });
      })
    );

    it(
      'rejects a file naming the stack rather than the mode that wrote it',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.env.scripts.e2e'), `${ENV_MODE_VARIABLE}="e2e"\n`);

        const result = await verifyScriptsEnv('ciE2E', {
          scriptsEnvPath: path.join(fixtureDir, '.env.scripts.e2e'),
        });

        expect(result.success).toBe(false);
        expect(result.expected).toBe('ciE2E');
      })
    );

    it(
      'fails when the scripts file declares no mode at all',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.env.scripts'), 'HB_API_PORT="10400"\n');

        const result = await verifyScriptsEnv('development', {
          scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
        });

        expect(result.success).toBe(false);
        expect(result.actual).toBeUndefined();
      })
    );

    it(
      'rejects a file whose mode disagrees with the one being verified',
      withFixtureTree(async (fixtureDir) => {
        await writeFile(path.join(fixtureDir, '.env.scripts'), `${ENV_MODE_VARIABLE}="e2e"\n`);

        const result = await verifyScriptsEnv('ciVitest', {
          scriptsEnvPath: path.join(fixtureDir, '.env.scripts'),
        });

        expect(result.success).toBe(false);
        expect(result.expected).toBe('ciVitest');
      })
    );
  });

  describe('printScriptsResult', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports the mode a passing scripts file declares', () => {
      printScriptsResult({
        success: true,
        source: '.env.scripts.e2e',
        expected: 'ciE2E',
        actual: 'ciE2E',
      });

      expect(logSpy.mock.calls.flat().join(' ')).toContain('.env.scripts.e2e');
    });

    it('reports the disagreement when the scripts file names another mode', () => {
      printScriptsResult({
        success: false,
        source: '.env.scripts',
        expected: 'development',
        actual: 'e2e',
      });

      expect(errorSpy.mock.calls.flat().join(' ')).toContain('e2e');
    });

    it('names the absent variable when the scripts file declares no mode', () => {
      printScriptsResult({
        success: false,
        source: '.env.scripts',
        expected: 'development',
        actual: undefined,
      });

      expect(errorSpy.mock.calls.flat().join(' ')).toContain(`${ENV_MODE_VARIABLE}=undefined`);
    });

    it('reports the read failure when the scripts file could not be read', () => {
      printScriptsResult({ error: 'ENOENT' });

      expect(errorSpy.mock.calls.flat().join(' ')).toContain('ENOENT');
    });

    it('names the reason the skipped mode has nothing to check', () => {
      printScriptsResult(null);

      expect(logSpy.mock.calls.flat().join(' ')).toContain(
        'this mode runs no stack, so its generation writes no scripts file'
      );
    });
  });

  describe('printVerificationResult', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prints success message for successful verification', () => {
      const result = {
        success: true,
        actual: {
          isDev: true,
          isLocalDev: true,
          isDevServer: true,
          isProduction: false,
          isCI: false,
          isE2E: false,
          requiresRealServices: false,
        },
        expected: {
          isDev: true,
          isLocalDev: true,
          isDevServer: true,
          isProduction: false,
          isCI: false,
          isE2E: false,
          requiresRealServices: false,
        },
        mismatches: [],
        source: 'test/.dev.vars',
        input: { NODE_ENV: 'development' },
      };

      printVerificationResult('Backend', result);

      expect(logSpy).toHaveBeenCalledWith('  ✓ Backend environment verification passed');
    });

    it('prints failure message for failed verification', () => {
      const result = {
        success: false,
        actual: {
          isDev: true,
          isLocalDev: true,
          isDevServer: true,
          isProduction: false,
          isCI: false,
          isE2E: false,
          requiresRealServices: false,
        },
        expected: {
          isDev: true,
          isLocalDev: false,
          isDevServer: false,
          isProduction: false,
          isCI: true,
          isE2E: false,
          requiresRealServices: true,
        },
        mismatches: [{ key: 'isCI' as const, expected: true, actual: false }],
        source: 'test/.dev.vars',
        input: { NODE_ENV: 'development' },
      };

      printVerificationResult('Backend', result);

      expect(console.error).toHaveBeenCalledWith('  ✗ Backend environment verification FAILED');
    });

    it('prints error message for error result', () => {
      const result = { error: 'File not found' };

      printVerificationResult('Frontend', result);

      expect(console.error).toHaveBeenCalledWith('  ✗ Frontend verification error: File not found');
    });
  });

  describe('per-key completeness (findMissingKeys)', () => {
    it('reports no missing keys for the real env registry across every verified mode', () => {
      // The shipped registry is complete: every declared key resolves in every
      // verified mode. This is the "fully-present env still passes" guarantee.
      expect(findMissingKeys(envConfig)).toEqual([]);
    });

    it('catches a key declared for a mode that resolves to nothing (dangling ref)', () => {
      // DANGLING is declared for ciE2E via a ref to production, which omits it —
      // exactly the per-key gap a derived-flag check cannot see.
      const registry: Record<string, VariableConfig> = {
        DANGLING: {
          to: [Destination.Backend],
          [Mode.CiE2E]: ref(Mode.Production),
        },
      };

      expect(findMissingKeys(registry)).toEqual([{ mode: Mode.CiE2E, key: 'DANGLING' }]);
    });

    it('does not flag a key present via a secret directive', () => {
      const registry: Record<string, VariableConfig> = {
        PRESENT: {
          to: [Destination.Backend],
          [Mode.Production]: secret('PRESENT'),
        },
      };

      expect(findMissingKeys(registry)).toEqual([]);
    });

    it('asserts every mode the shared table declares', () => {
      expect(VERIFIED_MODES).toEqual(Object.values(Mode));
    });

    it('finds no dangling key in the e2e mode the registry now generates files for', () => {
      expect(findMissingKeys(envConfig, [Mode.E2E])).toEqual([]);
    });
  });

  describe('missingKeyMessage', () => {
    it('names the specific missing key and its mode', () => {
      const message = missingKeyMessage({ mode: Mode.CiE2E, key: 'DATABASE_URL' });

      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('ciE2E');
    });
  });

  describe('verifyRegistryKeys', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns true for the real env registry', () => {
      expect(verifyRegistryKeys()).toBe(true);
    });

    it('returns false and prints the missing key when a declared key is unresolvable', () => {
      const registry: Record<string, VariableConfig> = {
        DANGLING: {
          to: [Destination.Backend],
          [Mode.Development]: ref(Mode.Production),
        },
      };

      expect(verifyRegistryKeys(registry)).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('DANGLING') as unknown as string
      );
    });
  });
});

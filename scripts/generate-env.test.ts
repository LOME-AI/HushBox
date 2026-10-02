import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, execaSync } from 'execa';
import { parse as dotenvParse } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { loadManifest } from '@hushbox/ops/generate-labels';
import {
  applyWorktreePorts,
  generatedEnvPaths,
  generatedValue,
  generateEnvFiles,
  stackModeFor,
  generateSecretsInventory,
  replaceSection,
  updateGeneratedFiles,
  workflowSections,
  deploySecretKeys,
  escrowEnvironmentOf,
  escrowEnvironments,
  escrowedSecretKeys,
  escrowSectionMarker,
  SECRETS_DOC,
  WORKFLOW_FILES,
  parseArgs,
  escapeEnvValue,
  generateOpsEnv,
} from './generate-env.js';
import { CI_SECRETS } from '../packages/shared/src/env/ci-secrets.js';
import { BACKUP_VARIABLES } from './lib/backup/run.js';
import {
  Destination,
  Mode,
  STACK_DATABASE_MARKER,
  envConfig,
  getDestinations,
  isSecret,
  resolveRaw,
  resolveValue,
} from '../packages/shared/src/env/env.config.js';
import * as envConfigModule from '../packages/shared/src/env/env.config.js';
import {
  DISPATCH_OPTIONS_MARKER,
  DISPATCH_OPTIONS_OWNERS,
  DISPATCH_WORKFLOW_PATH,
} from '../ops/lib/generate-dispatch-options.js';
import { claimSlot, readSlotClaims, slotsDir } from './lib/claims/slot-claim.js';
import { canonicalPath } from './lib/canonical-path.js';
import { StagedWriteFailed } from './lib/staged-write.js';
import { getWorkspacePaths } from './lib/cli/workspaces.js';
import { composeProjectName, getWorktreeConfig } from './lib/cli/worktree.js';
import { portEnvName } from './lib/stack/dev-ports.js';
import {
  describePort,
  portsFor,
  SERVICE_KEYS,
  STACK_MODES,
  type ServiceKey,
  type StackMode,
} from './lib/stack/port-plan.js';
import { envModeForStack, isPerCheckoutMode } from './lib/stack/stack-mode.js';
import {
  STACK_BUCKET_LIST_VARIABLE,
  mediaBucketName,
  stackBucketsFrom,
} from './lib/stack/stack-bucket.js';
import { stackDatabaseName } from './lib/stack/stack-database.js';
import { GITLEAKS_VERSION } from './lib/privacy/gitleaks.js';
import { SURFACE_ORIGINS } from './lib/deployed-surfaces.js';
import { generateE2eMatrix, generateE2eRunSet } from './lib/playwright/e2e-workflow-sections.js';
import { E2E_PROJECTS } from './lib/playwright/projects.js';
import { findRunExpressions } from './lib/publication/workflow-run-expressions.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { isOutsideRoot } from './lib/path-containment.js';
import type { Credential, VariableConfig } from '../packages/shared/src/env/env-types.js';
import type { EnvMode } from '../packages/shared/src/env/env.config.js';
import type { OpsScript } from '@hushbox/ops/generate-labels';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The Worker keys the OTA upload step mints, one per native platform bundle. */
const OTA_CHECKSUM_KEYS = [
  'APP_BUNDLE_CHECKSUM_IOS',
  'APP_BUNDLE_CHECKSUM_ANDROID',
  'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT',
] as const;

/** Every credential declaration the two homes hold, keyed by its declaration name. */
const declaredCredentials = (): [string, Credential][] => [
  ...Object.entries(envConfig).flatMap(([key, config]): [string, Credential][] => {
    const { credential } = config as VariableConfig;
    return credential ? [[key, credential]] : [];
  }),
  ...Object.entries(CI_SECRETS),
];

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Every secret one mode declares, stubbed. Derived rather than listed: a mode
 * resolves its `secret(...)` markers out of the process environment, and a
 * developer machine holds none of the ones only CI carries.
 */
function stubSecretsFor(mode: EnvMode): void {
  for (const config of Object.values(envConfig)) {
    const raw = resolveRaw(config as VariableConfig, mode);
    if (isSecret(raw)) vi.stubEnv(raw.name, `stubbed-${raw.name}`);
  }
}

/**
 * Every secret some stack's own mode declares, stubbed — what a suite that
 * generates every stack's files needs present.
 */
function stubStackSecrets(): void {
  for (const stackMode of STACK_MODES) stubSecretsFor(envModeForStack(stackMode));
}

/** Some slot other than `slot`, standing in for a checkout that is not this one. */
function otherSlot(slot: number): number {
  return slot === 0 ? 1 : 0;
}

/**
 * Puts the checkout at `root` somewhere other than the first slot, so an
 * assertion that a generated file carries its own checkout's slot cannot pass
 * by agreeing with a fallback that names the first. The slot registry is
 * machine-wide, so it is pointed inside the fixture tree first: seeding the
 * real one would take slots from the checkouts on this machine. Returns the
 * slot `root` then holds.
 */
function claimSlotsAhead(root: string): number {
  vi.stubEnv('TMPDIR', path.join(root, 'registry-temp'));
  for (const name of ['ahead-one', 'ahead-two', 'ahead-three']) {
    const ahead = path.join(root, name);
    mkdirSync(path.join(ahead, '.git'), { recursive: true });
    claimSlot({ worktreePath: ahead, gitDir: path.join(ahead, '.git') });
  }
  return getWorktreeConfig(root).slot;
}

/**
 * Builds the wrapper a suite's tests take their fixture tree from: a fresh
 * directory outside the repository, staged by `setUp` and handed back to
 * `tearDown` before removal.
 *
 * `scripts` is a workspace the architecture layer scans whole, so a fixture
 * tree under this file's own directory is a directory ts-morph enumerates: a
 * concurrent scan dies on it mid-life, and one that survives the glob is read
 * as repository source. Location is what closes both, not timing.
 */
function fixtureRunner(
  prefix: string,
  setUp: (root: string) => void,
  tearDown?: (root: string) => void
): <A extends unknown[]>(
  body: (...args: A) => void | Promise<void>
) => (...args: A) => Promise<void> {
  return (body) =>
    (...args) =>
      withScratchDirectory(prefix, async (root) => {
        setUp(root);
        try {
          await body(...args);
        } finally {
          tearDown?.(root);
        }
      });
}

/** The secrets document as the human writes it: the inventory pair, nothing between. */
const EMPTY_INVENTORY_DOC = `# Secrets

<!-- BEGIN GENERATED: secrets-inventory -->
<!-- END GENERATED: secrets-inventory -->
`;

/**
 * Workflow files a fixture tree can hand to `updateGeneratedFiles`.
 *
 * The renderer refuses a file whose marker pairs are not the ones its sections
 * declare, so a body carrying only the section under test is completed with the
 * pairs it lacks — taken from the declaration, so a new section needs no edit
 * here. `read` empties those again, because a test asserting what a section does
 * not emit must not be shown a neighbouring section's output; a section the body
 * declares itself is left alone, since that is the one the test is reading.
 */
function workflowFixture(rootDir: () => string): {
  write: (relativePath: string, body: string) => void;
  read: (relativePath: string) => string;
} {
  const paddedIn = new Map<string, string[]>();
  const beginsIn = (text: string, marker: string): number =>
    text.split(`# BEGIN GENERATED: ${marker}\n`).length - 1;

  return {
    write: (relativePath, body) => {
      const padded: string[] = [];
      const pairs: string[] = [];
      for (const [marker, section] of Object.entries(workflowSections())) {
        const declared = section.owners.filter((owner) => owner === relativePath).length;
        const present = beginsIn(body, marker);
        if (present === 0 && declared > 0) padded.push(marker);
        for (let index = present; index < declared; index++) {
          pairs.push(`# BEGIN GENERATED: ${marker}`, `# END GENERATED: ${marker}`);
        }
      }
      paddedIn.set(relativePath, padded);
      writeFileSync(path.join(rootDir(), relativePath), [body, ...pairs].join('\n'));
    },
    read: (relativePath) => {
      let text = readFileSync(path.join(rootDir(), relativePath), 'utf8');
      for (const marker of paddedIn.get(relativePath) ?? []) {
        text = replaceSection(text, marker, '');
      }
      return text;
    },
  };
}

/**
 * Where a slot claimed anywhere in this file lands.
 *
 * `getWorktreeConfig` claims a slot rather than reading one, so every case that
 * reaches it — through the helpers, or through the generator, which asks for the
 * generating checkout's slot — allocates out of whichever registry the OS
 * temporary directory names. Left at the machine's, a case takes a slot from the
 * checkouts on it and leaves a record there naming a fixture tree that the case
 * then deletes.
 */
let registryRoot = '';

/** The registry a case would claim out of with no redirection in place. */
const MACHINE_SLOTS_DIR = slotsDir();

beforeEach(() => {
  registryRoot = mkdtempSync(path.join(os.tmpdir(), 'hushbox-generate-env-registry-'));
  const registryTemporary = path.join(registryRoot, 'registry-temp');
  // Created rather than left to the allocator: the fixture trees a case stages
  // are made under this directory too, and the first of those is made before
  // any claim exists to have made it.
  mkdirSync(registryTemporary, { recursive: true });
  vi.stubEnv('TMPDIR', registryTemporary);
});

afterEach(() => {
  // Unstubbed here rather than left to the runner, which unstubs before a test
  // rather than after one: a suite whose `beforeAll` stages a tree under the OS
  // temporary directory runs in the gap between, and would stage it inside the
  // root the line below has just removed.
  vi.unstubAllEnvs();
  rmSync(registryRoot, { recursive: true, force: true });
});

describe('the registry a case claims its slot out of', () => {
  /** Every checkout the slot registry at `dir` holds a record for. */
  const checkoutsHoldingSlots = (dir: string): string[] =>
    [...readSlotClaims(dir).values()].map((record) => record.worktreePath);

  /** A checkout git would list, staged inside this case's own temporary root. */
  const stageCheckout = (name: string): string => {
    const checkout = path.join(registryRoot, name);
    mkdirSync(path.join(checkout, '.git'), { recursive: true });
    return checkout;
  };

  it('takes the claim the worktree configuration makes', () => {
    const checkout = stageCheckout('worktree-configuration');

    getWorktreeConfig(checkout);

    expect(path.dirname(slotsDir())).toBe(path.join(registryRoot, 'registry-temp'));
    expect(checkoutsHoldingSlots(slotsDir())).toContain(canonicalPath(checkout));
    expect(checkoutsHoldingSlots(MACHINE_SLOTS_DIR)).not.toContain(canonicalPath(checkout));
  });

  it('takes the claim a generated set of env files makes', () => {
    const checkout = stageCheckout('generated-env-files');
    mkdirSync(path.join(checkout, 'apps/api'), { recursive: true });
    writeFileSync(path.join(checkout, 'apps/api/wrangler.toml'), '# Wrangler configuration\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    generateEnvFiles(checkout);

    expect(checkoutsHoldingSlots(slotsDir())).toContain(canonicalPath(checkout));
    expect(checkoutsHoldingSlots(MACHINE_SLOTS_DIR)).not.toContain(canonicalPath(checkout));
  });
});

describe('generateEnvFiles', () => {
  const originalTemporaryDirectory = process.env['TMPDIR'];
  let envRoot = '';

  const withEnvFixture = fixtureRunner(
    'hushbox-generate-env-',
    (root) => {
      envRoot = root;
      mkdirSync(path.join(root, 'apps/api'), { recursive: true });

      // Simulate main repo (.git as directory) for worktree detection
      mkdirSync(path.join(root, '.git'), { recursive: true });

      writeFileSync(
        path.join(root, 'apps/api/wrangler.toml'),
        `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
local_protocol = "http"
`
      );

      vi.spyOn(console, 'log').mockImplementation(() => {});
    },
    (root) => {
      // The write-behaviour tests revoke write permission on the fixture, and
      // removal needs it back.
      for (const relative of ['apps/api', '.']) {
        const directory = path.join(root, relative);
        if (existsSync(directory)) chmodSync(directory, 0o755);
      }
    }
  );

  afterEach(() => {
    if (originalTemporaryDirectory === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = originalTemporaryDirectory;
    vi.restoreAllMocks();
  });

  it(
    'stages its fixture tree outside the repository',
    withEnvFixture(() => {
      expect(isOutsideRoot(path, REPO_ROOT, envRoot)).toBe(true);
    })
  );

  // The pre-commit hook stages exactly what this returns, which is why no list
  // of generated workflow files is maintained anywhere outside this generator.
  describe('reports the committed files it wrote', () => {
    it(
      'returns the wrangler config and every workflow it rewrote',
      withEnvFixture(() => {
        mkdirSync(path.join(envRoot, '.github/workflows'), { recursive: true });
        const fixture = workflowFixture(() => envRoot);
        fixture.write('.github/workflows/ci.yml', 'name: CI\n');
        fixture.write('.github/workflows/build-ios.yml', 'name: iOS\n');

        const written = generateEnvFiles(envRoot);

        expect(written).toEqual([
          path.join(envRoot, 'apps/api/wrangler.toml'),
          path.join(envRoot, '.github/workflows/ci.yml'),
          path.join(envRoot, '.github/workflows/build-ios.yml'),
        ]);
        // Zero writes is the ordinary repeat run, and the hook refuses an empty
        // list, so every generated-block owner is named whether this run changed
        // its bytes or not.
        expect(generateEnvFiles(envRoot)).toEqual(written);
      })
    );

    it(
      'returns the secrets document once its inventory is rewritten',
      withEnvFixture(() => {
        mkdirSync(path.join(envRoot, 'docs'), { recursive: true });
        const document = path.join(envRoot, SECRETS_DOC);
        writeFileSync(document, EMPTY_INVENTORY_DOC);

        expect(generateEnvFiles(envRoot)).toContain(document);
      })
    );

    it(
      'writes the inventory table into the secrets document',
      withEnvFixture(() => {
        mkdirSync(path.join(envRoot, 'docs'), { recursive: true });
        const document = path.join(envRoot, SECRETS_DOC);
        writeFileSync(document, EMPTY_INVENTORY_DOC);

        generateEnvFiles(envRoot);

        expect(readFileSync(document, 'utf8')).toContain('| Name ');
      })
    );

    it(
      'keeps stdout free of progress so a caller can capture those paths',
      withEnvFixture(() => {
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

        generateEnvFiles(envRoot);

        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalled();
      })
    );
  });

  describe('generates .dev.vars (Backend)', () => {
    it(
      'creates the file',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        expect(existsSync(path.join(envRoot, 'apps/api/.dev.vars'))).toBe(true);
      })
    );

    it(
      'includes header comment',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).toContain('Auto-generated');
      })
    );

    it(
      'includes backend vars with development values',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'utf8');
        const { ports } = getWorktreeConfig(envRoot);
        expect(content).toContain('NODE_ENV="development"');
        expect(content).toContain(`API_URL="http://localhost:${String(ports.api)}"`);
        expect(content).toContain(`FRONTEND_URL="http://localhost:${String(ports.vite)}"`);
        expect(content).toContain('DATABASE_URL="');
        expect(content).toContain('OPAQUE_KEK="');
        expect(content).toContain('IRON_SESSION_SECRET="');
      })
    );

    it(
      'does not include CI/prod secrets in development mode',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).not.toContain('RESEND_API_KEY');
        expect(content).not.toContain('HELCIM_API_TOKEN');
      })
    );

    it(
      'does not include VITE_ vars (frontend only)',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).not.toContain('VITE_');
      })
    );

    it(
      'does not include scripts vars (scripts only)',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).not.toContain('MIGRATION_DATABASE_URL');
      })
    );
  });

  describe('generates .env.development (Frontend)', () => {
    it(
      'creates the file',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        expect(existsSync(path.join(envRoot, '.env.development'))).toBe(true);
      })
    );

    it(
      'includes header comment',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.development'), 'utf8');
        expect(content).toContain('Auto-generated');
        expect(content).toContain('pnpm generate:env');
      })
    );

    it(
      'includes frontend vars with development values',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.development'), 'utf8');
        const { ports } = getWorktreeConfig(envRoot);
        expect(content).toContain(`VITE_API_URL="http://localhost:${String(ports.api)}"`);
        expect(content).toContain(
          `VITE_DRIZZLE_STUDIO_URL="http://localhost:${String(ports.studio)}"`
        );
        expect(content).toContain(`VITE_ADMIN_URL="http://localhost:${String(ports.admin)}"`);
      })
    );

    it(
      'does NOT include backend vars',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.development'), 'utf8');
        expect(content).not.toContain('NODE_ENV=');
        expect(content).not.toContain('FRONTEND_URL=');
        // Use regex to check DATABASE_URL is not a standalone var
        expect(content).not.toMatch(/^DATABASE_URL=/m);
        expect(content).not.toContain('OPAQUE_KEK=');
        expect(content).not.toContain('IRON_SESSION_SECRET=');
      })
    );

    it(
      'does not include CI/prod secrets',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.development'), 'utf8');
        expect(content).not.toContain('RESEND_API_KEY');
        expect(content).not.toContain('OPENROUTER_API_KEY');
        expect(content).not.toContain('HELCIM_API_TOKEN');
      })
    );

    it(
      'does not include scripts vars',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.development'), 'utf8');
        expect(content).not.toContain('MIGRATION_DATABASE_URL');
      })
    );
  });

  describe('generates .env.scripts (Scripts)', () => {
    it(
      'creates the file',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        expect(existsSync(path.join(envRoot, '.env.scripts'))).toBe(true);
      })
    );

    it(
      'includes header comment',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.scripts'), 'utf8');
        expect(content).toContain('Auto-generated');
      })
    );

    it(
      'includes scripts vars',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.scripts'), 'utf8');
        const { ports } = getWorktreeConfig(envRoot);
        expect(content).toContain(
          `MIGRATION_DATABASE_URL="postgresql://hushbox_app:hushbox_app@localhost:${String(ports.postgres)}/hushbox"`
        );
      })
    );

    it(
      'includes DATABASE_URL in development (goes to Backend + Scripts)',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.scripts'), 'utf8');
        expect(content).toContain('DATABASE_URL="postgres://');
      })
    );

    it(
      'keeps the development stack on the database it already had',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.scripts'), 'utf8');
        expect(content).toContain(
          `DATABASE_URL="postgres://hushbox_app:hushbox_app@localhost:${String(getWorktreeConfig(envRoot).ports.neon)}/hushbox"`
        );
      })
    );

    it(
      'gives the end-to-end stack a database of its own',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, Mode.E2E);

        const content = readFileSync(path.join(envRoot, '.env.scripts.e2e'), 'utf8');
        expect(content).toContain(`/${stackDatabaseName('e2e')}"`);
      })
    );

    it(
      'retargets every Postgres URL of a stack, not only the one the app reads',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, Mode.E2E);

        const content = readFileSync(path.join(envRoot, '.env.scripts.e2e'), 'utf8');
        expect(content).toContain(
          `MIGRATION_DATABASE_URL="postgresql://hushbox_app:hushbox_app@localhost:${String(portsFor({ slot: getWorktreeConfig(envRoot).slot, mode: 'e2e' }).postgres)}/${stackDatabaseName('e2e')}"`
        );
      })
    );

    it(
      'leaves no unresolved database marker in a generated file',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, Mode.E2E);

        for (const file of ['.env.scripts.e2e', '.env.e2e', 'apps/api/.dev.vars.e2e']) {
          expect(readFileSync(path.join(envRoot, file), 'utf8')).not.toContain(
            STACK_DATABASE_MARKER
          );
        }
      })
    );

    it(
      'does not include frontend vars',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, '.env.scripts'), 'utf8');
        expect(content).not.toContain('VITE_API_URL');
        expect(content).not.toContain('VITE_HELCIM');
        expect(content).not.toContain('VITE_CI');
        expect(content).not.toContain('VITE_E2E');
      })
    );
  });

  describe('updates wrangler.toml', () => {
    it(
      'adds [vars] section',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).toContain('[vars]');
      })
    );

    it(
      'includes production values for backend non-secret vars',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).toContain('NODE_ENV = "production"');
        expect(content).toContain('API_URL = "https://api.hushbox.ai"');
        expect(content).toContain('FRONTEND_URL = "https://hushbox.ai"');
      })
    );

    it(
      'names the deploy upload as where the listed secrets are published',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).toContain('wrangler deploy --secrets-file');
        expect(content).not.toContain('secret bulk');
      })
    );

    it(
      'includes comments about backend secrets',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).toContain('Secrets deployed via CI');
        expect(content).toContain('DATABASE_URL');
        expect(content).toContain('OPAQUE_KEK');
        expect(content).toContain('IRON_SESSION_SECRET');
        expect(content).toContain('RESEND_API_KEY');
        expect(content).toContain('HELCIM_API_TOKEN');
        expect(content).toContain('HELCIM_WEBHOOK_VERIFIER');
      })
    );

    it(
      'does not include scripts vars in secrets comment',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).not.toContain('MIGRATION_DATABASE_URL');
      })
    );

    it(
      'preserves existing wrangler.toml content',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).toContain('name = "test-api"');
        expect(content).toContain('[dev]');
      })
    );

    it(
      'replaces existing [vars] section if present',
      withEnvFixture(() => {
        writeFileSync(
          path.join(envRoot, 'apps/api/wrangler.toml'),
          `name = "test-api"

[vars]
OLD_VAR = "should-be-replaced"

[dev]
local_protocol = "http"
`
        );

        generateEnvFiles(envRoot);

        const content = readFileSync(path.join(envRoot, 'apps/api/wrangler.toml'), 'utf8');
        expect(content).not.toContain('OLD_VAR');
        expect(content).toContain('NODE_ENV = "production"');
      })
    );
  });

  describe('e2e mode', () => {
    beforeEach(() => {
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

    it(
      'adds E2E=true flag but NOT CI=true to the backend file',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, 'e2e');

        const content = readFileSync(path.join(envRoot, generatedEnvPaths('e2e').backend), 'utf8');
        expect(content).not.toContain('CI="true"');
        expect(content).toContain('E2E="true"');
      })
    );

    it(
      'does not include Helcim secrets in the backend file (local e2e uses mock verifier)',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, 'e2e');

        const content = readFileSync(path.join(envRoot, generatedEnvPaths('e2e').backend), 'utf8');
        expect(content).not.toContain('HELCIM_API_TOKEN');
        // Webhook verifier uses development mock value
        expect(content).toContain('HELCIM_WEBHOOK_VERIFIER=');
        expect(content).not.toContain('RESEND_API_KEY');
      })
    );

    it(
      'does not include Helcim secrets in the frontend file (local e2e has no secrets)',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, 'e2e');

        const content = readFileSync(path.join(envRoot, generatedEnvPaths('e2e').frontend), 'utf8');
        expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
        expect(content).not.toContain('VITE_CI');
        expect(content).toContain('VITE_E2E="true"');
      })
    );

    it(
      'names every port of its own band in the scripts file',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, 'e2e');

        const content = readFileSync(path.join(envRoot, generatedEnvPaths('e2e').scripts), 'utf8');
        const { slot } = getWorktreeConfig(envRoot);
        expect(content).toContain(`HB_STACK_SLOT="${String(slot)}"`);
        const ports = portsFor({ slot, mode: 'e2e' });
        for (const service of SERVICE_KEYS) {
          expect(content).toContain(`${portEnvName(service)}="${String(ports[service])}"`);
        }
      })
    );

    it(
      'applies worktree detection like development mode',
      withEnvFixture(() => {
        // E2E mode runs on local infrastructure, so worktree ports apply. The
        // fixture's `.git` is a directory by default (main checkout); replacing it
        // with a gitdir pointer is what makes the checkout a worktree.
        rmSync(path.join(envRoot, '.git'), { recursive: true, force: true });
        writeFileSync(
          path.join(envRoot, '.git'),
          'gitdir: /checkouts/repo/.git/worktrees/e2e-feature\n'
        );

        generateEnvFiles(envRoot, 'e2e');

        const { slot, projectName } = getWorktreeConfig(envRoot);
        const ports = portsFor({ slot, mode: 'e2e' });
        const content = readFileSync(path.join(envRoot, generatedEnvPaths('e2e').scripts), 'utf8');
        expect(content).toContain(`COMPOSE_PROJECT_NAME="${projectName}"`);
        expect(content).toContain(`HB_STACK_SLOT="${String(slot)}"`);
        expect(content).toContain(`HB_VITE_PORT="${String(ports.vite)}"`);
        expect(content).toContain(`HB_API_PORT="${String(ports.api)}"`);
        expect(content).toContain(`HB_POSTGRES_PORT="${String(ports.postgres)}"`);
        expect(content).not.toContain(`HB_STACK_SLOT="${String(otherSlot(slot))}"`);
      })
    );

    it(
      'succeeds without CI secrets (local e2e needs no secrets)',
      withEnvFixture(() => {
        delete process.env['HELCIM_API_TOKEN_SANDBOX'];
        delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

        expect(() => {
          generateEnvFiles(envRoot, 'e2e');
        }).not.toThrow();
      })
    );
  });

  describe('per-mode env files', () => {
    const relativePaths = (stackMode: StackMode): string[] =>
      Object.values(generatedEnvPaths(stackMode));

    const seed = (stackMode: StackMode): void => {
      for (const relative of relativePaths(stackMode)) {
        writeFileSync(path.join(envRoot, relative), 'seeded\n');
      }
    };

    const readBack = (stackMode: StackMode): string[] =>
      relativePaths(stackMode).map((relative) =>
        readFileSync(path.join(envRoot, relative), 'utf8')
      );

    const otherStacks = (stackMode: StackMode): StackMode[] =>
      STACK_MODES.filter((other) => other !== stackMode);

    beforeEach(stubStackSecrets);

    const scriptsText = (stackMode: StackMode): string =>
      readFileSync(path.join(envRoot, generatedEnvPaths(stackMode).scripts), 'utf8');

    const generatedText = (stackMode: StackMode): string => readBack(stackMode).join('\n');

    it('gives every stack paths of its own', () => {
      const all = STACK_MODES.flatMap((stackMode) => relativePaths(stackMode));

      expect(new Set(all).size).toBe(all.length);
    });

    it.each([...STACK_MODES])(
      'writes its own stack files and no other stack files (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        for (const relative of relativePaths(stackMode)) {
          expect(existsSync(path.join(envRoot, relative))).toBe(true);
        }
        for (const other of otherStacks(stackMode)) {
          for (const relative of relativePaths(other)) {
            expect(existsSync(path.join(envRoot, relative))).toBe(false);
          }
        }
      })
    );

    it.each([...STACK_MODES])(
      'leaves every other stack file untouched (%s)',
      withEnvFixture((stackMode: StackMode) => {
        for (const other of otherStacks(stackMode)) seed(other);

        generateEnvFiles(envRoot, envModeForStack(stackMode));

        for (const other of otherStacks(stackMode)) {
          expect(readBack(other)).toEqual(['seeded\n', 'seeded\n', 'seeded\n']);
        }
      })
    );

    it.each([...STACK_MODES])(
      'names the stack beside the slot (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        const content = scriptsText(stackMode);
        expect(content).toContain(`HB_ENV_MODE="${envModeForStack(stackMode)}"`);
        expect(content).toContain(`HB_STACK_SLOT="${String(getWorktreeConfig(envRoot).slot)}"`);
      })
    );

    it.each([...STACK_MODES])(
      'runs the checkout compose project, not the one a bare checkout would default to (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        expect(scriptsText(stackMode)).toContain(
          `COMPOSE_PROJECT_NAME="${getWorktreeConfig(envRoot).projectName}"`
        );
      })
    );

    it.each([...STACK_MODES])(
      'binds its own band and no other stack band (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        const content = scriptsText(stackMode);
        const { slot } = getWorktreeConfig(envRoot);
        expect(content).toContain(
          `HB_API_PORT="${String(portsFor({ slot, mode: stackMode }).api)}"`
        );
        for (const other of otherStacks(stackMode)) {
          expect(content).not.toContain(
            `HB_API_PORT="${String(portsFor({ slot, mode: other }).api)}"`
          );
        }
      })
    );

    /**
     * The bearer token is the whole of the Redis isolation: the proxy fronts one
     * logical database per token, and every client takes its token from the
     * registry, so a stack whose files carry another stack's token is a stack
     * reading and writing another's keyspace.
     */
    it.each([...STACK_MODES])(
      'fronts a Redis pool no other stack token reaches (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        const token = resolveRaw(
          envConfig.UPSTASH_REDIS_REST_TOKEN,
          envModeForStack(stackMode)
        ) as string;
        expect(generatedText(stackMode)).toContain(`UPSTASH_REDIS_REST_TOKEN="${token}"`);
        for (const other of otherStacks(stackMode)) {
          expect(token).not.toBe(
            resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, envModeForStack(other))
          );
        }
      })
    );

    /**
     * The bucket is the whole of the object-store isolation: the registry asks
     * for the stack's own bucket and the generator answers with it, so a stack
     * whose files carry another stack's bucket reads and writes another's
     * objects. Both files that name one are checked, because the bring-up
     * creates the bucket off the scripts file and the Worker writes to the one
     * the backend file names.
     */
    it.each([...STACK_MODES])(
      'names a bucket no other stack owns (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        const bucket = mediaBucketName(stackMode);
        const paths = generatedEnvPaths(stackMode);
        for (const relative of [paths.backend, paths.scripts]) {
          expect(readFileSync(path.join(envRoot, relative), 'utf8')).toContain(
            `R2_BUCKET_MEDIA="${bucket}"`
          );
        }
        for (const other of otherStacks(stackMode)) {
          expect(bucket).not.toBe(mediaBucketName(other));
        }
      })
    );

    /**
     * Nothing imports a TypeScript module into a compose entrypoint, so the
     * bucket set the object-store setup service creates arrives as this one
     * line. It is the same list the readiness gate waits for, read back out of
     * the same generated files the bring-up loads, so a bucket added to the one
     * declaration reaches the compose rendering and the gate together.
     */
    it.each([...STACK_MODES])(
      'hands the compose file the whole bucket list the gate waits for (%s)',
      withEnvFixture((stackMode: StackMode) => {
        generateEnvFiles(envRoot, envModeForStack(stackMode));

        const loaded = Object.assign({}, ...readBack(stackMode).map((text) => dotenvParse(text)));
        const listed = (
          dotenvParse(scriptsText(stackMode))[STACK_BUCKET_LIST_VARIABLE] ?? ''
        ).split(' ');

        expect(listed).toEqual(stackBucketsFrom(loaded));
        expect(listed).toContain(mediaBucketName(stackMode));
      })
    );

    /**
     * A test that needs what a stack's files hold for a data-plane store takes
     * it from this resolution, so it cannot drift from what the files carry.
     */
    it.each([...STACK_MODES])(
      'resolves each data-plane variable to the value its files carry (%s)',
      withEnvFixture((stackMode: StackMode) => {
        const mode = envModeForStack(stackMode);
        generateEnvFiles(envRoot, mode);

        const loaded = Object.assign({}, ...readBack(stackMode).map((text) => dotenvParse(text)));
        const ports = portsFor({ slot: getWorktreeConfig(envRoot).slot, mode: stackMode });
        const noSecret = (name: string): string => {
          throw new Error(`${name} is a secret, which no data-plane variable resolves`);
        };
        for (const key of ['DATABASE_URL', 'R2_BUCKET_MEDIA'] as const) {
          expect(generatedValue(envConfig[key], mode, ports, noSecret), key).toBe(loaded[key]);
        }
      })
    );

    it('resolves no value for a variable the mode leaves unset', () => {
      const developmentOnly: VariableConfig = {
        to: [Destination.Scripts],
        [Mode.Development]: 'development-only',
      };

      expect(
        generatedValue(
          developmentOnly,
          Mode.E2E,
          portsFor({ slot: 0, mode: 'e2e' }),
          (name) => name
        )
      ).toBeNull();
    });
  });

  describe('ciE2E mode', () => {
    beforeEach(() => {
      process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test-helcim-token';
      process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test-helcim-verifier';
      process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test-vite-helcim-token';
    });

    afterEach(() => {
      delete process.env['HELCIM_API_TOKEN_SANDBOX'];
      delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
      delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
    });

    it(
      'throws if a required ciE2E secret is missing',
      withEnvFixture(() => {
        delete process.env['HELCIM_API_TOKEN_SANDBOX'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciE2E');
        }).toThrow('Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX');
      })
    );

    it(
      'throws listing all missing secrets',
      withEnvFixture(() => {
        delete process.env['HELCIM_API_TOKEN_SANDBOX'];
        delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciE2E');
        }).toThrow(
          'Missing required secrets in process.env: HELCIM_API_TOKEN_SANDBOX, HELCIM_WEBHOOK_VERIFIER_SANDBOX'
        );
      })
    );

    it(
      'does NOT require OPENROUTER_API_KEY in ciE2E (factory mocks when isE2E=true)',
      withEnvFixture(() => {
        delete process.env['OPENROUTER_API_KEY'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciE2E');
        }).not.toThrow();
      })
    );

    it(
      'with skipBackend, does not require backend secrets and writes no .dev.vars',
      withEnvFixture(() => {
        delete process.env['HELCIM_API_TOKEN_SANDBOX'];
        delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciE2E', { skipBackend: true });
        }).not.toThrow();

        expect(existsSync(path.join(envRoot, 'apps/api/.dev.vars'))).toBe(false);
      })
    );

    it(
      'with skipBackend, still writes the frontend and scripts files of its band',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, 'ciE2E', { skipBackend: true });

        const paths = generatedEnvPaths('e2e');
        const frontend = readFileSync(path.join(envRoot, paths.frontend), 'utf8');
        expect(frontend).toContain('VITE_HELCIM_JS_TOKEN');
        expect(existsSync(path.join(envRoot, paths.scripts))).toBe(true);
      })
    );

    it(
      'names the mode it generated under, not the stack that mode resolves',
      withEnvFixture(() => {
        generateEnvFiles(envRoot, 'ciE2E', { skipBackend: true });

        const scripts = readFileSync(path.join(envRoot, generatedEnvPaths('e2e').scripts), 'utf8');
        expect(scripts).toContain('HB_ENV_MODE="ciE2E"');
      })
    );

    it(
      'with skipBackend, still requires the frontend secret',
      withEnvFixture(() => {
        delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciE2E', { skipBackend: true });
        }).toThrow(/Missing required secrets/);
      })
    );
  });

  /**
   * The mode that runs no stack.
   *
   * What it must not touch is recorded rather than reasoned about — every path
   * under the fixture tree is read before and after — because the failure
   * guarded against is a generation writing production values over the ports
   * and database a developer's stack is running on.
   */
  describe('the mode with no stack', () => {
    /** What the registry's production frontend destination resolves to, keyed. */
    const productionClientValues = (): Record<string, string | null> =>
      Object.fromEntries(
        Object.entries(envConfig)
          .filter(([, config]) =>
            getDestinations(config as VariableConfig, Mode.Production).includes(
              Destination.Frontend
            )
          )
          .map(([key, config]) => [
            key,
            resolveValue(config as VariableConfig, Mode.Production, (name) => `stubbed-${name}`),
          ])
      );

    /** The registry keys that destination declares. */
    const productionClientKeys = (): string[] => Object.keys(productionClientValues());

    /** The GitHub secret names those keys resolve to, and the ones they do not. */
    const productionSecretNames = (): { client: string[]; other: string[] } => {
      const client: string[] = [];
      const other: string[] = [];
      const clientKeys = new Set(productionClientKeys());
      for (const [key, config] of Object.entries(envConfig)) {
        const raw = resolveRaw(config as VariableConfig, Mode.Production);
        if (!isSecret(raw)) continue;
        (clientKeys.has(key) ? client : other).push(raw.name);
      }
      return { client, other };
    };

    /** Every file under `root`, keyed by its path relative to it, with its bytes. */
    const treeOf = (root: string, relative = ''): Map<string, string> => {
      const entries = new Map<string, string>();
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          for (const [key, value] of treeOf(root, child)) entries.set(key, value);
        } else {
          entries.set(child, readFileSync(path.join(root, child), 'utf8'));
        }
      }
      return entries;
    };

    beforeEach(() => {
      const { client, other } = productionSecretNames();
      for (const name of client) vi.stubEnv(name, `stubbed-${name}`);
      // Emptied rather than left ambient: a runner that holds one of these
      // would let a generation demanding it pass here and fail on a machine
      // that does not.
      for (const name of other) vi.stubEnv(name, '');
    });

    /**
     * Spelled out rather than derived, because the derivation is the thing
     * under test: the file a mode's bundle resolves is the stack's whenever the
     * mode runs one, and the mode's own only where no stack answers.
     */
    it('gives every mode the frontend file its own build resolves', () => {
      const resolved = Object.fromEntries(
        Object.values(Mode).map((mode) => [mode, generatedEnvPaths(mode).frontend])
      );

      expect(resolved).toEqual({
        development: '.env.development',
        test: '.env.test',
        ciVitest: '.env.test',
        e2e: '.env.e2e',
        ciE2E: '.env.e2e',
        production: '.env.production',
      });
    });

    it(
      'writes the client values the registry declares for it',
      withEnvFixture(() => {
        const expected = productionClientValues();

        generateEnvFiles(envRoot, Mode.Production);

        const written = dotenvParse(
          readFileSync(path.join(envRoot, generatedEnvPaths(Mode.Production).frontend), 'utf8')
        );
        expect(written).toEqual(expected);
      })
    );

    it(
      'leaves every file a stack generated where it was',
      withEnvFixture(() => {
        stubStackSecrets();
        for (const stackMode of STACK_MODES) generateEnvFiles(envRoot, envModeForStack(stackMode));
        const before = treeOf(envRoot);

        generateEnvFiles(envRoot, Mode.Production);

        const after = treeOf(envRoot);
        expect([...after.keys()].filter((relative) => !before.has(relative))).toEqual([
          generatedEnvPaths(Mode.Production).frontend,
        ]);
        for (const [relative, content] of before) {
          expect({ relative, content: after.get(relative) }).toEqual({ relative, content });
        }
      })
    );

    it(
      'demands no secret outside the file it writes',
      withEnvFixture(() => {
        expect(() => generateEnvFiles(envRoot, Mode.Production)).not.toThrow();
      })
    );

    it(
      'demands every secret that file carries',
      withEnvFixture(() => {
        const { client } = productionSecretNames();
        for (const name of client) vi.stubEnv(name, '');

        expect(() => generateEnvFiles(envRoot, Mode.Production)).toThrow(
          `Missing required secrets in process.env: ${client.join(', ')}`
        );
      })
    );

    /**
     * The version is minted per deploy, so it reaches the generator the way
     * every other production value does — out of the generating step's own
     * environment. Read off the written file rather than off the registry: a
     * value the file does not carry is a value the bundle cannot bake.
     */
    it(
      'writes the version its own environment carries',
      withEnvFixture(() => {
        vi.stubEnv('VITE_APP_VERSION', '3.14.1');

        generateEnvFiles(envRoot, Mode.Production);

        const written = dotenvParse(
          readFileSync(path.join(envRoot, generatedEnvPaths(Mode.Production).frontend), 'utf8')
        );
        expect(written['VITE_APP_VERSION']).toBe('3.14.1');
      })
    );

    it(
      'refuses to write a file at all when the version is absent',
      withEnvFixture(() => {
        vi.stubEnv('VITE_APP_VERSION', '');

        expect(() => generateEnvFiles(envRoot, Mode.Production)).toThrow('VITE_APP_VERSION');
      })
    );
  });

  /**
   * Every mode but production resolves the version to the literal the registry
   * carries, so the deploy-minted input is production's alone: a machine
   * holding no version still generates all five.
   */
  describe('the modes that resolve the version without one being supplied', () => {
    const VERSIONLESS_MODES = Object.values(Mode).filter((mode) => mode !== Mode.Production);

    it.each(VERSIONLESS_MODES)(
      'generates %s',
      withEnvFixture((mode: EnvMode) => {
        stubSecretsFor(mode);
        vi.stubEnv('VITE_APP_VERSION', '');

        expect(() => generateEnvFiles(envRoot, mode)).not.toThrow();
      })
    );
  });

  /**
   * The GitHub secrets the CI vitest mode resolves, in registry order — which
   * is the order a generation collects the missing ones in. Derived, so a
   * secret added to or dropped from that mode needs no edit here.
   */
  const ciVitestSecretNames = (): string[] =>
    Object.values(envConfig).flatMap((config) => {
      const raw = resolveRaw(config as VariableConfig, Mode.CiVitest);
      return isSecret(raw) ? [raw.name] : [];
    });

  describe('the local mode of the test stack', () => {
    // A developer machine holds none of the CI vitest secrets. Emptying them
    // rather than trusting the ambient environment is what makes these cases
    // say the same thing on a runner that does hold them.
    beforeEach(() => {
      for (const name of ciVitestSecretNames()) vi.stubEnv(name, '');
    });

    it(
      "writes the test stack's three files with no secret in the environment",
      withEnvFixture(() => {
        generateEnvFiles(envRoot, Mode.Test);

        for (const relative of Object.values(generatedEnvPaths(stackModeFor(Mode.Test)))) {
          expect(existsSync(path.join(envRoot, relative))).toBe(true);
        }
      })
    );

    it(
      "names the test stack's own database and Redis pool",
      withEnvFixture(async () => {
        generateEnvFiles(envRoot, Mode.Test);

        const { parse } = await import('dotenv');
        const backend = generatedEnvPaths(stackModeFor(Mode.Test)).backend;
        const variables = parse(readFileSync(path.join(envRoot, backend), 'utf8'));

        expect(variables['DATABASE_URL']).toContain(stackDatabaseName('test'));
        expect(variables['UPSTASH_REDIS_REST_TOKEN']).toBe(
          resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, Mode.CiVitest)
        );
      })
    );

    it(
      'leaves the CI mode of the same stack refusing to generate without them',
      withEnvFixture(() => {
        expect(() => {
          generateEnvFiles(envRoot, Mode.CiVitest);
        }).toThrow(`Missing required secrets in process.env: ${ciVitestSecretNames().join(', ')}`);
      })
    );
  });

  describe('ciVitest mode', () => {
    // Seed every CI vitest secret so a missing-secret case names only the one it
    // deletes, whatever the ambient env holds (locally unset; in CI real).
    const seededSecret = (name: string): string => `test-${name}`;

    beforeEach(() => {
      for (const name of ciVitestSecretNames()) vi.stubEnv(name, seededSecret(name));
    });

    // The vitest mode writes the test stack's dev-vars, not the development
    // stack's, so the path is asked of the generator rather than spelled.
    const parseDevVariables = async (): Promise<Record<string, string>> => {
      const { parse } = await import('dotenv');
      const backend = generatedEnvPaths(stackModeFor(Mode.CiVitest)).backend;
      return parse(readFileSync(path.join(envRoot, backend), 'utf8'));
    };

    it(
      'throws when the required ciVitest secret LINEAR_API_KEY_READ is missing',
      withEnvFixture(() => {
        delete process.env['LINEAR_API_KEY_READ'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciVitest');
        }).toThrow('Missing required secrets in process.env: LINEAR_API_KEY_READ');
      })
    );

    it(
      'throws when the required ciVitest secret FCM_PROJECT_ID_CI is missing',
      withEnvFixture(() => {
        delete process.env['FCM_PROJECT_ID_CI'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciVitest');
        }).toThrow('Missing required secrets in process.env: FCM_PROJECT_ID_CI');
      })
    );

    it(
      'throws when the required ciVitest secret FCM_SERVICE_ACCOUNT_JSON_CI is missing',
      withEnvFixture(() => {
        delete process.env['FCM_SERVICE_ACCOUNT_JSON_CI'];

        expect(() => {
          generateEnvFiles(envRoot, 'ciVitest');
        }).toThrow('Missing required secrets in process.env: FCM_SERVICE_ACCOUNT_JSON_CI');
      })
    );

    // The live FCM send test reads its credential from process.env, and turbo
    // runs tests in strict env mode passing through only HB_TEST_BATCH_PORT — so the
    // generated .dev.vars is the sole route from the CI job's secrets to that
    // test process. Were this emission to break, the suite would skip and
    // `verify:evidence --require=push-fcm` would fail indistinguishably from an
    // unprovisioned secret.
    it(
      'emits FCM_PROJECT_ID_CI into the backend .dev.vars',
      withEnvFixture(async () => {
        generateEnvFiles(envRoot, 'ciVitest');

        const devVariables = await parseDevVariables();
        expect(devVariables['FCM_PROJECT_ID_CI']).toBe(seededSecret('FCM_PROJECT_ID_CI'));
      })
    );

    it(
      'emits FCM_SERVICE_ACCOUNT_JSON_CI into the backend .dev.vars',
      withEnvFixture(async () => {
        vi.stubEnv('FCM_SERVICE_ACCOUNT_JSON_CI', '{"client_email":"t","private_key":"k"}');
        generateEnvFiles(envRoot, 'ciVitest');

        const devVariables = await parseDevVariables();
        expect(devVariables['FCM_SERVICE_ACCOUNT_JSON_CI']).toBe(
          '{"client_email":"t","private_key":"k"}'
        );
      })
    );
  });

  /**
   * The modes that stand in for a stack rather than for a checkout, less the
   * one that runs no stack: the production mode writes a frontend file and
   * nothing else, so it has no scripts file for these cases to read. Derived
   * from the stack map, so a mode added there is covered without an edit.
   */
  const standInModes = (): EnvMode[] =>
    Object.values(Mode).filter((mode) => !isPerCheckoutMode(mode) && mode !== Mode.Production);

  describe('a mode standing in for a stack', () => {
    beforeEach(() => {
      for (const mode of standInModes()) stubSecretsFor(mode);
    });

    const scriptsOf = (mode: EnvMode): string =>
      readFileSync(path.join(envRoot, generatedEnvPaths(stackModeFor(mode)).scripts), 'utf8');

    const variablesOf = async (mode: EnvMode): Promise<Record<string, string>> => {
      const { parse } = await import('dotenv');
      return parse(scriptsOf(mode));
    };

    // The compose file demands a project name rather than defaulting onto
    // whatever a bare invocation picks, so a generated file carrying none
    // leaves every command that loads it unable to start the stack at all.
    it.each(standInModes())(
      'names the compose project its bring-up acts on (%s)',
      withEnvFixture((mode: EnvMode) => {
        generateEnvFiles(envRoot, mode);

        expect(scriptsOf(mode)).toContain('COMPOSE_PROJECT_NAME=');
      })
    );

    // The project and the ports have to name one stack: whichever slot the file
    // binds, the project has to be that slot's too, or a bring-up publishes one
    // slot's ports under another slot's project.
    it.each(standInModes())(
      'names the project the slot it writes resolves to (%s)',
      withEnvFixture(async (mode: EnvMode) => {
        generateEnvFiles(envRoot, mode);

        const variables = await variablesOf(mode);
        expect(variables['COMPOSE_PROJECT_NAME']).toBe(
          composeProjectName(Number(variables['HB_STACK_SLOT']))
        );
      })
    );

    // The project name a stand-in file carries is a live compose project on
    // this machine, so taking the first slot rather than the generating
    // checkout's puts a tear-down onto a neighbouring checkout's containers.
    it.each(standInModes())(
      'names the compose project of the checkout generating it (%s)',
      withEnvFixture(async (mode: EnvMode) => {
        const slot = claimSlotsAhead(envRoot);

        generateEnvFiles(envRoot, mode);

        const variables = await variablesOf(mode);
        expect(slot).not.toBe(0);
        expect(variables['COMPOSE_PROJECT_NAME']).toBe(composeProjectName(slot));
      })
    );

    // One slot decides both, so that two checkouts that would collide clash on
    // ports instead of silently sharing a compose project.
    it.each(standInModes())(
      'publishes the ports of that same slot (%s)',
      withEnvFixture(async (mode: EnvMode) => {
        const slot = claimSlotsAhead(envRoot);

        generateEnvFiles(envRoot, mode);

        const variables = await variablesOf(mode);
        const ports = portsFor({ slot, mode: stackModeFor(mode) });
        expect(Number(variables['HB_STACK_SLOT'])).toBe(slot);
        for (const service of SERVICE_KEYS) {
          expect(variables[portEnvName(service)]).toBe(String(ports[service]));
        }
      })
    );
  });

  describe('write behaviour', () => {
    const GENERATED = [
      '.env.development',
      '.env.scripts',
      'apps/api/.dev.vars',
      'apps/api/wrangler.toml',
    ] as const;

    const identity = (relative: string): { ino: bigint; mtimeNs: bigint } => {
      const stats = statSync(path.join(envRoot, relative), { bigint: true });
      return { ino: stats.ino, mtimeNs: stats.mtimeNs };
    };

    // Rewriting identical bytes does move mtime, but only by the filesystem's
    // resolution (measured ~1 ms here), so two writes in one tick share a
    // timestamp. Backdating the target first makes any write detectable by a
    // minute instead of by a tick, independently of how fast the run is.
    const backdate = (relative: string): void => {
      const aged = new Date(Date.now() - 60_000);
      utimesSync(path.join(envRoot, relative), aged, aged);
    };

    it(
      'attempts no write at all when the generated content already matches disk',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);
        for (const relative of GENERATED) backdate(relative);
        const before = GENERATED.map((relative) => identity(relative));

        // Revoking write permission on both the files and their directories makes
        // every write form fail: truncate-in-place needs the file writable, and a
        // temp-then-rename needs the directory writable.
        for (const relative of GENERATED) chmodSync(path.join(envRoot, relative), 0o444);
        chmodSync(path.join(envRoot, 'apps/api'), 0o555);
        chmodSync(envRoot, 0o555);

        expect(() => {
          generateEnvFiles(envRoot);
        }).not.toThrow();

        // Mode bits are advisory for root and on permission-ignoring mounts, which
        // makes the throw-free run fail open on its own. Inode and mtime do
        // not depend on the identity the process runs as, so they carry the claim.
        for (const [index, relative] of GENERATED.entries()) {
          expect(identity(relative)).toEqual(before[index]);
        }
      })
    );

    const makeStale = (): void => {
      for (const relative of GENERATED) {
        writeFileSync(path.join(envRoot, relative), 'stale\n');
      }
    };

    it(
      'replaces a changed file without writing through the existing one',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);
        makeStale();
        // A truncate-in-place rewrite needs the target itself writable; a rename
        // over it does not care about its mode.
        const before = GENERATED.map((relative) => identity(relative));
        for (const relative of GENERATED) chmodSync(path.join(envRoot, relative), 0o444);

        generateEnvFiles(envRoot);

        for (const [index, relative] of GENERATED.entries()) {
          expect(readFileSync(path.join(envRoot, relative), 'utf8')).not.toBe('stale\n');
          // A rename installs the temporary file's inode; truncate-in-place
          // preserves the original's, so this cannot pass without a replacement.
          expect(identity(relative).ino).not.toBe(before[index]?.ino);
        }
      })
    );

    it(
      'builds its temporary file outside the system temp directory',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);
        makeStale();
        // rename is only atomic within one filesystem, so a temp in the system
        // temp directory would forfeit the property this is buying. Pointing
        // TMPDIR at nothing makes that choice fail instead of degrading quietly.
        process.env['TMPDIR'] = path.join(envRoot, 'no-such-temp-dir');

        expect(() => {
          generateEnvFiles(envRoot);
        }).not.toThrow();
        expect(readFileSync(path.join(envRoot, '.env.development'), 'utf8')).not.toBe('stale\n');
      })
    );

    it(
      'builds its temporary file beside the target rather than in the tree root',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);
        writeFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'stale\n');
        // Only .dev.vars differs now, so the two root files are no-ops and the run's
        // single write belongs to apps/api. A temporary file built in the tree root
        // instead cannot be created there once the root is read-only, and it moves
        // the root's mtime either way — a directory's mtime tracks entry creation
        // and removal whatever identity the process runs as.
        backdate('.');
        const rootBefore = identity('.');
        chmodSync(envRoot, 0o555);

        expect(() => {
          generateEnvFiles(envRoot);
        }).not.toThrow();

        expect(readFileSync(path.join(envRoot, 'apps/api/.dev.vars'), 'utf8')).not.toBe('stale\n');
        expect(identity('.')).toEqual(rootBefore);
      })
    );

    it(
      'leaves a temporary sibling of a target alone, whoever wrote it',
      withEnvFixture(async () => {
        generateEnvFiles(envRoot);
        // A staging name is unrepeatable, so nothing here can tell a file a dead
        // run abandoned from one a run in another process-identifier space is at
        // this moment renaming into place. Removing either breaks the live one,
        // so the leftover is accepted rather than swept.
        const exited = execa('node', ['-e', '']);
        const gone = exited.pid;
        await exited;
        const leftovers = [
          path.join(envRoot, `.env.development.${String(gone)}.tmp`),
          path.join(envRoot, '.env.development.4242-6ad0f0ee-0b62-4f6c-bd0e-2f1a0d5f3f7c.tmp'),
        ];
        for (const leftover of leftovers) writeFileSync(leftover, 'left behind\n');
        makeStale();

        generateEnvFiles(envRoot);

        for (const leftover of leftovers) expect(existsSync(leftover)).toBe(true);
      })
    );

    it(
      'names the file and the writer that lost when a generated file cannot be written',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);
        makeStale();
        // A plain file where the backend directory belongs. The staged write
        // creates the directories its target needs, so this makes the write
        // impossible rather than merely refused: mode bits are advisory for
        // root and on permission-ignoring mounts, and a directory's read-only
        // bit does not stop creation on Windows at all.
        rmSync(path.join(envRoot, 'apps/api'), { recursive: true, force: true });
        writeFileSync(path.join(envRoot, 'apps/api'), 'a file where the directory would go');

        expect(() => {
          generateEnvFiles(envRoot);
        }).toThrow(StagedWriteFailed);
      })
    );

    it(
      'leaves no temporary file behind',
      withEnvFixture(() => {
        generateEnvFiles(envRoot);
        makeStale();

        generateEnvFiles(envRoot);

        expect(readdirSync(envRoot).toSorted((a, b) => a.localeCompare(b))).toEqual([
          '.env.development',
          '.env.scripts',
          '.git',
          'apps',
        ]);
        expect(
          readdirSync(path.join(envRoot, 'apps/api')).toSorted((a, b) => a.localeCompare(b))
        ).toEqual(['.dev.vars', 'wrangler.toml']);
      })
    );
  });
});

describe('updateGeneratedFiles', () => {
  let ciRoot = '';

  const withCiFixture = fixtureRunner('hushbox-generate-env-ci-', (root) => {
    ciRoot = root;
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  });

  const fixture = workflowFixture(() => ciRoot);

  const createCiYml = (content: string): void => {
    fixture.write('.github/workflows/ci.yml', content);
  };

  const readCiYml = (): string => {
    return fixture.read('.github/workflows/ci.yml');
  };

  describe('e2e-build-env section', () => {
    it(
      'emits frontend secrets only, excluding server secrets',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: e2e-build-env
old
# END GENERATED: e2e-build-env
rest`);
        updateGeneratedFiles(ciRoot);
        const content = readCiYml();
        expect(content).toContain(
          'VITE_HELCIM_JS_TOKEN_SANDBOX: ${{ secrets.VITE_HELCIM_JS_TOKEN_SANDBOX }}'
        );
        expect(content).not.toContain('HELCIM_API_TOKEN_SANDBOX:');
        expect(content).not.toContain('HELCIM_WEBHOOK_VERIFIER_SANDBOX:');
      })
    );

    it(
      'emits the NODE_ENV literal for the dev-mode e2e bundle build',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: e2e-build-env
old
# END GENERATED: e2e-build-env
rest`);
        updateGeneratedFiles(ciRoot);
        expect(readCiYml()).toContain('NODE_ENV: development');
      })
    );
  });

  /**
   * The block the production generation step reads its values through. The
   * version is the one entry no stored secret backs: it is minted by the
   * version job, so it binds that job's output where every other entry binds a
   * GitHub secret.
   */
  describe('production-env section', () => {
    const withProductionSection = (): string => {
      createCiYml(`name: CI
# BEGIN GENERATED: production-env
old
# END GENERATED: production-env
rest`);
      updateGeneratedFiles(ciRoot);
      return readCiYml();
    };

    it(
      'binds the version to the job that computes it',
      withCiFixture(() => {
        expect(withProductionSection()).toContain(
          'VITE_APP_VERSION: ${{ needs.version.outputs.version }}'
        );
      })
    );

    it(
      'never binds the version to a stored secret',
      withCiFixture(() => {
        expect(withProductionSection()).not.toContain('secrets.VITE_APP_VERSION');
      })
    );

    it(
      'binds both legal effective dates to the job that derives them',
      withCiFixture(() => {
        const content = withProductionSection();

        expect(content).toContain(
          'VITE_PRIVACY_POLICY_EFFECTIVE_DATE: ${{ needs.version.outputs.privacy_policy_effective_date }}'
        );
        expect(content).toContain(
          'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE: ${{ needs.version.outputs.terms_of_service_effective_date }}'
        );
      })
    );

    it(
      'binds every other production client secret to the secret holding it',
      withCiFixture(() => {
        const content = withProductionSection();

        expect(content).toContain('VITE_VAPID_PUBLIC_KEY: ${{ secrets.VITE_VAPID_PUBLIC_KEY }}');
        expect(content).toContain(
          'VITE_HELCIM_JS_TOKEN_PRODUCTION: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
        );
      })
    );

    it(
      'emits no backend secret, which the step it feeds never writes',
      withCiFixture(() => {
        expect(withProductionSection()).not.toContain('RESEND_API_KEY');
      })
    );
  });

  describe('e2e-env section', () => {
    it(
      'generates env block using secret names for e2e secrets',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
rest of file`);

        updateGeneratedFiles(ciRoot);

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
        // RESEND and OPENROUTER should NOT be present in e2e-env (not in e2e)
        expect(content).not.toContain('RESEND_API_KEY');
        expect(content).not.toContain('OPENROUTER_API_KEY');
      })
    );

    it(
      'preserves content outside markers',
      withCiFixture(() => {
        createCiYml(`name: CI
before
# BEGIN GENERATED: e2e-env
old content
# END GENERATED: e2e-env
after`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('name: CI');
        expect(content).toContain('before');
        expect(content).toContain('after');
      })
    );
  });

  describe('build-env section', () => {
    it(
      'generates frontend production values',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('VITE_API_URL: https://api.hushbox.ai');
      })
    );

    it(
      'uses production secret names for frontend secrets',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain(
          'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
        );
      })
    );

    it(
      'overrides VITE_APP_VERSION with version job output',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('VITE_APP_VERSION: ${{ needs.version.outputs.version }}');
      })
    );

    it(
      'does not use VITE_APP_VERSION secret in build-env',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).not.toContain('secrets.VITE_APP_VERSION');
      })
    );

    it(
      'binds both legal effective dates to the job that derives them',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain(
          'VITE_PRIVACY_POLICY_EFFECTIVE_DATE: ${{ needs.version.outputs.privacy_policy_effective_date }}'
        );
        expect(content).toContain(
          'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE: ${{ needs.version.outputs.terms_of_service_effective_date }}'
        );
      })
    );

    it(
      'binds no legal effective date to a stored secret, which none of them has',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).not.toContain('secrets.VITE_PRIVACY_POLICY_EFFECTIVE_DATE');
        expect(content).not.toContain('secrets.VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE');
      })
    );

    it(
      'emits ESM_CDN_URL for the sandbox origin build',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env
old content
# END GENERATED: build-env`);

        updateGeneratedFiles(ciRoot);

        expect(readCiYml()).toMatch(/^\s*ESM_CDN_URL: https:\/\/esm\.sh$/m);
      })
    );
  });

  describe('headers-env section', () => {
    it(
      'emits only VITE_API_URL for the CSP headers step',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: headers-env
old content
# END GENERATED: headers-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('VITE_API_URL: https://api.hushbox.ai');
      })
    );

    it(
      'does not leak build secrets into the headers step',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: headers-env
old content
# END GENERATED: headers-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).not.toContain('VITE_HELCIM_JS_TOKEN');
        expect(content).not.toContain('VITE_APP_VERSION');
      })
    );

    it(
      'emits SANDBOX_ORIGIN_URL for the CSP frame-src directive',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: headers-env
old content
# END GENERATED: headers-env`);

        updateGeneratedFiles(ciRoot);

        expect(readCiYml()).toMatch(/^\s*SANDBOX_ORIGIN_URL: https:\/\/sandbox\.hushbox\.ai$/m);
      })
    );
  });

  describe('build-env-mobile section', () => {
    it(
      'emits the full frontend production set',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env-mobile
old content
# END GENERATED: build-env-mobile`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('VITE_API_URL: https://api.hushbox.ai');
        expect(content).toContain(
          'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
        );
        expect(content).toContain('VITE_WEB_URL: https://hushbox.ai');
      })
    );

    it(
      'overrides VITE_APP_VERSION with the version job output',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env-mobile
old content
# END GENERATED: build-env-mobile`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('VITE_APP_VERSION: ${{ needs.version.outputs.version }}');
      })
    );

    it(
      'omits ESM_CDN_URL from the web-only bundle build',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: build-env-mobile
old content
# END GENERATED: build-env-mobile`);

        updateGeneratedFiles(ciRoot);

        expect(readCiYml()).not.toContain('ESM_CDN_URL');
      })
    );
  });

  describe('deploy-secrets section', () => {
    /**
     * The whole block: the encoder, run from the workspace root, its output
     * captured before wrangler starts and then piped into the API deploy.
     */
    const PUBLISH_COMMAND = [
      'secrets_json="$(pnpm -w exec tsx scripts/encode-deploy-secrets.ts)"',
      String.raw`printf '%s\n' "$secrets_json" | pnpm exec wrangler deploy --secrets-file /dev/stdin --tag "v$VERSION" --message "$GITHUB_SHA"`,
    ].join('\n');

    it(
      "captures the encoder's output, then pipes it into the API deploy",
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

        updateGeneratedFiles(ciRoot);

        expect(readCiYml()).toContain(PUBLISH_COMMAND);
      })
    );

    // One upload is what keeps coupled halves — a keypair, a URL and its
    // token, the version and its checksums — from straddling two Worker
    // versions, and the code from going live apart from what it serves.
    it('publishes the whole set in the code upload and through no secret command', () => {
      const commands = workflowSections()['deploy-secrets']?.content ?? '';

      expect(commands.split('--secrets-file /dev/stdin').length - 1).toBe(1);
      expect(commands).not.toContain('wrangler secret');
      expect(commands).not.toContain('wrangler versions');
      expect(commands.trimEnd()).toBe(PUBLISH_COMMAND);
    });

    it(
      'never substitutes a secret expression into the command',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

        updateGeneratedFiles(ciRoot);

        expect(readCiYml()).not.toContain('${{');
      })
    );

    // The encoder reads its keys from the same list; a key on one side only
    // would refuse the batch (missing from the env block) or never publish
    // (missing from the list).
    it('binds every key the encoder reads to a value in the env section', () => {
      const bindings = workflowSections()['deploy-secrets-env']?.content ?? '';

      const read = deploySecretKeys();
      const bound = [...bindings.matchAll(/^(\w+):/gm)].map((match) => match[1]);

      expect(read.length).toBeGreaterThan(0);
      expect(read).toEqual(bound);
    });

    it(
      'takes APP_VERSION from the version job output rather than a secret',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets-env
old content
# END GENERATED: deploy-secrets-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('APP_VERSION: ${{ needs.version.outputs.version }}');
        expect(content).not.toContain('secrets.APP_VERSION');
      })
    );

    // The OTA upload step records each bundle's sha256 as a step output named
    // as the Worker key, so the checksums ride the same publish as APP_VERSION
    // instead of a GitHub secret nobody holds.
    it(
      'binds each OTA checksum to the upload step output named as its Worker key',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets-env
old content
# END GENERATED: deploy-secrets-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        for (const key of OTA_CHECKSUM_KEYS) {
          expect(content).toContain(`${key}: \${{ steps.ota.outputs.${key} }}`);
        }
        expect(content).not.toContain('secrets.APP_BUNDLE_CHECKSUM');
      })
    );

    it(
      'uses production secret names for Helcim deploy secrets',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets-env
old content
# END GENERATED: deploy-secrets-env`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('HELCIM_API_TOKEN: ${{ secrets.HELCIM_API_TOKEN_PRODUCTION }}');
        expect(content).toContain(
          'HELCIM_WEBHOOK_VERIFIER: ${{ secrets.HELCIM_WEBHOOK_VERIFIER_PRODUCTION }}'
        );
      })
    );

    // The corruption this shape exists to prevent: a Google service-account JSON
    // is full of double quotes and carries `\n` escapes inside the PEM body, and
    // an expression pasted into the command loses both to bash's own parsing
    // before the command runs. The command names no secret at all — not as an
    // expression, not as a `"$KEY"` word — so no value is parsed as shell text;
    // the encoder reads them from its environment. Its output is expanded once,
    // inside double quotes, as the argument of the `printf` builtin, which bash
    // runs in its own process, so no command line carries it either. The other
    // parameters are the release version and the commit, which annotate the
    // deployed version and are no secret.
    it('names no secret in the command, so no value is parsed as shell text', () => {
      const commands = (workflowSections()['deploy-secrets']?.content ?? '').trimEnd();

      expect(commands.split('\n')).toHaveLength(2);
      expect([...commands.matchAll(/\$\{?(\w+)/g)].map((match) => match[1])).toEqual([
        'secrets_json',
        'VERSION',
        'GITHUB_SHA',
      ]);
      expect(commands).toContain(String.raw`printf '%s\n' "$secrets_json" |`);
      for (const key of deploySecretKeys()) expect(commands).not.toContain(key);
    });

    // A coupling declared over a key the deploy never publishes is one the
    // batch cannot honour. Only members the Worker holds are judged: the
    // frontend VAPID copy, the Ops-lane pairs and the CI-only pairs never
    // traverse this publish.
    it('publishes every coupled member the Worker holds in the one batch', () => {
      const published = new Set(deploySecretKeys());
      const workerHeld = (name: string): boolean => {
        const config = (envConfig as Record<string, VariableConfig>)[name];
        return (
          config !== undefined &&
          getDestinations(config, Mode.Production).includes(Destination.Backend)
        );
      };
      const members = [
        ...new Set(
          [
            ...Object.values(envConfig).map((config) => (config as VariableConfig).credential),
            ...Object.values(CI_SECRETS),
          ].flatMap((credential) => credential?.coupledWith ?? [])
        ),
      ].filter((name) => workerHeld(name));

      expect(members).toEqual(
        expect.arrayContaining(['VAPID_PRIVATE_KEY', 'APP_VERSION', 'APP_BUNDLE_CHECKSUM_IOS'])
      );
      expect(members.filter((name) => !published.has(name))).toEqual([]);
    });

    it(
      'never deploys the Ops-lane R2 admin credentials to the runtime Worker',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-secrets
old content
# END GENERATED: deploy-secrets`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        // Destination.Ops creds must stay off the Worker — never in the batch.
        expect(content).not.toContain('R2_ADMIN_ACCESS_KEY_ID');
        expect(content).not.toContain('R2_ADMIN_SECRET_ACCESS_KEY');
      })
    );
  });

  describe('decode-google-services section', () => {
    it(
      'generates base64 decode command with production secret reference',
      withCiFixture(() => {
        fixture.write(
          '.github/workflows/build-android.yml',
          `name: Android
# BEGIN GENERATED: decode-google-services
old content
# END GENERATED: decode-google-services`
        );

        updateGeneratedFiles(ciRoot);

        const content = fixture.read('.github/workflows/build-android.yml');
        expect(content).toContain(
          'run: echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 -d > apps/web/android/app/google-services.json'
        );
        expect(content).toContain('env:');
        expect(content).toContain(
          'GOOGLE_SERVICES_JSON_BASE64: ${{ secrets.GOOGLE_SERVICES_JSON_BASE64 }}'
        );
      })
    );
  });

  describe('verify-secrets section', () => {
    /**
     * The Worker's secrets in registry order, which is the order the loop names
     * them in. Derived, so a secret added to or dropped from the Worker needs no
     * edit here.
     */
    const workerSecretNames = (): string[] =>
      Object.entries(envConfig).flatMap(([key, config]) => {
        const variable = config as VariableConfig;
        const held = getDestinations(variable, Mode.Production).includes(Destination.Backend);
        return held && isSecret(resolveRaw(variable, Mode.Production)) ? [key] : [];
      });

    it(
      'generates for loop with all backend secret keys',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: verify-secrets
old content
# END GENERATED: verify-secrets`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(workerSecretNames()).toContain('DATABASE_URL');
        expect(content).toContain(`for secret in ${workerSecretNames().join(' ')}; do`);
        // The Ops-lane admin creds are not Worker secrets, so they are not verified here.
        expect(content).not.toContain('R2_ADMIN_ACCESS_KEY_ID');
      })
    );

    // Minted by the OTA upload step rather than read from a GitHub secret, but
    // published through the same batch as every other Worker secret — and the
    // mobile update endpoint reads all three, so the deploy confirms they landed.
    it(
      'expects the per-platform bundle checksums the OTA step computes',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: verify-secrets
old content
# END GENERATED: verify-secrets`);

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).toContain('APP_BUNDLE_CHECKSUM_IOS');
        expect(content).toContain('APP_BUNDLE_CHECKSUM_ANDROID');
        expect(content).toContain('APP_BUNDLE_CHECKSUM_ANDROID_DIRECT');
      })
    );
  });

  describe('ops-env section', () => {
    const content = (): string => workflowSections()['ops-env']?.content ?? '';

    // Which entries a deploy carries is chosen at run time, from PR labels, so
    // the block binds what any entry a label can name could need. A
    // `dispatch_only` entry mints no label and the resolver refuses one.
    it('binds every variable a deployable manifest entry requires, and nothing else', () => {
      const required = new Set(
        loadManifest(REPO_ROOT)
          .scripts.filter((script) => script.dispatch_only !== true)
          .flatMap((script) => script.requires_secrets)
      );

      expect(boundNames(content()).toSorted(byName)).toEqual([...required].toSorted(byName));
    });

    it('binds a required secret under its stored name and a required literal as its value', () => {
      expect(content()).toContain(
        'R2_ADMIN_ACCESS_KEY_ID: ${{ secrets.R2_ADMIN_ACCESS_KEY_ID }}\n'
      );
      expect(content()).toContain('R2_BUCKET_MEDIA: hushbox-media\n');
    });

    // Each copy sits inside a step's own `env:`, beside that step's own entries,
    // so a header of its own would open a second map.
    it('renders bare mapping entries, with no env header', () => {
      expect(content()).not.toMatch(/^\s*env:/m);
    });

    it('binds a variable two entries require once', () => {
      const bindings = generateOpsEnv({
        scripts: [
          opsScript('first', ['DATABASE_URL', 'OPAQUE_KEK']),
          opsScript('second', ['DATABASE_URL']),
        ],
      });

      expect(boundNames(bindings)).toEqual(['DATABASE_URL', 'OPAQUE_KEK']);
    });

    it('keys an aliased secret by its canonical name and reads the stored one', () => {
      const bindings = generateOpsEnv({ scripts: [opsScript('aliased', ['OPENROUTER_API_KEY'])] });

      expect(bindings).toBe('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY_PRODUCTION }}\n');
    });

    it('binds no variable outside the Backend and Ops lanes', () => {
      const bindings = generateOpsEnv({
        scripts: [opsScript('frontend', ['VITE_HELCIM_JS_TOKEN'])],
      });

      expect(bindings).toBe('\n');
    });

    // The version and the checksums are minted by the deploy run's own jobs and
    // steps, which the manual runner has none of; a requirement naming one is
    // left unbound, and the runner's bindings test names it.
    it('binds none of the values a deploy run mints', () => {
      const bindings = generateOpsEnv({
        scripts: [opsScript('minted', ['APP_VERSION', ...OTA_CHECKSUM_KEYS])],
      });

      expect(bindings).toBe('\n');
    });
  });

  describe('deploy-verify-env section', () => {
    it(
      'binds the production API_URL and nothing else',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-verify-env
old content
# END GENERATED: deploy-verify-env`);

        updateGeneratedFiles(ciRoot);

        const body = readCiYml()
          .split('# BEGIN GENERATED: deploy-verify-env\n')[1]
          ?.split('# END GENERATED: deploy-verify-env')[0];
        const origin = resolveValue(envConfig.API_URL, Mode.Production, (name) => name);
        expect(body).toBe(`API_URL: ${String(origin)}\n`);
      })
    );
  });

  describe('deploy-surfaces-env section', () => {
    it(
      'binds the production origin of every surface the deploy probes, and nothing else',
      withCiFixture(() => {
        createCiYml(`name: CI
# BEGIN GENERATED: deploy-surfaces-env
old content
# END GENERATED: deploy-surfaces-env`);

        updateGeneratedFiles(ciRoot);

        const body = readCiYml()
          .split('# BEGIN GENERATED: deploy-surfaces-env\n')[1]
          ?.split('# END GENERATED: deploy-surfaces-env')[0];
        const entries = SURFACE_ORIGINS.map(
          (key) =>
            `${key}: ${String(resolveValue(envConfig[key], Mode.Production, (name) => name))}`
        );
        expect(body).toBe(`${entries.join('\n')}\n`);
      })
    );
  });

  describe('ops-dispatch-env section', () => {
    // The manual runner is the one path a `dispatch_only` entry has, and which
    // entry it runs is chosen at run time, from a dropdown.
    it('binds every variable any manifest entry requires, and nothing else', () => {
      const required = new Set(
        loadManifest(REPO_ROOT).scripts.flatMap((script) => script.requires_secrets)
      );
      const content = workflowSections()['ops-dispatch-env']?.content ?? '';

      expect(boundNames(content).toSorted(byName)).toEqual([...required].toSorted(byName));
    });
  });

  describe('ops-dispatch-run-env section', () => {
    // An ops script that classifies its environment through createEnvUtilities
    // refuses to run without NODE_ENV.
    it('binds the production NODE_ENV and nothing else', () => {
      const value = resolveValue(envConfig.NODE_ENV, Mode.Production, (name) => name);

      expect(workflowSections()['ops-dispatch-run-env']?.content).toBe(
        `NODE_ENV: ${String(value)}\n`
      );
    });
  });

  describe('multiple sections', () => {
    it(
      'updates all sections in a single call',
      withCiFixture(() => {
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

        updateGeneratedFiles(ciRoot);

        const content = readCiYml();
        expect(content).not.toContain('old e2e');
        expect(content).not.toContain('old build');
        expect(content).not.toContain('old deploy');
        expect(content).not.toContain('old verify');
        // e2e-env has Helcim secrets (not RESEND - production only)
        expect(content).toContain('HELCIM_API_TOKEN_SANDBOX:');
        expect(content).toContain('VITE_API_URL:');
        expect(content).toContain(
          '"$secrets_json" | pnpm exec wrangler deploy --secrets-file /dev/stdin'
        );
        expect(content).toContain('for secret in');
      })
    );
  });
});

const byName = (a: string, b: string): number => a.localeCompare(b);

/** The variable names a block of bare mapping entries binds, in order. */
function boundNames(bindings: string): string[] {
  return bindings
    .trimEnd()
    .split('\n')
    .map((line) => line.slice(0, line.indexOf(':')));
}

/** One manifest entry requiring the named variables. */
function opsScript(name: string, requires: readonly string[]): OpsScript {
  return {
    name,
    file: `ops/${name}.ts`,
    phase: 'pre-deploy',
    description: name,
    requires_secrets: requires,
  };
}

describe('the manual ops runner', () => {
  interface RunnerStep {
    readonly run?: string;
    readonly env?: Record<string, unknown>;
  }

  const runnerJob = (): { env?: unknown; steps: readonly RunnerStep[] } => {
    const workflow = parseYaml(
      readFileSync(path.join(REPO_ROOT, '.github/workflows/run-ops-script.yml'), 'utf8')
    ) as { jobs: { run: { env?: unknown; steps: readonly RunnerStep[] } } };
    return workflow.jobs.run;
  };

  const opsSteps = (): readonly RunnerStep[] =>
    runnerJob().steps.filter((step) => step.run?.startsWith('pnpm tsx') === true);

  const required = (): string[] =>
    loadManifest(REPO_ROOT).scripts.flatMap((script) => script.requires_secrets);

  /** Every stored secret a text references, by its stored name. */
  const storedSecrets = (text: string): string[] =>
    [...text.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].flatMap(([, name]) => name ?? []);

  // A job-level binding reaches every tool the job runs, the checkout and the
  // dependency install included, though only the ops steps read one.
  it('binds nothing at job level', () => {
    expect(runnerJob().env).toBeUndefined();
  });

  it('binds every variable a manifest entry requires on each ops step', () => {
    const steps = opsSteps();
    expect(steps.length).toBeGreaterThan(0);

    for (const step of steps) {
      expect(Object.keys(step.env ?? {})).toEqual(expect.arrayContaining(required()));
    }
  });

  it('binds no stored secret outside what a manifest entry requires', () => {
    const allowed = new Set(storedSecrets(workflowSections()['ops-dispatch-env']?.content ?? ''));

    for (const step of runnerJob().steps) {
      const extra = storedSecrets(JSON.stringify(step.env ?? {})).filter(
        (name) => !allowed.has(name)
      );
      expect(extra).toEqual([]);
    }
  });

  it('binds NODE_ENV on the step that runs the selected script', () => {
    const run = opsSteps().find((step) => step.run?.includes('OPS_SCRIPT_FILE') === true);

    expect(run?.env).toHaveProperty('NODE_ENV', 'production');
  });
});

describe('replaceSection', () => {
  // `build-env` is a prefix of `build-env-mobile`, and both render into ci.yml.
  const halfDeleted = `name: CI
# BEGIN GENERATED: build-env
first
# BEGIN GENERATED: build-env-mobile
second
# END GENERATED: build-env-mobile
`;

  it('matches nothing when a section lost its END marker', () => {
    expect(replaceSection(halfDeleted, 'build-env', 'new\n')).toBe(halfDeleted);
  });

  it('leaves the following section intact when a section lost its END marker', () => {
    expect(replaceSection(halfDeleted, 'build-env', 'new\n')).toContain(
      '# BEGIN GENERATED: build-env-mobile'
    );
  });

  // A Markdown file cannot carry a `#` marker: that is a heading there. Its
  // markers are HTML comments, and the rewrite keeps the form it found.
  it('rewrites a section whose markers are HTML comments, keeping that form', () => {
    const rewritten = replaceSection(EMPTY_INVENTORY_DOC, 'secrets-inventory', 'new\n');

    expect(rewritten).toBe(`# Secrets

<!-- BEGIN GENERATED: secrets-inventory -->
new
<!-- END GENERATED: secrets-inventory -->
`);
  });
});

describe('the secrets inventory', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const columns = [
    'Name',
    'Family',
    'Store',
    'Description',
    'Replace',
    'On loss',
    'Escrowed',
    'User-visible',
    'Coupled with',
    'Leak impact',
  ];

  /** The table's lines as trimmed cells; an escaped pipe stays inside its cell. */
  const cellsOf = (block: string): string[][] =>
    block
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .split(/(?<!\\)\|/)
          .slice(1, -1)
          .map((cell) => cell.trim())
      );

  const alone: Credential = {
    description: 'Signs the thing | twice.',
    store: 'github:ci',
    replace: 'transparent',
    onLoss: 'reissueAtVendor',
    family: 'random-secret',
    userVisible: 'none',
    leakImpact: 'nuisance',
  };
  const coupled: Credential = { ...alone, coupledWith: ['B_KEY', 'C_KEY'] };

  it('declares the inventory section into the secrets document alone', () => {
    expect(workflowSections()['secrets-inventory']?.owners).toEqual([SECRETS_DOC]);
  });

  it('heads the table with one column per declared field', () => {
    const [header, rule] = cellsOf(generateSecretsInventory());

    expect(header).toEqual(columns);
    expect(rule?.every((cell) => /^-+$/.test(cell))).toBe(true);
  });

  it('lists every declaration once', () => {
    const names = cellsOf(generateSecretsInventory())
      .slice(2)
      .map(([name = '']) => name.replaceAll('`', ''));
    const expected = declaredCredentials().map(([name]) => name);

    expect(new Set(expected).size).toBe(expected.length);
    expect(names).toHaveLength(expected.length);
    expect(new Set(names)).toEqual(new Set(expected));
  });

  // Code-unit order, not collation: `ANDROID_KEYSTORE_BASE64` precedes
  // `ANDROID_KEY_PASSWORD`, where `localeCompare` would put them the other way.
  it('orders the rows by name', () => {
    const names = cellsOf(generateSecretsInventory())
      .slice(2)
      .map(([name = '']) => name.replaceAll('`', ''));

    const disordered = names.filter((name, index) => index > 0 && name <= (names[index - 1] ?? ''));
    expect(disordered).toEqual([]);
  });

  it('links each row to a runbook that exists beside the document', () => {
    const links = cellsOf(generateSecretsInventory())
      .slice(2)
      .map((row) => /^\[[^\]]+\]\(([^)]+)\)$/.exec(row[1] ?? '')?.[1]);

    expect(links).not.toContain(undefined);
    const missing = links.filter(
      (link) => !existsSync(path.resolve(repoRoot, path.dirname(SECRETS_DOC), link ?? ''))
    );
    expect(missing).toEqual([]);
  });

  it('renders each declared field in its column', () => {
    const row = cellsOf(generateSecretsInventory([['A_KEY', coupled]]))[2];

    expect(row).toEqual([
      '`A_KEY`',
      '[random-secret](runbooks/secrets/random-secret.md)',
      'github:ci',
      String.raw`Signs the thing \| twice.`,
      'transparent',
      'reissueAtVendor',
      '',
      'none',
      '`B_KEY`, `C_KEY`',
      'nuisance',
    ]);
  });

  it('leaves the coupling column empty for a declaration coupled with nothing', () => {
    const row = cellsOf(generateSecretsInventory([['A_KEY', alone]]))[2];

    expect(row?.[8]).toBe('');
  });

  it('marks a declaration the escrow captures', () => {
    const escrowed: Credential = { ...alone, onLoss: 'restoreFromCopy' };
    const row = cellsOf(generateSecretsInventory([['A_KEY', escrowed]]))[2];

    expect(row?.[6]).toBe('yes');
  });

  it('leaves the escrow column empty for a declaration of another loss class', () => {
    const row = cellsOf(generateSecretsInventory([['A_KEY', alone]]))[2];

    expect(row?.[6]).toBe('');
  });

  // Prettier pads every cell to its column and puts a blank line between a
  // table and the comment beside it; a block it would rewrite is drift on the
  // first `pnpm format`.
  it('is already in the shape Prettier prints', async () => {
    const document = replaceSection(
      EMPTY_INVENTORY_DOC,
      'secrets-inventory',
      generateSecretsInventory()
    );

    // `--silent`: pnpm writes its unsupported-engine warning to stdout, not stderr, so
    // without it that warning prepends a line to what this byte comparison captures.
    const { stdout } = await execa(
      'pnpm',
      ['--silent', 'exec', 'prettier', '--stdin-filepath', SECRETS_DOC],
      {
        cwd: repoRoot,
        input: document,
      }
    );

    expect(`${stdout}\n`).toBe(document);
  });
});

describe('the escrow set', () => {
  it('names every declaration whose loss class is restore-from-copy', () => {
    const expected = declaredCredentials()
      .filter(([, credential]) => credential.onLoss === 'restoreFromCopy')
      .map(([name]) => name);

    expect(new Set(escrowedSecretKeys())).toEqual(new Set(expected));
  });

  it('names no declaration of another loss class', () => {
    const other = new Set(
      declaredCredentials()
        .filter(([, credential]) => credential.onLoss !== 'restoreFromCopy')
        .map(([name]) => name)
    );

    expect(escrowedSecretKeys().filter((key) => other.has(key))).toEqual([]);
  });

  it('orders the keys by name', () => {
    const keys = escrowedSecretKeys();

    expect(keys.filter((key, index) => index > 0 && key <= (keys[index - 1] ?? ''))).toEqual([]);
  });
});

describe('the escrow job a declaration is captured by', () => {
  it('gives a repository-scoped declaration to the production job', () => {
    expect(escrowEnvironmentOf('A_KEY', 'github:repository')).toBe('production');
  });

  it('refuses a store no GitHub secret backs', () => {
    expect(() => escrowEnvironmentOf('A_KEY', 'worker-only')).toThrow(/no GitHub secret holds it/u);
  });
});

/** Code-unit order, matching the order the generator itself renders in. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/** One `KEY: value` mapping block, read back as the map it renders. */
function bindingsOf(marker: string): Map<string, string> {
  return new Map(
    (workflowSections()[marker]?.content ?? '')
      .split('\n')
      .filter((line) => line.includes(': '))
      .map((line) => {
        const [key = '', ...rest] = line.trim().split(': ');
        return [key, rest.join(': ')];
      })
  );
}

/**
 * The store of the GitHub secret a binding names — read off the right-hand
 * side, never off the variable it is bound to. A binding carrying the wrong
 * environment's secret is the whole drift class here, and it names the
 * variable correctly while doing it.
 */
function storeOfBoundSecret(bound: string): string | undefined {
  const name = /^\$\{\{ secrets\.(\w+) \}\}$/u.exec(bound)?.[1];
  if (name === undefined) return undefined;
  const declared = Object.values(envConfig).find((config) => {
    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    return isSecret(raw) && raw.name === name;
  }) as VariableConfig | undefined;
  return declared?.credential?.store ?? CI_SECRETS[name]?.store;
}

describe('the backup workflow env section', () => {
  const BACKUP_WORKFLOW = '.github/workflows/backup.yml';

  it('declares the section into the backup workflow alone', () => {
    expect(workflowSections()['backup-env']?.owners).toEqual([BACKUP_WORKFLOW]);
  });

  it('binds every variable the backup run reads and nothing else', () => {
    expect([...bindingsOf('backup-env').keys()].toSorted(byCodeUnit)).toEqual(
      Object.values(BACKUP_VARIABLES).toSorted(byCodeUnit)
    );
  });

  it('binds each variable to its own production value', () => {
    const wrong = [...bindingsOf('backup-env')].filter(([key, bound]) => {
      const config = (envConfig as Record<string, VariableConfig>)[key];
      const raw = config === undefined ? undefined : resolveRaw(config, Mode.Production);
      return bound !== (isSecret(raw) ? `\${{ secrets.${raw.name} }}` : raw);
    });

    expect(wrong).toEqual([]);
  });

  // The whole point of putting this file under generation: the workflow runs on
  // the `backup` environment, where a `production` secret resolves to the empty
  // string with nothing to say so. A binding the environment cannot read is the
  // drift class the old hand-written file carried undetected.
  it('binds no secret the backup environment cannot read', () => {
    const unreadable = [...bindingsOf('backup-env')]
      .filter(([, bound]) => bound.includes('secrets.'))
      .filter(([, bound]) => {
        const store = storeOfBoundSecret(bound);
        return store !== 'github:backup' && store !== 'github:repository';
      })
      .map(([key]) => key);

    expect(unreadable).toEqual([]);
  });

  it('binds a declared secret wherever it binds one at all', () => {
    const undeclared = [...bindingsOf('backup-env')]
      .filter(([, bound]) => bound.includes('secrets.') && storeOfBoundSecret(bound) === undefined)
      .map(([key]) => key);

    expect(undeclared).toEqual([]);
  });

  it('binds a secret for every backup-stored credential the run reads', () => {
    const bound = bindingsOf('backup-env');
    const missing = Object.values(BACKUP_VARIABLES).filter((key) => {
      const config = (envConfig as Record<string, VariableConfig>)[key];
      return config?.credential?.store === 'github:backup' && !bound.get(key)?.includes('secrets.');
    });

    expect(missing).toEqual([]);
  });
});

/**
 * What a workflow's `run:` bodies actually execute, with every root package
 * script they name replaced by its definition. A step written `pnpm <script>`
 * runs whatever the manifest defines today, so the wrappers a line reaches are
 * a property of the manifest rather than of the line.
 */
function expandRootScripts(command: string): string {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  let expanded = command;
  for (let depth = 0; depth < 8; depth += 1) {
    const next = expanded.replaceAll(
      /(?<![\w-])pnpm\s+(?:-w\s+)?(?:exec\s+)?([\w:-]+)/gu,
      (whole: string, name: string) => manifest.scripts[name] ?? whole
    );
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

/** Every `run:` body one workflow file holds, in job and step order. */
function runBodiesOf(file: string): string[] {
  const workflow = parseYaml(readFileSync(file, 'utf8')) as {
    jobs?: Record<string, { steps?: { run?: unknown }[] }>;
  };
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => typeof run === 'string')
  );
}

// eslint-disable-next-line comments/resolvable-cross-reference -- the cited file is generated at the repository root and git-ignored, so git tracks nothing there although the citation is correct
/** The wrappers that read a `.env` file before handing off. `.env.scripts` is
 * git-ignored, so on a runner it does not exist, and the run-claim registration
 * inside the loader fails on the stack slot that file carries — before the
 * script it wraps starts at all. A developer's invocation is wrapped and a
 * runner's is not, which is why the workflow names the entry point itself.
 */
const ENV_LOADING_WRAPPERS = ['scripts/with-env.ts', 'scripts/with-run-claim.ts'];

describe('the backup workflow invocation', () => {
  const BACKUP_WORKFLOW = path.join(GITHUB_DIR, 'workflows/backup.yml');

  it('runs the backup entry point and nothing else', () => {
    const bodies = runBodiesOf(BACKUP_WORKFLOW);

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((body) => !body.includes('scripts/backup.ts'))).toEqual([]);
  });

  // The job's own environment block is the whole configuration source, and a
  // wrapper would both fail for want of a file no runner has and, once made to
  // load one, replace those bindings with a local stack's values.
  it('reaches no wrapper that loads an environment file', () => {
    const wrapped = runBodiesOf(BACKUP_WORKFLOW)
      .map((body) => expandRootScripts(body))
      .filter((command) => ENV_LOADING_WRAPPERS.some((wrapper) => command.includes(wrapper)));

    expect(wrapped).toEqual([]);
  });

  // A binding written by hand outside the generated span is a binding no gate
  // can see: the generator neither writes nor diffs it, and a step-level `env:`
  // silently overrides the job-level block for that step. That is the drift
  // class this file was put under generation to close, wearing a new location.
  it('names a secret nowhere but inside its generated block', () => {
    const text = readFileSync(BACKUP_WORKFLOW, 'utf8');
    const generated = generatedBlocks(text).map((block) => ({
      first: block.line + 1,
      last: block.line + block.body.length,
    }));
    const outside = text
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes('secrets.'))
      .filter(
        ({ number }) => !generated.some((span) => number >= span.first && number <= span.last)
      )
      .map(({ number, line }) => `${String(number)} ${line.trim()}`);

    expect(generated.length).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });
});

/**
 * One start of the backup workflow, in the two facts its step guards read.
 * GitHub hands a scheduled run no `inputs` context at all, so a dispatch input
 * reads as falsy under a schedule whatever default it declares — which is the
 * whole reason provisioning can be offered as an input and still be out of the
 * schedule's reach.
 */
interface BackupTrigger {
  readonly eventName: string;
  readonly inputs: Readonly<Record<string, boolean>>;
}

/** The boolean dispatch inputs the workflow declares, in declaration order. */
function dispatchInputs(file: string): string[] {
  const workflow = parseYaml(readFileSync(file, 'utf8')) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, { type?: unknown }> } };
  };
  const declared = Object.entries(workflow.on?.workflow_dispatch?.inputs ?? {});
  const unreadable = declared.filter(([, input]) => input.type !== 'boolean');
  if (unreadable.length > 0) {
    throw new Error(
      `the backup workflow declares a non-boolean dispatch input (${unreadable
        .map(([name]) => name)
        .join(', ')}), which this reader cannot sweep`
    );
  }
  return declared.map(([name]) => name);
}

/**
 * Every trigger the workflow can start under: the schedule, which carries no
 * inputs, and one dispatch per combination of the inputs it declares. The
 * dispatch space is derived from the declarations rather than listed, so a
 * second input widens the sweep instead of silently leaving half of it unswept.
 */
function backupTriggers(file: string): BackupTrigger[] {
  const names = dispatchInputs(file);
  const dispatches = Array.from({ length: 2 ** names.length }, (_unused, mask) => ({
    eventName: 'workflow_dispatch',
    inputs: Object.fromEntries(names.map((name, bit) => [name, (mask & (1 << bit)) !== 0])),
  }));
  return [
    { eventName: 'schedule', inputs: Object.fromEntries(names.map((name) => [name, false])) },
    ...dispatches,
  ];
}

/**
 * Whether a step's guard admits one trigger. The grammar is the conjunction of
 * optionally-negated atoms this workflow writes and nothing wider: an
 * unrecognised shape throws rather than resolving to a value, because a reader
 * that answers `false` for an expression it could not parse reports every step
 * as mutually exclusive with every other — the reassuring answer, from the one
 * case where it is worthless.
 */
function guardAdmits(guard: string, trigger: BackupTrigger): boolean {
  return guard.split('&&').every((term) => {
    const text = term.trim();
    const negated = text.startsWith('!');
    const atom = (negated ? text.slice(1) : text).trim();
    const event = /^github\.event_name == '(\w+)'$/u.exec(atom);
    if (event !== null) {
      return negated ? trigger.eventName !== event[1] : trigger.eventName === event[1];
    }
    const input = /^inputs\.(\w+)$/u.exec(atom);
    const held = input === null ? undefined : trigger.inputs[input[1] ?? ''];
    if (held === undefined) {
      throw new Error(
        `the backup workflow guards a step with '${text}', which this reader cannot evaluate`
      );
    }
    return negated ? !held : held;
  });
}

/** Each guarded step of the workflow's single job, by name. */
function guardedSteps(file: string): { name: string; guard: string }[] {
  const workflow = parseYaml(readFileSync(file, 'utf8')) as {
    jobs?: Record<string, { steps?: { name?: string; if?: string }[] }>;
  };
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.if === 'string')
    .map((step) => ({ name: step.name ?? '(unnamed step)', guard: step.if ?? '' }));
}

/**
 * Which steps a trigger reaches. Provisioning writes a repository config with
 * its own master key, so a second one against the same bucket leaves the
 * repository undecryptable and every backup in it unrecoverable; that is why
 * the schedule must not reach it, and why no two of these steps may run
 * together.
 */
describe('the backup workflow triggers', () => {
  const BACKUP_WORKFLOW = path.join(GITHUB_DIR, 'workflows/backup.yml');
  const PROVISION_STEP = 'Create the backup repository';

  function reached(trigger: BackupTrigger): string[] {
    return guardedSteps(BACKUP_WORKFLOW)
      .filter((step) => guardAdmits(step.guard, trigger))
      .map((step) => step.name);
  }

  it('runs exactly one of its guarded steps on every trigger', () => {
    const triggers = backupTriggers(BACKUP_WORKFLOW);
    const wrong = triggers
      .map((trigger) => ({ trigger, steps: reached(trigger) }))
      .filter(({ steps }) => steps.length !== 1);

    expect(guardedSteps(BACKUP_WORKFLOW).length).toBeGreaterThan(1);
    expect(triggers.length).toBeGreaterThan(1);
    expect(wrong).toEqual([]);
  });

  it('leaves provisioning out of reach of the schedule', () => {
    const scheduled = backupTriggers(BACKUP_WORKFLOW).filter(
      (trigger) => trigger.eventName === 'schedule'
    );

    expect(scheduled.length).toBeGreaterThan(0);
    expect(guardedSteps(BACKUP_WORKFLOW).map((step) => step.name)).toContain(PROVISION_STEP);
    expect(scheduled.filter((trigger) => reached(trigger).includes(PROVISION_STEP))).toEqual([]);
  });
});

describe('the escrow sections', () => {
  const ESCROW_WORKFLOW = '.github/workflows/escrow-secrets.yml';
  // Restated rather than imported from the generator: a section compared
  // against the very list that produced it proves only that the renderer runs.
  const BUCKET_BINDINGS = [
    'ESCROW_B2_KEY_ID',
    'ESCROW_B2_APPLICATION_KEY',
    'ESCROW_B2_BUCKET',
    'ESCROW_B2_S3_ENDPOINT',
  ];

  // Derived from the declarations rather than read off the generator, with the
  // repository's share folded into production because that is the job the
  // ruling gives it: every job can read a repository-scoped secret, and one
  // capturing it is what keeps the same bytes out of two sets.
  it('names the environment of every escrow job the declarations need', () => {
    const expected = [
      ...new Set(
        declaredCredentials()
          .filter(([, credential]) => credential.onLoss === 'restoreFromCopy')
          .map(([, credential]) => credential.store.replace('github:', ''))
          .map((environment) => (environment === 'repository' ? 'production' : environment))
      ),
    ].toSorted(byCodeUnit);

    expect(escrowEnvironments()).toEqual(expected);
  });

  it('renders one section per environment into the escrow workflow alone', () => {
    const owners = escrowEnvironments().map(
      (environment) => workflowSections()[escrowSectionMarker(environment)]?.owners
    );

    expect(owners).toEqual(escrowEnvironments().map(() => [ESCROW_WORKFLOW]));
  });

  it('places every restore-from-copy declaration in exactly one section', () => {
    const placements = new Map(
      escrowedSecretKeys().map((key) => [
        key,
        escrowEnvironments().filter((environment) =>
          bindingsOf(escrowSectionMarker(environment)).has(key)
        ),
      ])
    );
    const wrong = [...placements].filter(([, environments]) => environments.length !== 1);

    expect(wrong).toEqual([]);
  });

  it('gives each section exactly its own environment’s escrow set', () => {
    const wrong = escrowEnvironments().filter((environment) => {
      const keys = [...bindingsOf(escrowSectionMarker(environment)).keys()].filter(
        (key) => !BUCKET_BINDINGS.includes(key)
      );
      return (
        JSON.stringify(keys.toSorted(byCodeUnit)) !==
        JSON.stringify(escrowedSecretKeys(environment).toSorted(byCodeUnit))
      );
    });

    expect(wrong).toEqual([]);
  });

  it('binds the bucket address and credentials in every section, since every job uploads', () => {
    const missing = escrowEnvironments().flatMap((environment) =>
      BUCKET_BINDINGS.filter(
        (key) => bindingsOf(escrowSectionMarker(environment)).get(key) !== `\${{ secrets.${key} }}`
      )
    );

    expect(missing).toEqual([]);
  });

  // Both jobs sign an upload to the same bucket with these, each under its own
  // environment, and an environment secret resolves to the empty string in every
  // other environment — so a pair held on one environment is a set the other
  // job refuses on, at the moment a copy is being written rather than at a gate.
  it('holds the bucket bindings where every escrow job can read them', () => {
    const unreadable = BUCKET_BINDINGS.filter((key) => {
      const store = storeOfBoundSecret(`\${{ secrets.${key} }}`);
      return escrowEnvironments().some(
        (environment) => store !== 'github:repository' && store !== `github:${environment}`
      );
    });

    expect(BUCKET_BINDINGS.length).toBeGreaterThan(0);
    expect(unreadable).toEqual([]);
  });

  // Read off the bound secret's own declaration rather than off the set the
  // generator built the section from: comparing a section against the function
  // that produced it proves the rendering round-trips, and a declaration mapped
  // into the wrong environment's section survives that comparison intact.
  it('binds in each section only what that section’s environment can read', () => {
    const unreadable = escrowEnvironments().flatMap((environment) =>
      [...bindingsOf(escrowSectionMarker(environment))]
        .filter(([, bound]) => {
          const store = storeOfBoundSecret(bound);
          return store !== `github:${environment}` && store !== 'github:repository';
        })
        .map(([key]) => `${environment}: ${key}`)
    );

    expect(unreadable).toEqual([]);
  });

  it('binds every escrowed key to its production secret', () => {
    const wrong = escrowEnvironments().flatMap((environment) => {
      const bound = bindingsOf(escrowSectionMarker(environment));
      return escrowedSecretKeys(environment).filter((key) => {
        const config = (envConfig as Record<string, VariableConfig>)[key];
        const raw = config === undefined ? undefined : resolveRaw(config, Mode.Production);
        const name = isSecret(raw) ? raw.name : key;
        return bound.get(key) !== `\${{ secrets.${name} }}`;
      });
    });

    expect(wrong).toEqual([]);
  });
});

interface WorkflowJob {
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly needs?: readonly string[];
  readonly environment?: string;
  readonly if?: string;
}

function jobsOf(file: string): Record<string, WorkflowJob> {
  const workflow = parseYaml(readFileSync(file, 'utf8')) as { jobs?: Record<string, WorkflowJob> };
  return workflow.jobs ?? {};
}

describe('the escrow calls in the pipeline', () => {
  const ESCROW_WORKFLOW = '.github/workflows/escrow-secrets.yml';
  const ESCROW_WORKFLOW_PATH = path.join(GITHUB_DIR, 'workflows/escrow-secrets.yml');
  const CI_WORKFLOW = path.join(GITHUB_DIR, 'workflows/ci.yml');

  /** Every job in the pipeline that calls the escrow, with the set it asks for. */
  function escrowCalls(): { name: string; environment: string | undefined }[] {
    return Object.entries(jobsOf(CI_WORKFLOW))
      .filter(([, job]) => job.uses === `./${ESCROW_WORKFLOW}`)
      .map(([name, job]) => ({
        name,
        environment: job.with?.['environment'] as string | undefined,
      }));
  }

  it('calls the escrow once for every environment the declarations name', () => {
    const named = escrowCalls().map((call) => call.environment ?? '(no environment named)');

    expect(named.toSorted(byCodeUnit)).toEqual(escrowEnvironments());
  });

  // A called workflow reports the aggregate of its jobs, so `needs` on the call
  // is a wait on every set it writes. The deploy publishes one environment's
  // secrets and must not be held by an environment whose keys it never touches:
  // one call per set is what makes the dependency expressible at all, since
  // `needs` cannot name a job inside a called workflow.
  it('gates the deploy on the escrow of the environment it deploys to alone', () => {
    const deploy = jobsOf(CI_WORKFLOW)['deploy'];
    const waitedOn = escrowCalls().filter((call) => (deploy?.needs ?? []).includes(call.name));

    expect(deploy?.environment).toBeDefined();
    expect(waitedOn.map((call) => call.environment)).toEqual([deploy?.environment]);
  });

  // Each job binds one environment's secrets, so a call that ran them all would
  // put the deploy back behind every set at once — the coupling the split
  // exists to remove.
  it('runs each escrow job only when the call names that job’s environment', () => {
    const jobs = Object.entries(jobsOf(ESCROW_WORKFLOW_PATH));
    const ungated = jobs.filter(
      ([, job]) => !(job.if ?? '').includes(`inputs.environment == '${job.environment ?? ''}'`)
    );

    expect(jobs.length).toBeGreaterThan(0);
    expect(ungated.map(([name]) => name)).toEqual([]);
  });

  it('offers every escrow environment to a dispatch and no other', () => {
    const workflow = parseYaml(readFileSync(ESCROW_WORKFLOW_PATH, 'utf8')) as {
      on?: { workflow_dispatch?: { inputs?: { environment?: { options?: string[] } } } };
    };

    expect(
      workflow.on?.workflow_dispatch?.inputs?.environment?.options?.toSorted(byCodeUnit)
    ).toEqual(escrowEnvironments());
  });
});

describe('updateGeneratedFiles edge cases', () => {
  let edgeRoot = '';

  const withEdgeFixture = fixtureRunner('hushbox-generate-env-edge-', (root) => {
    edgeRoot = root;
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  });

  const fixture = workflowFixture(() => edgeRoot);

  it(
    'refuses a workflow file missing a pair its sections declare',
    withEdgeFixture(() => {
      writeFileSync(path.join(edgeRoot, '.github/workflows/ci.yml'), 'name: CI\njobs: {}');

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(/ci\.yml: vitest-env — 1 declared, 0 found/);
    })
  );

  it(
    'refuses the secrets document when it lost its pair',
    withEdgeFixture(() => {
      mkdirSync(path.join(edgeRoot, 'docs'), { recursive: true });
      writeFileSync(path.join(edgeRoot, SECRETS_DOC), '# Secrets\n');

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(/SECRETS\.md: secrets-inventory — 1 declared, 0 found/);
    })
  );

  // The pair one file too many: two blocks under one marker regenerate to the
  // same bytes, so losing one of them changes nothing anyone can see.
  it(
    'refuses a second pair of a section declared once',
    withEdgeFixture(() => {
      fixture.write(
        '.github/workflows/ci.yml',
        `name: CI
# BEGIN GENERATED: vitest-env
old
# END GENERATED: vitest-env
# BEGIN GENERATED: vitest-env
old
# END GENERATED: vitest-env`
      );

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(/ci\.yml: vitest-env — 1 declared, 2 found/);
    })
  );

  // Each ops-script step carries its own copy, so a step that lost its copy
  // leaves the file one pair short rather than without the marker.
  it(
    'refuses a workflow file holding two pairs of the ops-script bindings',
    withEdgeFixture(() => {
      writeFileSync(
        path.join(edgeRoot, '.github/workflows/ci.yml'),
        `name: CI
# BEGIN GENERATED: ops-env
old
# END GENERATED: ops-env
# BEGIN GENERATED: ops-env
old
# END GENERATED: ops-env`
      );

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(/ci\.yml: ops-env — 3 declared, 2 found/);
    })
  );

  it(
    'refuses a marker in a file its section does not own',
    withEdgeFixture(() => {
      fixture.write(
        '.github/workflows/ci.yml',
        `name: CI
# BEGIN GENERATED: build-env-android
old
# END GENERATED: build-env-android`
      );

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(/ci\.yml: build-env-android — 0 declared, 1 found/);
    })
  );

  // A marker that is a prefix of the next one: the count must not read the
  // neighbour's END as this section's, which would rewrite both into one.
  it(
    'refuses a section whose END marker was deleted ahead of a longer-named sibling',
    withEdgeFixture(() => {
      fixture.write(
        '.github/workflows/ci.yml',
        `name: CI
# BEGIN GENERATED: build-env
old
# BEGIN GENERATED: build-env-mobile
old
# END GENERATED: build-env-mobile`
      );

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(/ci\.yml: build-env — 1 declared, 0 found/);
    })
  );

  it(
    'names both remedies when it refuses',
    withEdgeFixture(() => {
      writeFileSync(path.join(edgeRoot, '.github/workflows/ci.yml'), 'name: CI\njobs: {}');

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).toThrow(
        "Restore the missing marker pair, or update the section's owners in scripts/generate-env.ts"
      );
    })
  );

  it(
    'does nothing if ci.yml does not exist',
    withEdgeFixture(() => {
      rmSync(path.join(edgeRoot, '.github/workflows'), { recursive: true, force: true });
      mkdirSync(path.join(edgeRoot, '.github/workflows'), { recursive: true });

      expect(() => {
        updateGeneratedFiles(edgeRoot);
      }).not.toThrow();
    })
  );
});

describe('updateGeneratedFiles write behaviour', () => {
  const CI_YML = '.github/workflows/ci.yml';
  let writeRoot = '';

  const fixture = workflowFixture(() => writeRoot);

  const withWriteFixture = fixtureRunner(
    'hushbox-generate-env-write-',
    (root) => {
      writeRoot = root;
      mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    },
    (root) => {
      // These tests revoke write permission on the fixture, and removal needs it back.
      for (const relative of ['.github/workflows', '.github', '.']) {
        const directory = path.join(root, relative);
        if (existsSync(directory)) chmodSync(directory, 0o755);
      }
    }
  );

  const identity = (): { ino: bigint; mtimeNs: bigint } => {
    const stats = statSync(path.join(writeRoot, CI_YML), { bigint: true });
    return { ino: stats.ino, mtimeNs: stats.mtimeNs };
  };

  // Rewriting identical bytes moves mtime only by the filesystem's resolution, so
  // two writes in one tick share a timestamp. Backdating first makes any write
  // detectable by a minute instead of by a tick, however fast the run is.
  const backdate = (): void => {
    const aged = new Date(Date.now() - 60_000);
    utimesSync(path.join(writeRoot, CI_YML), aged, aged);
  };

  it(
    'attempts no write at all when every generated block already matches disk',
    withWriteFixture(() => {
      fixture.write(CI_YML, 'name: CI');
      updateGeneratedFiles(writeRoot);
      backdate();
      const before = identity();

      // Revoking write permission on both the file and its directory makes every
      // write form fail: truncate-in-place needs the file writable, and a
      // temp-then-rename needs the directory writable.
      chmodSync(path.join(writeRoot, CI_YML), 0o444);
      chmodSync(path.join(writeRoot, '.github/workflows'), 0o555);

      expect(() => {
        updateGeneratedFiles(writeRoot);
      }).not.toThrow();

      // Mode bits are advisory for root and on permission-ignoring mounts, which
      // makes the throw-free run fail open on its own. Inode and mtime do not
      // depend on the identity the process runs as, so they carry the claim.
      expect(identity()).toEqual(before);
    })
  );

  it(
    'replaces a changed workflow file without writing through the existing one',
    withWriteFixture(() => {
      // The fixture writes the marker pairs with empty bodies, so the first
      // render is a genuine change to every block the file owns.
      fixture.write(CI_YML, 'name: CI');
      const stale = readFileSync(path.join(writeRoot, CI_YML), 'utf8');
      const before = identity();
      // A truncate-in-place rewrite needs the target itself writable; a rename
      // over it does not care about its mode.
      chmodSync(path.join(writeRoot, CI_YML), 0o444);

      updateGeneratedFiles(writeRoot);

      expect(readFileSync(path.join(writeRoot, CI_YML), 'utf8')).not.toBe(stale);
      // A rename installs the temporary file's inode; truncate-in-place preserves
      // the original's, so this cannot pass without a replacement.
      expect(identity().ino).not.toBe(before.ino);
    })
  );

  it(
    'names the file whether or not this run changed its bytes',
    withWriteFixture(() => {
      fixture.write(CI_YML, 'name: CI');
      const first = updateGeneratedFiles(writeRoot);

      // The pre-commit hook stages this list and refuses an empty one, so a run
      // that writes nothing must still name what carries a generated block.
      expect(updateGeneratedFiles(writeRoot)).toEqual(first);
    })
  );
});

describe('a committed file that changed under the generator', () => {
  const CI_YML = '.github/workflows/ci.yml';
  let raceRoot = '';

  const fixture = workflowFixture(() => raceRoot);

  const withRaceFixture = fixtureRunner(
    'hushbox-generate-env-race-',
    (root) => {
      raceRoot = root;
      mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
      mkdirSync(path.join(root, 'docs'), { recursive: true });
      fixture.write(CI_YML, 'name: CI');
      writeFileSync(path.join(root, SECRETS_DOC), EMPTY_INVENTORY_DOC);
    },
    () => {
      vi.restoreAllMocks();
    }
  );

  const documentPath = (): string => path.join(raceRoot, SECRETS_DOC);
  const documentText = (): string => readFileSync(documentPath(), 'utf8');

  /**
   * Puts `bytes` in the secrets document once the run has printed its line for
   * the workflow file, which lands inside the window this refusal is about:
   * every file is read before the first one is written, so the document's own
   * read is already behind us and its write is still ahead. The progress line
   * is the one moment a test can reach in a synchronous run; it stands in for a
   * neighbouring writer landing anywhere in that window.
   */
  const writeDocumentMidRun = (bytes: string, keepModifiedTime = false): void => {
    let written = false;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const [line] = args;
      if (written || typeof line !== 'string' || !line.includes(CI_YML)) return;
      written = true;
      const before = statSync(documentPath());
      writeFileSync(documentPath(), bytes);
      if (keepModifiedTime) utimesSync(documentPath(), before.atime, before.mtime);
    });
  };

  const LONGER_DOC = EMPTY_INVENTORY_DOC.replace(
    '# Secrets\n',
    '# Secrets\n\nA line another writer added.\n'
  );

  it(
    'refuses to write it, naming the file',
    withRaceFixture(() => {
      writeDocumentMidRun(LONGER_DOC);

      expect(() => {
        updateGeneratedFiles(raceRoot);
      }).toThrow(/docs\/SECRETS\.md/);
    })
  );

  it(
    "leaves the other writer's bytes on disk",
    withRaceFixture(() => {
      writeDocumentMidRun(LONGER_DOC);

      expect(() => {
        updateGeneratedFiles(raceRoot);
      }).toThrow();
      expect(documentText()).toBe(LONGER_DOC);
    })
  );

  // A substitution of equal length: a size comparison sees nothing here, which
  // is why the check compares the bytes themselves.
  it(
    'refuses an edit that changed no byte count',
    withRaceFixture(() => {
      const sameLength = EMPTY_INVENTORY_DOC.replace('# Secrets\n', '# Secretz\n');
      expect(sameLength).toHaveLength(EMPTY_INVENTORY_DOC.length);
      writeDocumentMidRun(sameLength);

      expect(() => {
        updateGeneratedFiles(raceRoot);
      }).toThrow(/docs\/SECRETS\.md/);
    })
  );

  // The modification time restored to what it was: a timestamp comparison sees
  // nothing here either. Restoration goes through a Date, so it is exact to the
  // millisecond and no finer, which is the resolution a stat's `mtime` carries.
  it(
    'refuses an edit that left the modification time where it was',
    withRaceFixture(() => {
      const before = statSync(documentPath()).mtime.getTime();
      writeDocumentMidRun(LONGER_DOC, true);

      expect(() => {
        updateGeneratedFiles(raceRoot);
      }).toThrow(/docs\/SECRETS\.md/);
      expect(statSync(documentPath()).mtime.getTime()).toBe(before);
    })
  );
});

describe('the wrangler configuration changed under the generator', () => {
  const WRANGLER_CONFIG = 'apps/api/wrangler.toml';
  const HUMAN_WRITTEN = '# Wrangler configuration\nname = "test-api"\nmain = "src/index.ts"\n';
  const OTHER_WRITERS_BYTES = `${HUMAN_WRITTEN}account_id = "another writer put this here"\n`;

  let wranglerRoot = '';

  const withWranglerRace = fixtureRunner(
    'hushbox-generate-env-wrangler-race-',
    (root) => {
      wranglerRoot = root;
      mkdirSync(path.join(root, 'apps/api'), { recursive: true });
      // Worktree detection reads this, and the slot registry it then writes is
      // machine-wide, so it is pointed inside the fixture tree.
      mkdirSync(path.join(root, '.git'), { recursive: true });
      vi.stubEnv('TMPDIR', path.join(root, 'registry-temp'));
      writeFileSync(path.join(root, WRANGLER_CONFIG), HUMAN_WRITTEN);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    },
    () => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  );

  const wranglerPath = (): string => path.join(wranglerRoot, WRANGLER_CONFIG);
  const PRODUCTION: EnvMode = Mode.Production;

  /**
   * Puts another writer's bytes in the wrangler configuration the first time the
   * run asks the registry for a production destination, which lands inside the
   * window this refusal is about: the rewriter reads the file, walks the registry
   * in production mode to build the block it substitutes, and only then writes.
   * A development run resolves every other file against its own mode, so the
   * first production-mode question is the rewriter's own, after its read.
   */
  const writeWranglerMidRun = (): void => {
    const registryDestinations = envConfigModule.getDestinations;
    let written = false;
    vi.spyOn(envConfigModule, 'getDestinations').mockImplementation((config, mode) => {
      if (!written && mode === PRODUCTION) {
        written = true;
        writeFileSync(wranglerPath(), OTHER_WRITERS_BYTES);
      }
      return registryDestinations(config, mode);
    });
  };

  it(
    'refuses to write it, naming the file',
    withWranglerRace(() => {
      writeWranglerMidRun();

      expect(() => {
        generateEnvFiles(wranglerRoot);
      }).toThrow(/apps\/api\/wrangler\.toml/);
    })
  );

  it(
    "leaves the other writer's bytes on disk",
    withWranglerRace(() => {
      writeWranglerMidRun();

      expect(() => {
        generateEnvFiles(wranglerRoot);
      }).toThrow();
      expect(readFileSync(wranglerPath(), 'utf8')).toBe(OTHER_WRITERS_BYTES);
    })
  );
});

describe('the writes this module makes to committed files', () => {
  /**
   * The functions that reach the module's one write, read off its source with
   * block comments stripped so a reference in prose is not read as a call.
   */
  const writers = (): string[] => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'generate-env.ts'),
      'utf8'
    ).replaceAll(/\/\*[\s\S]*?\*\//g, '');
    let enclosing = '';
    const callers = new Set<string>();
    for (const line of source.split('\n')) {
      const declared = /^(?:export )?function (\w+)/.exec(line)?.[1];
      if (declared !== undefined) enclosing = declared;
      else if (line.includes('writeIfChanged(')) callers.add(enclosing);
    }
    return [...callers].toSorted((a, b) => a.localeCompare(b));
  };

  // What makes the module answerable to a reader who finds the refusal on one
  // call: content derived from a file's own bytes is a read-modify-write that
  // can discard another writer's edit, and every one of them in this module
  // goes through the refusal. A third name here is either a rewrite that skipped
  // the guard or a generated file that gained one.
  it('rewrites a committed file in place only through the refusal', () => {
    expect(writers()).toEqual(['writeGeneratedFile', 'writeReadModifiedFile']);
  });
});

/**
 * The `--mode` values the generator's own header block lists, in the order it
 * lists them. Read out of the source because the block is prose: nothing else
 * makes it answerable to the mode table it stands in for.
 */
const documentedModes = (): string[] => {
  const source = readFileSync(path.join(REPO_ROOT, 'scripts', 'generate-env.ts'), 'utf8');
  const block = /^ \* Modes:\n((?: \* [-\s].*\n)+)/m.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^ \* - (\S+?)[:\s(]/gm)].flatMap(([, mode]) => mode ?? []);
};

describe('parseArgs', () => {
  it('returns development by default', () => {
    expect(parseArgs([])).toBe('development');
  });

  it('refuses a flag it does not recognise rather than writing the default mode', () => {
    expect(() => parseArgs(['--other=flag'])).toThrow(/--other/);
  });

  it('parses --mode=development', () => {
    expect(parseArgs(['--mode=development'])).toBe('development');
  });

  it('parses --mode=ciVitest', () => {
    expect(parseArgs(['--mode=ciVitest'])).toBe('ciVitest');
  });

  it('parses --mode=e2e', () => {
    expect(parseArgs(['--mode=e2e'])).toBe('e2e');
  });

  it('parses --mode=production', () => {
    expect(parseArgs(['--mode=production'])).toBe('production');
  });

  it('throws for invalid mode', () => {
    expect(() => parseArgs(['--mode=invalid'])).toThrow(
      'Invalid mode: invalid. Valid modes: development, test, ciVitest, e2e, ciE2E, production'
    );
  });

  it('throws for empty mode', () => {
    expect(() => parseArgs(['--mode='])).toThrow('Invalid mode: . Valid modes:');
  });

  it('reads a mode written as two tokens', () => {
    expect(parseArgs(['--mode', 'e2e'])).toBe('e2e');
  });

  it('names every mode it accepts in the header a reader consults', () => {
    const alphabetical = (modes: readonly string[]): string[] =>
      modes.toSorted((a, b) => a.localeCompare(b));
    expect(alphabetical(documentedModes())).toEqual(alphabetical(Object.values(Mode)));
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

  it('single-quotes values containing double quotes so dotenv preserves them verbatim', () => {
    // dotenv does NOT unescape \" inside double-quoted values, so JSON values
    // (e.g. CF_ACCESS_DEV_PRIVATE_JWK) written as "{\"kty\":…}" reach wrangler
    // and with-env consumers with literal backslashes and fail JSON.parse.
    // Single-quoted dotenv values are taken verbatim.
    expect(escapeEnvValue('say "hello"')).toBe(`'say "hello"'`);
    expect(escapeEnvValue('{"kty":"OKP","crv":"Ed25519"}')).toBe(`'{"kty":"OKP","crv":"Ed25519"}'`);
  });

  it('round-trips a JSON value through dotenv parsing', async () => {
    const { parse } = await import('dotenv');
    const value = '{"kty":"OKP","x":"abc"}';
    const parsed = parse(`KEY=${escapeEnvValue(value)}`);
    expect(parsed['KEY']).toBe(value);
    expect(JSON.parse(parsed['KEY']!)).toEqual({ kty: 'OKP', x: 'abc' });
  });

  it('escapes backslashes', () => {
    expect(escapeEnvValue(String.raw`path\to\file`)).toBe(String.raw`"path\\to\\file"`);
  });

  it('throws loudly on values containing both quote kinds', () => {
    // Neither dotenv quoting style represents this shape faithfully:
    // double-quoting writes \" that dotenv does not unescape, and a
    // single-quoted value cannot contain a literal single quote. Writing
    // either silently corrupts the value, so refuse and name the key.
    expect(() => escapeEnvValue(`it's "quoted"`, 'MY_SECRET')).toThrow(/MY_SECRET/);
    expect(() => escapeEnvValue(`it's "quoted"`, 'MY_SECRET')).toThrow(/quote/i);
  });

  it('throws on both quote kinds even without a key, with a fallback name', () => {
    expect(() => escapeEnvValue(`it's "quoted"`)).toThrow(/unknown key/i);
  });

  it('handles empty values', () => {
    expect(escapeEnvValue('')).toBe('""');
  });

  it('handles values with newlines', () => {
    expect(escapeEnvValue('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('worktree port integration', () => {
  let worktreeRoot = '';

  const stageWorktreeFixture = (root: string): void => {
    worktreeRoot = root;
    mkdirSync(path.join(root, 'apps/api'), { recursive: true });

    writeFileSync(
      path.join(root, 'apps/api/wrangler.toml'),
      `# Wrangler configuration
name = "test-api"
main = "src/index.ts"

[dev]
local_protocol = "http"
`
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
  };

  const withMainRepoFixture = fixtureRunner('hushbox-generate-env-main-repo-', (root) => {
    stageWorktreeFixture(root);
    mkdirSync(path.join(root, '.git'), { recursive: true });
  });

  const withWorktreeFixture = fixtureRunner('hushbox-generate-env-worktree-', (root) => {
    stageWorktreeFixture(root);
    writeFileSync(path.join(root, '.git'), 'gitdir: /checkouts/repo/.git/worktrees/my-feature\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('main repo (slot 0)', () => {
    it(
      'uses the slot ports in .dev.vars',
      withMainRepoFixture(() => {
        generateEnvFiles(worktreeRoot);

        const { ports } = getWorktreeConfig(worktreeRoot);
        const content = readFileSync(path.join(worktreeRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).toContain(`API_URL="http://localhost:${String(ports.api)}"`);
        expect(content).toContain(`FRONTEND_URL="http://localhost:${String(ports.vite)}"`);
      })
    );

    it(
      'uses the slot Astro port for MARKETING_URL in .dev.vars',
      withMainRepoFixture(() => {
        generateEnvFiles(worktreeRoot);

        const { ports } = getWorktreeConfig(worktreeRoot);
        const content = readFileSync(path.join(worktreeRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).toContain(`MARKETING_URL="http://localhost:${String(ports.astro)}"`);
      })
    );

    it(
      'uses the slot ports in .env.development',
      withMainRepoFixture(() => {
        generateEnvFiles(worktreeRoot);

        const { ports } = getWorktreeConfig(worktreeRoot);
        const content = readFileSync(path.join(worktreeRoot, '.env.development'), 'utf8');
        expect(content).toContain(`VITE_API_URL="http://localhost:${String(ports.api)}"`);
      })
    );

    it(
      'uses the slot ports in .env.scripts',
      withMainRepoFixture(() => {
        generateEnvFiles(worktreeRoot);

        const { ports } = getWorktreeConfig(worktreeRoot);
        const content = readFileSync(path.join(worktreeRoot, '.env.scripts'), 'utf8');
        expect(content).toContain(`localhost:${String(ports.neon)}`);
        expect(content).toContain(`localhost:${String(ports.postgres)}`);
      })
    );

    it(
      'appends worktree vars to .env.scripts',
      withMainRepoFixture(() => {
        generateEnvFiles(worktreeRoot);

        const content = readFileSync(path.join(worktreeRoot, '.env.scripts'), 'utf8');
        const { ports, projectName, slot } = getWorktreeConfig(worktreeRoot);
        expect(content).toContain(`COMPOSE_PROJECT_NAME="${projectName}"`);
        expect(content).toContain(`HB_STACK_SLOT="${String(slot)}"`);
        for (const service of SERVICE_KEYS) {
          expect(content).toContain(`${portEnvName(service)}="${String(ports[service])}"`);
        }
      })
    );
  });

  describe('worktree', () => {
    /**
     * What a checkout's files must never carry: another checkout's allocation,
     * which a stack over there may be bound to right now. The stand-in is a
     * slot this fixture does not hold, derived rather than fixed — no slot is
     * privileged, so the fixture may itself hold whichever one is named. Naming
     * both sides is what gives these assertions weight: every port the
     * generator can emit lies in the plan's range, so an absence claim against
     * a port outside it holds whatever the allocator does.
     */
    const elsewherePorts = (): Record<ServiceKey, number> =>
      portsFor({ slot: otherSlot(getWorktreeConfig(worktreeRoot).slot), mode: 'development' });

    const bothSides = (content: string, services: readonly ServiceKey[]): void => {
      const { ports } = getWorktreeConfig(worktreeRoot);
      const elsewhere = elsewherePorts();
      for (const service of services) {
        expect(content).toContain(`localhost:${String(ports[service])}`);
        expect(content).not.toContain(`localhost:${String(elsewhere[service])}`);
      }
    };

    it(
      'binds this slot in .dev.vars, never the main checkout allocation',
      withWorktreeFixture(() => {
        generateEnvFiles(worktreeRoot);

        const content = readFileSync(path.join(worktreeRoot, 'apps/api/.dev.vars'), 'utf8');
        bothSides(content, ['api', 'vite', 'neon', 'redisHttp']);
      })
    );

    it(
      'rewrites MARKETING_URL to the Astro port this slot holds',
      withWorktreeFixture(() => {
        generateEnvFiles(worktreeRoot);

        const { ports } = getWorktreeConfig(worktreeRoot);
        const content = readFileSync(path.join(worktreeRoot, 'apps/api/.dev.vars'), 'utf8');
        expect(content).not.toContain(
          `MARKETING_URL="http://localhost:${String(elsewherePorts().astro)}"`
        );
        expect(content).toContain(`MARKETING_URL="http://localhost:${String(ports.astro)}"`);
      })
    );

    it(
      'binds this slot in .env.development, never the main checkout allocation',
      withWorktreeFixture(() => {
        generateEnvFiles(worktreeRoot);

        const content = readFileSync(path.join(worktreeRoot, '.env.development'), 'utf8');
        bothSides(content, ['api', 'studio', 'admin']);
      })
    );

    it(
      'binds this slot in .env.scripts, never the main checkout allocation',
      withWorktreeFixture(() => {
        generateEnvFiles(worktreeRoot);

        const content = readFileSync(path.join(worktreeRoot, '.env.scripts'), 'utf8');
        bothSides(content, ['neon', 'postgres']);
      })
    );

    it(
      'appends worktree vars carrying this slot ports to .env.scripts',
      withWorktreeFixture(() => {
        generateEnvFiles(worktreeRoot);

        const { ports } = getWorktreeConfig(worktreeRoot);
        const elsewhere = elsewherePorts();
        const content = readFileSync(path.join(worktreeRoot, '.env.scripts'), 'utf8');
        expect(content).toContain('COMPOSE_PROJECT_NAME="hushbox-');
        expect(content).toContain(`HB_VITE_PORT="${String(ports.vite)}"`);
        expect(content).toContain(`HB_API_PORT="${String(ports.api)}"`);
        expect(content).not.toContain(`HB_VITE_PORT="${String(elsewhere.vite)}"`);
        expect(content).not.toContain(`HB_API_PORT="${String(elsewhere.api)}"`);
      })
    );

    // A mode standing in for a stack is still generated by a checkout, and the
    // values it substitutes have to reach that checkout's own band: another
    // slot's addresses are ones a neighbouring checkout may be serving right
    // now. The fixture is put off the first slot, so a file bound to the first
    // slot regardless of its generator fails here rather than agreeing with the
    // assertion by coincidence.
    it(
      'binds this slot in a mode standing in for a stack',
      withWorktreeFixture(() => {
        process.env['HELCIM_API_TOKEN_SANDBOX'] = 'test';
        process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'] = 'test';
        process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'] = 'test';
        const seeded = claimSlotsAhead(worktreeRoot);
        expect(seeded).not.toBe(0);

        generateEnvFiles(worktreeRoot, 'ciE2E');

        const { slot } = getWorktreeConfig(worktreeRoot);
        const ports = portsFor({ slot, mode: 'e2e' });
        const elsewhere = portsFor({ slot: otherSlot(slot), mode: 'e2e' });
        const content = readFileSync(
          path.join(worktreeRoot, generatedEnvPaths('e2e').backend),
          'utf8'
        );
        expect(content).toContain(`localhost:${String(ports.api)}`);
        expect(content).toContain(`localhost:${String(ports.vite)}`);
        expect(content).not.toContain(`localhost:${String(elsewhere.api)}`);
        expect(content).not.toContain(`localhost:${String(elsewhere.vite)}`);

        delete process.env['HELCIM_API_TOKEN_SANDBOX'];
        delete process.env['HELCIM_WEBHOOK_VERIFIER_SANDBOX'];
        delete process.env['VITE_HELCIM_JS_TOKEN_SANDBOX'];
      })
    );
  });
});

/** Every service name `source` asks for in `<service>.localhost` position. */
function templatedServices(source: string): string[] {
  return [...source.matchAll(/(\w+)\.localhost/g)].map(([, service]) => service ?? '');
}

/** Every literal the registry resolves to, across every mode. */
function registryLiterals(): string[] {
  return Object.values(envConfig).flatMap((config) =>
    Object.values(Mode).flatMap((mode) => {
      const raw = resolveRaw(config as VariableConfig, mode);
      return typeof raw === 'string' ? [raw] : [];
    })
  );
}

describe('the registry service hosts', () => {
  it('names only service hosts the port plan declares', () => {
    const literals = registryLiterals();
    const ports = portsFor({ slot: 0, mode: 'development' });

    expect(literals.flatMap((literal) => templatedServices(literal)).length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(() => applyWorktreePorts(literal, ports)).not.toThrow();
    }
  });

  it('leaves no port literal in the registry for anything to drift from', () => {
    expect(registryLiterals().filter((literal) => /localhost:\d/.test(literal))).toEqual([]);
  });

  it('rewrites a service host embedded in a URL to the requested band', () => {
    const ports = portsFor({ slot: 7, mode: 'e2e' });

    expect(applyWorktreePorts('postgres://u:p@neon.localhost/hushbox', ports)).toBe(
      `postgres://u:p@localhost:${String(ports.neon)}/hushbox`
    );
  });

  it('gives the same service different ports in different bands', () => {
    const template = 'http://api.localhost';
    const development = applyWorktreePorts(template, portsFor({ slot: 3, mode: 'development' }));

    expect(applyWorktreePorts(template, portsFor({ slot: 3, mode: 'e2e' }))).not.toBe(development);
  });

  it('refuses a service host naming no declared service', () => {
    expect(() =>
      applyWorktreePorts('http://nosuchservice.localhost', portsFor({ slot: 0, mode: 'e2e' }))
    ).toThrow('nosuchservice');
  });

  /**
   * `URL` lowercases a hostname, so a value spelling a service host with a
   * capital does not equal its own origin, and the loopback exemption in
   * `packages/shared/src/env/env-registry-content.ts` stops applying — a
   * credential-bearing entry's emulator address becomes a leak needle. The
   * declared spelling is the service key lowercased, and nothing else reaches
   * a file.
   */
  it('refuses a service host spelled other than as the lowercased service key', () => {
    expect(() =>
      applyWorktreePorts('http://redisHttp.localhost', portsFor({ slot: 0, mode: 'e2e' }))
    ).toThrow('redisHttp');
  });
});

/**
 * The generated files carry credentials — the production mode's file carries
 * live ones — so an unignored path is a leak waiting on a `git add -A`. Asked
 * of git itself rather than of the ignore file's text, because a pattern
 * anywhere in the chain may be what covers a path, and asked for every mode of
 * the registry, so a mode added with no entry fails here instead of appearing
 * in someone's next commit.
 */
describe('the generated env files are ignored', () => {
  it('has git ignoring every generated path of every mode', () => {
    const paths = [
      ...new Set(
        Object.values(Mode).flatMap((mode) =>
          Object.values(generatedEnvPaths(mode)).map((relative) =>
            relative.split(path.sep).join('/')
          )
        )
      ),
    ];

    const checked = execaSync('git', ['check-ignore', '--no-index', ...paths], {
      cwd: REPO_ROOT,
      reject: false,
    });

    expect(new Set(checked.stdout.split('\n').filter(Boolean))).toStrictEqual(new Set(paths));
  });
});

describe('the generated env round trip', () => {
  let roundTripRoot = '';

  const withRoundTripFixture = fixtureRunner('hushbox-generate-env-round-trip-', (root) => {
    roundTripRoot = root;
    mkdirSync(path.join(root, 'apps/api'), { recursive: true });
    mkdirSync(path.join(root, '.git'), { recursive: true });
    writeFileSync(
      path.join(root, 'apps/api/wrangler.toml'),
      '# Wrangler configuration\nname = "test-api"\n'
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  beforeEach(stubStackSecrets);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const generatedText = (stackMode: StackMode): string =>
    Object.values(generatedEnvPaths(stackMode))
      .map((relative) => readFileSync(path.join(roundTripRoot, relative), 'utf8'))
      .join('\n');

  it.each([...STACK_MODES])(
    'parses every localhost port it writes back to one service of that band (%s)',
    withRoundTripFixture((stackMode: StackMode) => {
      generateEnvFiles(roundTripRoot, envModeForStack(stackMode));

      const text = generatedText(stackMode);
      const written = [...text.matchAll(/localhost:(\d+)/g)].map(([, port]) => Number(port));
      expect(written.length).toBeGreaterThan(0);
      for (const port of written) {
        const described = describePort(port);
        expect(described).toBeDefined();
        expect(described?.slot).toBe(getWorktreeConfig(roundTripRoot).slot);
        expect(described?.modes).toContain(stackMode);
      }
    })
  );

  it.each([...STACK_MODES])(
    'substitutes every service host it writes (%s)',
    withRoundTripFixture((stackMode: StackMode) => {
      generateEnvFiles(roundTripRoot, envModeForStack(stackMode));

      expect(templatedServices(generatedText(stackMode))).toEqual([]);
    })
  );
});

describe('build-env variants', () => {
  let variantsRoot = '';

  const withVariantsFixture = fixtureRunner('hushbox-generate-env-variants-', (root) => {
    variantsRoot = root;
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  });

  const fixture = workflowFixture(() => variantsRoot);

  const createWorkflow = (filename: string, content: string): void => {
    fixture.write(`.github/workflows/${filename}`, content);
  };

  const readWorkflow = (filename: string): string => {
    return fixture.read(`.github/workflows/${filename}`);
  };

  describe('build-env-android', () => {
    it(
      'overrides VITE_PLATFORM to inputs.vite-platform expression',
      withVariantsFixture(() => {
        createWorkflow(
          'build-android.yml',
          `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-android.yml');
        expect(content).toContain('VITE_PLATFORM: ${{ inputs.vite-platform }}');
      })
    );

    it(
      'overrides VITE_APP_VERSION to use inputs.version',
      withVariantsFixture(() => {
        createWorkflow(
          'build-android.yml',
          `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-android.yml');
        expect(content).toContain('VITE_APP_VERSION: ${{ inputs.version }}');
      })
    );

    it(
      'does not use VITE_APP_VERSION secret',
      withVariantsFixture(() => {
        createWorkflow(
          'build-android.yml',
          `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-android.yml');
        expect(content).not.toContain('secrets.VITE_APP_VERSION');
      })
    );

    it(
      'does not include VITE_OPAQUE_SERVER_ID (removed, hard-coded in crypto)',
      withVariantsFixture(() => {
        createWorkflow(
          'build-android.yml',
          `name: Android
        # BEGIN GENERATED: build-env-android
        old content
        # END GENERATED: build-env-android`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-android.yml');
        expect(content).not.toContain('VITE_OPAQUE_SERVER_ID');
      })
    );
  });

  describe('build-env-ios', () => {
    it(
      'pins VITE_PLATFORM to ios',
      withVariantsFixture(() => {
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old content
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-ios.yml');
        expect(content).toContain('VITE_PLATFORM: ios');
        expect(content).not.toContain('VITE_PLATFORM: web');
      })
    );

    it(
      'overrides VITE_APP_VERSION to use inputs.version',
      withVariantsFixture(() => {
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old content
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-ios.yml');
        expect(content).toContain('VITE_APP_VERSION: ${{ inputs.version }}');
      })
    );

    it(
      'overrides both legal effective dates to use the dates the workflow is called with',
      withVariantsFixture(() => {
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old content
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        const content = readWorkflow('build-ios.yml');
        expect(content).toContain(
          'VITE_PRIVACY_POLICY_EFFECTIVE_DATE: ${{ inputs.privacy-policy-effective-date }}'
        );
        expect(content).toContain(
          'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE: ${{ inputs.terms-of-service-effective-date }}'
        );
      })
    );

    // The native build is web-only (`--filter web`), so it never assembles the
    // sandbox origin and an ESM_CDN_URL in its block would be a variable nothing
    // reads.
    it(
      'omits ESM_CDN_URL from the web-only build',
      withVariantsFixture(() => {
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old content
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        expect(readWorkflow('build-ios.yml')).not.toContain('ESM_CDN_URL');
      })
    );
  });

  describe('shared values across variants', () => {
    it(
      'all variants include VITE_API_URL from envConfig',
      withVariantsFixture(() => {
        createWorkflow(
          'build-android.yml',
          `name: Android
        # BEGIN GENERATED: build-env-android
        old
        # END GENERATED: build-env-android`
        );
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        const android = readWorkflow('build-android.yml');
        const ios = readWorkflow('build-ios.yml');
        expect(android).toContain('VITE_API_URL: https://api.hushbox.ai');
        expect(ios).toContain('VITE_API_URL: https://api.hushbox.ai');
      })
    );

    it(
      'all variants include VITE_HELCIM_JS_TOKEN from envConfig',
      withVariantsFixture(() => {
        createWorkflow(
          'build-android.yml',
          `name: Android
        # BEGIN GENERATED: build-env-android
        old
        # END GENERATED: build-env-android`
        );
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        const android = readWorkflow('build-android.yml');
        const ios = readWorkflow('build-ios.yml');
        expect(android).toContain(
          'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
        );
        expect(ios).toContain(
          'VITE_HELCIM_JS_TOKEN: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
        );
      })
    );
  });

  describe('multi-file processing', () => {
    it(
      'updates markers across multiple workflow files',
      withVariantsFixture(() => {
        createWorkflow(
          'ci.yml',
          `name: CI
        # BEGIN GENERATED: build-env
        old ci
        # END GENERATED: build-env`
        );
        createWorkflow(
          'build-ios.yml',
          `name: iOS
        # BEGIN GENERATED: build-env-ios
        old ios
        # END GENERATED: build-env-ios`
        );

        updateGeneratedFiles(variantsRoot);

        const ci = readWorkflow('ci.yml');
        const ios = readWorkflow('build-ios.yml');
        expect(ci).toContain('VITE_API_URL: https://api.hushbox.ai');
        expect(ci).not.toContain('old ci');
        expect(ios).toContain('VITE_API_URL: https://api.hushbox.ai');
        expect(ios).not.toContain('old ios');
      })
    );

    it(
      'skips missing workflow files gracefully',
      withVariantsFixture(() => {
        // Only create ci.yml, not build-ios.yml or build-android.yml
        createWorkflow(
          'ci.yml',
          `name: CI
        # BEGIN GENERATED: build-env
        old
        # END GENERATED: build-env`
        );

        expect(() => {
          updateGeneratedFiles(variantsRoot);
        }).not.toThrow();

        const ci = readWorkflow('ci.yml');
        expect(ci).toContain('VITE_API_URL:');
      })
    );
  });
});

/**
 * The block each native workflow's generation step reads its values through.
 * Each of those workflows is one job that receives the version as an input, so
 * the expression the pipeline's own block binds resolves to nothing there.
 */
describe('production-env variants', () => {
  let productionRoot = '';

  const withProductionFixture = fixtureRunner('hushbox-generate-env-production-', (root) => {
    productionRoot = root;
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  });

  const fixture = workflowFixture(() => productionRoot);

  const generatedInto = (filename: string, marker: string, name: string): string => {
    fixture.write(
      `.github/workflows/${filename}`,
      `name: ${name}
      # BEGIN GENERATED: ${marker}
      old content
      # END GENERATED: ${marker}`
    );
    updateGeneratedFiles(productionRoot);
    return fixture.read(`.github/workflows/${filename}`);
  };

  const iosSection = (): string =>
    generatedInto('build-ios.yml', 'production-env-ios', 'Build iOS');

  const androidSection = (): string =>
    generatedInto('build-android.yml', 'production-env-android', 'Build Android');

  it(
    'binds the version the iOS workflow is called with',
    withProductionFixture(() => {
      expect(iosSection()).toContain('VITE_APP_VERSION: ${{ inputs.version }}');
    })
  );

  it(
    'binds the version the Android workflow is called with',
    withProductionFixture(() => {
      expect(androidSection()).toContain('VITE_APP_VERSION: ${{ inputs.version }}');
    })
  );

  it(
    'never binds the version to a stored secret',
    withProductionFixture(() => {
      expect(iosSection()).not.toContain('secrets.VITE_APP_VERSION');
    })
  );

  it(
    'binds the legal effective dates each native workflow is called with',
    withProductionFixture(() => {
      expect(iosSection()).toContain(
        'VITE_PRIVACY_POLICY_EFFECTIVE_DATE: ${{ inputs.privacy-policy-effective-date }}'
      );
      expect(androidSection()).toContain(
        'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE: ${{ inputs.terms-of-service-effective-date }}'
      );
    })
  );

  it(
    'binds no legal effective date to a stored secret, which none of them has',
    withProductionFixture(() => {
      const ios = iosSection();

      expect(ios).not.toContain('secrets.VITE_PRIVACY_POLICY_EFFECTIVE_DATE');
      expect(ios).not.toContain('secrets.VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE');
    })
  );

  it(
    'carries the same client secrets the pipeline generates the file from',
    withProductionFixture(() => {
      const ios = iosSection();

      expect(ios).toContain('VITE_VAPID_PUBLIC_KEY: ${{ secrets.VITE_VAPID_PUBLIC_KEY }}');
      expect(ios).toContain(
        'VITE_HELCIM_JS_TOKEN_PRODUCTION: ${{ secrets.VITE_HELCIM_JS_TOKEN_PRODUCTION }}'
      );
    })
  );

  it(
    'emits no backend secret, which the step it feeds never writes',
    withProductionFixture(() => {
      expect(androidSection()).not.toContain('RESEND_API_KEY');
    })
  );
});

/**
 * Production is the one mode with no committed environment file, so a job whose
 * build bakes one writes it first. The step's own env block is where every
 * value it writes comes from, and a hand-written one rots the next time the
 * registry changes.
 */
describe('production environment steps', () => {
  const generating = (): { file: string; text: string }[] =>
    yamlFilesUnder(GITHUB_DIR)
      .map((file) => ({
        file: path.relative(GITHUB_DIR, file),
        text: readFileSync(file, 'utf8'),
      }))
      .filter(({ text }) => text.includes('run: pnpm generate:env --mode=production'));

  it('draws its env from the generator in every workflow that writes the file', () => {
    const running = generating();
    expect(running.length).toBeGreaterThan(0);

    for (const { file, text } of running) {
      expect(
        /run: pnpm generate:env --mode=production\n(?:[ \t]*#.*\n)*[ \t]*# BEGIN GENERATED: production-env[\w-]*\n[ \t]*env:/.test(
          text
        ),
        `${file} generates the production environment file with an env block the generator does not own`
      ).toBe(true);
    }
  });

  it('verifies the file in every workflow that writes it', () => {
    const running = generating();
    expect(running.length).toBeGreaterThan(0);

    for (const { file, text } of running) {
      expect(
        text.includes('run: pnpm verify:env --mode=production'),
        `${file} writes the production environment file and nothing checks what it wrote`
      ).toBe(true);
    }
  });
});

describe('generate-headers.ts steps', () => {
  // generate-headers.ts fail-fasts on VITE_API_URL and SANDBOX_ORIGIN_URL, and the
  // steps that run it do so directly rather than through scripts/with-env.ts — so the
  // workflow env block is their only source, and a hand-written one silently rots the
  // next time the registry changes. Every such step must draw from the generator.
  it('draws its env from the generator in every workflow that runs it', () => {
    const workflowDir = path.resolve(__dirname, '../.github/workflows');
    const running = readdirSync(workflowDir)
      .filter((file) => file.endsWith('.yml'))
      .map((file) => ({ file, text: readFileSync(path.join(workflowDir, file), 'utf8') }))
      .filter(({ text }) => text.includes('scripts/generate-headers.ts'));

    expect(running.length).toBeGreaterThan(0);
    for (const { file, text } of running) {
      expect(
        // Free-standing comments may sit between the run line and the marker.
        /run: pnpm tsx scripts\/generate-headers\.ts\n(?:[ \t]*#.*\n)*[ \t]*# BEGIN GENERATED: headers-env\n[ \t]*env:/.test(
          text
        ),
        `${file} runs generate-headers.ts with an env block the generator does not own`
      ).toBe(true);
    }
  });
});

const GITHUB_DIR = path.resolve(__dirname, '../.github');

interface GeneratedBlock {
  marker: string;
  indent: number;
  line: number;
  body: string[];
}

function generatedBlocks(text: string): GeneratedBlock[] {
  const blocks: GeneratedBlock[] = [];
  let open: GeneratedBlock | undefined;

  for (const [index, line] of text.split('\n').entries()) {
    const begin = /^( *)# BEGIN GENERATED: (\S+)$/.exec(line);
    if (begin) {
      open = { marker: begin[2] ?? '', indent: (begin[1] ?? '').length, line: index + 1, body: [] };
    } else if (open === undefined) {
      continue;
    } else if (line.trim() === `# END GENERATED: ${open.marker}`) {
      blocks.push(open);
      open = undefined;
    } else {
      open.body.push(line);
    }
  }

  return blocks;
}

/** Column of the block's shallowest non-blank line; `undefined` when it holds none. */
function shallowestIndent(body: string[]): number | undefined {
  const indents = body
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  return indents.length > 0 ? Math.min(...indents) : undefined;
}

function yamlFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...yamlFilesUnder(full));
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      found.push(full);
    }
  }
  return found;
}

/** The major a version or range states, whatever prefix or precision it is written with. */
const statedMajor = (specifier: string): string => /^\D*(\d+)/.exec(specifier)?.[1] ?? specifier;

const NODE_TYPE_DEFINITIONS = '@types/node';

interface NodeManifest {
  devEngines?: { runtime?: { version?: string } };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** The Node majors one manifest states: its Node type definitions. */
function nodeMajorStatements(manifest: NodeManifest): { field: string; major: string }[] {
  const types = { ...manifest.dependencies, ...manifest.devDependencies }[NODE_TYPE_DEFINITIONS];

  return types === undefined ? [] : [{ field: NODE_TYPE_DEFINITIONS, major: statedMajor(types) }];
}

/**
 * Every statement of a Node major a manifest carries, read over the root manifest and
 * each workspace the workspace definition expands to. Derived rather than listed, so a
 * package added tomorrow is reconciled without anyone remembering to name it here.
 */
function nodeMajorsStated(root: string): { where: string; field: string; major: string }[] {
  return ['.', ...getWorkspacePaths(root)].flatMap((directory) => {
    const manifest = path.join(root, directory, 'package.json');

    return nodeMajorStatements(JSON.parse(readFileSync(manifest, 'utf8')) as NodeManifest).map(
      (statement) => ({ where: path.relative(root, manifest), ...statement })
    );
  });
}

/** The Node major the root manifest declares as the runtime this repository runs on. */
function declaredNodeMajor(root: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8')
  ) as NodeManifest;
  const version = manifest.devEngines?.runtime?.version;

  if (version === undefined) {
    throw new Error('the root manifest declares no devEngines runtime version');
  }

  return statedMajor(version);
}

/** Each statement that names a major the declared runtime does not, rendered for a reader. */
function nodeMajorDisagreements(root: string): string[] {
  const declared = declaredNodeMajor(root);

  return nodeMajorsStated(root)
    .filter((statement) => statement.major !== declared)
    .map(
      (statement) =>
        `${statement.where} ${statement.field} states ${statement.major}, ` +
        `the declared runtime states ${declared}`
    );
}

/**
 * Read against a tree of its own, because the reconciliation is green over a repository
 * that agrees and a reconciliation that reads nothing is green there too. The disagreeing
 * manifest is a workspace rather than the root, so the derivation from the workspace
 * definition is what has to reach it.
 */
describe('the Node major reconciliation', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'node-major-'));
    mkdirSync(path.join(root, 'tools'), { recursive: true });
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - tools\n');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', devEngines: { runtime: { name: 'node', version: '24.x' } } })
    );
    writeFileSync(
      path.join(root, 'tools', 'package.json'),
      JSON.stringify({ name: 'tools', devDependencies: { '@types/node': '^22.10.0' } })
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names a workspace manifest whose Node major is not the declared one', () => {
    expect(nodeMajorDisagreements(root)).toEqual([
      'tools/package.json @types/node states 22, the declared runtime states 24',
    ]);
  });
});

describe('automation invariants', () => {
  // A bare `wait` returns the status of the last job it reaped, so a step that backgrounds
  // several commands and then bares a `wait` reports success whenever that one happened to
  // succeed. Waiting per pid and checking each status is the only shape that can fail.
  it('never bares a `wait` in a workflow or a composite action', () => {
    const files = [
      ...yamlFilesUnder(path.join(GITHUB_DIR, 'workflows')),
      ...yamlFilesUnder(path.join(GITHUB_DIR, 'actions')),
    ];
    const bare: string[] = [];

    for (const file of files) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const code = line.trim();
        if (!code.startsWith('#') && /(?:^|[;&|]\s*)wait\s*(?:$|[;&|#])/.test(code)) {
          bare.push(`${path.relative(GITHUB_DIR, file)}:${String(index + 1)}`);
        }
      }
    }

    expect(files.length).toBeGreaterThan(0);
    expect(bare).toEqual([]);
  });

  // A tag or branch ref can be repointed by its owner after the reference was reviewed, so
  // only a full commit sha pins what actually runs. Local `./` actions come out of the
  // reviewed checkout and carry no ref to pin.
  it('pins every third-party action to a full commit sha', () => {
    const unpinned: string[] = [];
    let thirdParty = 0;

    for (const file of yamlFilesUnder(GITHUB_DIR)) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const used = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)?.[1]?.replaceAll(/^['"]|['"]$/g, '');
        if (used === undefined || used.startsWith('./')) continue;
        thirdParty += 1;
        if (!/@[0-9a-f]{40}$/.test(used)) {
          unpinned.push(`${path.relative(GITHUB_DIR, file)}:${String(index + 1)} ${used}`);
        }
      }
    }

    expect(thirdParty).toBeGreaterThan(0);
    expect(unpinned).toEqual([]);
  });

  // An expression is substituted into a run body as text before bash parses it,
  // so bash strips quotes and collapses backslashes in the value on the way
  // through. Binding it to the step's `env:` and reading `"$VAR"` hands bash the
  // bytes. No grandfathered exceptions: today's substitutions carry no
  // attacker-controllable data, and the next step someone copies is the one that
  // would.
  it('never substitutes a workflow expression into a run body', () => {
    const files = [
      ...yamlFilesUnder(path.join(GITHUB_DIR, 'workflows')),
      ...yamlFilesUnder(path.join(GITHUB_DIR, 'actions')),
    ];
    const substituted = files.flatMap((file) =>
      findRunExpressions(readFileSync(file, 'utf8')).map(
        (found) => `${path.relative(GITHUB_DIR, file)}:${String(found.line)} ${found.text}`
      )
    );

    expect(files.length).toBeGreaterThan(0);
    expect(substituted).toEqual([]);
  });

  // The platform flag is baked into the bundle at build time and is invisible in
  // the artifact afterwards, so a native job handed a bundle some other job
  // built ships whatever platform that job asked for — a web build inside an
  // App Store binary, which never leaves its splash screen. Building in the same
  // job as the sync is what makes the flag the job's own to set.
  it('builds the web bundle in the job that syncs it into a native project', () => {
    const syncing = yamlFilesUnder(path.join(GITHUB_DIR, 'workflows')).filter((file) =>
      readFileSync(file, 'utf8').includes('run: pnpm cap:sync ')
    );
    const unbuilt = syncing.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return !text.includes('run: pnpm --filter web build') || !text.includes('VITE_PLATFORM:');
    });

    expect(syncing.length).toBeGreaterThan(0);
    expect(unbuilt.map((file) => path.relative(GITHUB_DIR, file))).toEqual([]);
  });

  // A resolving install takes whatever the registry serves at the moment it runs, so
  // both bounds this repository puts on what it installs — the lockfile, and the
  // release-age delay that only deliberate resolution waits on — are skipped by an
  // install written without the frozen flag. Matched on the installer rather than on
  // the word, so a subcommand some other tool calls `install` reads as that tool's.
  it('replays the lockfile in every dependency install', () => {
    const resolving: string[] = [];
    let installs = 0;

    for (const file of yamlFilesUnder(GITHUB_DIR)) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const code = line.trim();
        if (code.startsWith('#') || !/(?<![\w-])pnpm\s+install(?![\w-])/.test(code)) continue;
        installs += 1;
        if (!code.includes('--frozen-lockfile')) {
          resolving.push(`${path.relative(GITHUB_DIR, file)}:${String(index + 1)} ${code}`);
        }
      }
    }

    expect(installs).toBeGreaterThan(0);
    expect(resolving).toEqual([]);
  });

  // A package runner with no refusing flag reaches the pinned workspace copy only
  // while local resolution succeeds. The day it stops, the runner downloads whatever
  // is published and runs that instead — no error, and no line in the log to tell the
  // two runs apart. Both spellings this toolchain offers, because a guard naming one
  // of them is stepped around by writing the other.
  it('reaches no tool through a package runner free to download it', () => {
    const files = yamlFilesUnder(GITHUB_DIR);
    const fetching: string[] = [];

    for (const file of files) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const code = line.trim();
        if (code.startsWith('#') || !/(?<![\w-])(?:npx|pnpm\s+dlx)(?![\w-])/.test(code)) continue;
        if (!/(?<![\w-])--no(?:-install)?(?![\w-])/.test(code)) {
          fetching.push(`${path.relative(GITHUB_DIR, file)}:${String(index + 1)} ${code}`);
        }
      }
    }

    expect(files.length).toBeGreaterThan(0);
    expect(fetching).toEqual([]);
  });

  // `devEngines.runtime` in the root manifest is the single declaration of the Node major
  // this repository runs on — so a manifest's Node type definitions edited without it, or
  // it edited without them, leaves those definitions describing a runtime nothing runs,
  // with no gate between the two. That is the mirrored constant `docs/CODE-RULES.md`
  // bans, and this is what reconciles it.
  it('states one Node major everywhere a manifest states one', () => {
    const root = path.resolve(__dirname, '..');
    const fields = nodeMajorsStated(root).map((statement) => statement.field);

    expect(fields).toContain(NODE_TYPE_DEFINITIONS);
    expect(nodeMajorDisagreements(root)).toEqual([]);
  });

  // An upload and the download that reads it are one matched pair, and a
  // download reading an artifact a different major produced is a failure that
  // only ever surfaces in the job that consumes it. One major across the tree is
  // what makes every pair matched by construction.
  it('names one major version of the artifact actions everywhere', () => {
    const majors = new Map<string, string[]>();

    for (const file of yamlFilesUnder(GITHUB_DIR)) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const used = /^\s*(?:-\s*)?uses:\s*actions\/(?:up|down)load-artifact@\S+\s*#\s*v(\d+)/.exec(
          line
        );
        if (used === null) continue;
        const major = used[1] ?? '';
        majors.set(major, [
          ...(majors.get(major) ?? []),
          `${path.relative(GITHUB_DIR, file)}:${String(index + 1)}`,
        ]);
      }
    }

    expect(majors.size).toBe(1);
  });

  // The renderer indents a block's content from its BEGIN marker, and Prettier
  // moves a marker comment onto the column of the mapping entries around it. A
  // block whose content sits deeper than its marker therefore gains two spaces
  // on every format-then-regenerate cycle, and the second cycle leaves mapping
  // items at two different columns — a workflow GitHub cannot parse, with no
  // gate between here and production.
  it('indents every generated block to the column of its own marker', () => {
    const files = yamlFilesUnder(GITHUB_DIR);

    const misaligned = files.flatMap((file) =>
      generatedBlocks(readFileSync(file, 'utf8'))
        .filter((block) => {
          const content = shallowestIndent(block.body);
          return content !== undefined && content !== block.indent;
        })
        .map(
          (block) =>
            `${path.relative(GITHUB_DIR, file)}:${String(block.line)} ${block.marker} ` +
            `marker at ${String(block.indent)}, content at ${String(shallowestIndent(block.body))}`
        )
    );

    expect(files.length).toBeGreaterThan(0);
    expect(misaligned).toEqual([]);
  });
});

// The deployed set holds a containment pair — DATABASE_URL is a substring of
// ADMIN_SQL_PANEL_DATABASE_URL — so a check matching anywhere in wrangler's
// listing passes while the secret the Worker needs is missing. `_` is a word
// character, so whole-word matching is what separates the two.
describe('the deploy secret check', () => {
  it('matches a secret name as a whole word', () => {
    const text = readFileSync(path.join(GITHUB_DIR, 'workflows/ci.yml'), 'utf8');

    expect(text).toContain('grep -qw "$secret"');
  });
});

describe('gitleaks-version section', () => {
  let gitleaksRoot = '';

  const withGitleaksFixture = fixtureRunner('hushbox-generate-env-gitleaks-', (root) => {
    gitleaksRoot = root;
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'emits the pinned scanner version from the shared constant',
    withGitleaksFixture(() => {
      const fixture = workflowFixture(() => gitleaksRoot);
      fixture.write(
        '.github/workflows/ci.yml',
        `name: CI
          # BEGIN GENERATED: gitleaks-version
          GITLEAKS_VERSION: '0.0.0'
          # END GENERATED: gitleaks-version
`
      );

      updateGeneratedFiles(gitleaksRoot);

      expect(fixture.read('.github/workflows/ci.yml')).toContain(
        `GITLEAKS_VERSION: '${GITLEAKS_VERSION}'`
      );
    })
  );

  // The allowlist in .gitleaks.toml depends on version-specific merge semantics,
  // so the engine CI installs must be the engine the local hook installs. The
  // workflow value is generated, which is what keeps the two from drifting.
  it('pins the scanner CI installs to the version the local hook installs', () => {
    const text = readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');

    expect(text).toContain(
      `# BEGIN GENERATED: gitleaks-version\n          GITLEAKS_VERSION: '${GITLEAKS_VERSION}'\n          # END GENERATED: gitleaks-version`
    );
  });
});

const CI_WORKFLOW = path.resolve(__dirname, '../.github/workflows/ci.yml');

const E2E_MATRIX_MARKER = 'e2e-matrix';

const indentOf = (line: string): number => line.search(/\S/);

/** How many times a phrase occurs in a text. */
const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1;

/**
 * The key enclosing a line — the nearest line above it at a smaller indent.
 *
 * Every walk that uses it is anchored on a line that names the thing under
 * test — the generated marker, or a step's own `- name:` — and steps outwards
 * from there, never on a structural key like `include:` or `steps:` scanned for
 * from the top of the file: the first one found can belong to an unrelated job,
 * and would decide which region a walk reads, reddening a test that has nothing
 * to say about that job. What a walk cannot find it names in the error, since
 * this fails at the moment a build breaks and the reader may know nothing of
 * how the walks are anchored.
 */
function enclosingKey(lines: string[], index: number): number {
  const inner = indentOf(lines[index] ?? '');
  for (let above = index - 1; above >= 0; above--) {
    const line = lines[above] ?? '';
    if (line.trim() !== '' && indentOf(line) < inner) return above;
  }
  throw new Error(
    `ci.yml: the "${(lines[index] ?? '').trim()}" line is at the top level, so the generated e2e matrix is not nested where this test expects it`
  );
}

/** Every line nested under the key at `index`. */
function linesUnder(lines: string[], index: number): string[] {
  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indentOf(lines[index] ?? '')) break;
    block.push(line);
  }
  return block;
}

/** The `matrix:` mapping that encloses the generated block. */
function e2eMatrixKey(lines: string[]): number {
  const begin = lines.findIndex((line) => line.includes(`# BEGIN GENERATED: ${E2E_MATRIX_MARKER}`));
  if (begin === -1) {
    throw new Error(
      `ci.yml has no "# BEGIN GENERATED: ${E2E_MATRIX_MARKER}" marker, so the e2e job matrix is no longer generated from the project registry`
    );
  }

  const matrix = enclosingKey(lines, enclosingKey(lines, begin));
  if (!/^\s*matrix:$/.test(lines[matrix] ?? '')) {
    throw new Error(
      `ci.yml: expected the generated e2e matrix to sit two levels under a "matrix:" key, found "${(lines[matrix] ?? '').trim()}"`
    );
  }
  return matrix;
}

/** Every line nested under that `matrix:` mapping. */
function e2eMatrixBlock(text: string): string[] {
  const lines = text.split('\n');
  return linesUnder(lines, e2eMatrixKey(lines));
}

/**
 * The job the generated matrix drives, and every line nested under it.
 *
 * Reached by walking out of that matrix rather than by naming the job, so the
 * job this reads and the job the registry fills cannot come apart. The `jobs:`
 * guard is what keeps the landing honest: a restructure that reparents the
 * matrix fails here rather than reading some inner mapping and finding nothing
 * to object to.
 */
function e2eJobBlock(text: string): string[] {
  const lines = text.split('\n');
  const job = enclosingKey(lines, enclosingKey(lines, e2eMatrixKey(lines)));
  const jobs = lines[enclosingKey(lines, job)] ?? '';
  if (!/^\s*jobs:$/.test(jobs)) {
    throw new Error(
      `ci.yml: expected the job holding the generated e2e matrix to be an entry of "jobs:", found it under "${jobs.trim()}"`
    );
  }
  return linesUnder(lines, job);
}

/**
 * How the e2e job's condition departs from the one it may carry:
 * {@link RUNS_PAST_SKIPS} and a success term per need it names, read off its
 * own `needs:`, and nothing else.
 */
function e2eConditionFaults(text: string): {
  readonly missing: string[];
  readonly unexpected: string[];
} {
  const job = e2eJobBlock(text);
  const allowed = [
    RUNS_PAST_SKIPS,
    ...needsOf(job).map((need) => `needs.${need}.result == 'success'`),
  ];
  const guard = immediateEntry(job, 'if');
  const carried =
    guard === undefined
      ? []
      : unwrappedGuard(guard)
          .split('&&')
          .map((conjunct) => conjunct.trim());
  return {
    missing: allowed.filter((conjunct) => !carried.includes(conjunct)),
    unexpected: carried.filter((conjunct) => !allowed.includes(conjunct)),
  };
}

/** The shipped workflow with one conjunct appended to the e2e job's allowed condition. */
function e2eConditionPlanted(conjunct: string): string {
  const text = ciWorkflow();
  const job = e2eJobBlock(text);
  const allowed = [
    RUNS_PAST_SKIPS,
    ...needsOf(job).map((need) => `needs.${need}.result == 'success'`),
  ].join(' && ');
  const lines = text.split('\n');
  const key = enclosingKey(lines, enclosingKey(lines, e2eMatrixKey(lines)));
  const indent = ' '.repeat(indentOf(lines[key] ?? '') + 2);
  const declared = job.findIndex((line) => line.startsWith(`${indent}if:`));
  const entry = `${indent}if: "${allowed} && ${conjunct}"`;
  const rewritten =
    declared === -1
      ? [...lines.slice(0, key + 1), entry, ...lines.slice(key + 1)]
      : lines.map((line, index) => (index === key + 1 + declared ? entry : line));
  return rewritten.join('\n');
}

/** The keys of a mapping — its immediate children, comments aside. */
function immediateKeys(block: string[]): string[] {
  const keyIndent = Math.min(
    ...block.filter((line) => line.trim() !== '').map((line) => indentOf(line))
  );
  return block.flatMap((line) => {
    const key = /^\s*([A-Za-z_][\w-]*):/.exec(line);
    return key !== null && indentOf(line) === keyIndent ? [key[1] ?? ''] : [];
  });
}

describe('e2e matrix sections', () => {
  let e2eMatrixRoot = '';

  const withE2eMatrixFixture = fixtureRunner('hushbox-generate-env-e2e-matrix-', (root) => {
    e2eMatrixRoot = root;
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'gives every registered project a CI job carrying its browser',
    withE2eMatrixFixture(() => {
      const fixture = workflowFixture(() => e2eMatrixRoot);
      fixture.write(
        '.github/workflows/ci.yml',
        `name: CI
          # BEGIN GENERATED: e2e-matrix
          # END GENERATED: e2e-matrix
`
      );

      updateGeneratedFiles(e2eMatrixRoot);

      const emitted = fixture.read('.github/workflows/ci.yml');
      for (const project of E2E_PROJECTS) {
        expect(emitted).toContain(
          `- project: ${project.name}\n            browser: ${project.browser}`
        );
      }
    })
  );

  // The drift gate, in the shape this repo has: regenerating the section over
  // the file on disk must be a no-op. A project added to the registry without
  // regenerating changes the emitted text and fails here.
  //
  // The sentinel render is load-bearing and is NOT the same as asserting both
  // marker lines are present: the renderer is a no-op on any region it cannot
  // match — markers deleted, or the two present but swapped — and a no-op
  // renderer makes the regeneration equality pass over anything hand-edited
  // inside.
  it.each([
    ['e2e-matrix', generateE2eMatrix],
    ['e2e-run-set', generateE2eRunSet],
  ])('keeps the %s block in ci.yml derived from the registry', (marker, generate) => {
    const onDisk = readFileSync(CI_WORKFLOW, 'utf8');

    expect(replaceSection(onDisk, marker, 'section-render-sentinel\n')).not.toBe(onDisk);
    expect(replaceSection(onDisk, marker, generate())).toBe(onDisk);
  });

  // Every entry has to come from inside the markers: one added outside them is
  // still an entry, it survives regeneration untouched, and duplicating a
  // project that way would silently double the engine-any work the carrier
  // election makes singular. Matching the sequence dash rather than
  // `- project:` also catches an entry that omits the key.
  it('takes every matrix entry from inside the generated block', () => {
    const block = e2eMatrixBlock(readFileSync(CI_WORKFLOW, 'utf8'));
    const begin = block.findIndex((line) =>
      line.includes(`# BEGIN GENERATED: ${E2E_MATRIX_MARKER}`)
    );
    const end = block.findIndex((line) => line.includes(`# END GENERATED: ${E2E_MATRIX_MARKER}`));

    expect(
      end,
      'the generated e2e matrix has no END marker below its BEGIN marker'
    ).toBeGreaterThan(begin);
    expect(
      block.flatMap((line, index) =>
        /^\s*-\s/.test(line) && (index < begin || index > end) ? [line.trim()] : []
      )
    ).toEqual([]);
  });

  // `include:` must be the matrix's only key. What a sibling would do to the
  // expansion is beside the point: it is a job-shaping input the generator did
  // not write. `exclude:` is the case worth naming — the registry carries no
  // opt-out field deliberately, because "this project skips X" is the shape of
  // hole it exists to close, so a genuine need gains a registry field and is
  // emitted inside the block.
  it('leaves include: as the only key under matrix:', () => {
    expect(immediateKeys(e2eMatrixBlock(readFileSync(CI_WORKFLOW, 'utf8')))).toEqual(['include']);
  });

  // The same hole one level up, and the quietest one: a job-level condition
  // removes a registry-declared job while the expansion still names every
  // project and the drift check still diffs clean, because a diff of the
  // generated spans cannot reach a key outside it. The registry is where a
  // project's participation is declared, so an event, repository or
  // trust-phase condition is refused for the reason `exclude:` is — a genuine
  // need gains a registry field and is emitted inside the block. The one
  // condition the job carries runs it past a skipped ancestor on the success
  // of the jobs it needs, which drops no project the build job admitted.
  it('gives the e2e job no condition beyond running on its needs\u2019 success', () => {
    expect(
      e2eConditionFaults(readFileSync(CI_WORKFLOW, 'utf8')),
      'the e2e job carries a condition beyond `!cancelled()` and its needs\u2019 success terms. An event, repository or trust-phase condition there drops registry-declared projects with the whole suite green: the matrix still names them and the drift check still diffs clean. Whether a project runs is declared in the registry, so a genuine need gains a registry field emitted inside the generated block.'
    ).toEqual({ missing: [], unexpected: [] });
  });

  it('reads an event conjunct planted on the e2e job as a condition of its own', () => {
    const planted = e2eConditionPlanted(`github.event_name == 'push'`);

    expect(e2eConditionFaults(planted).unexpected).toEqual(["github.event_name == 'push'"]);
  });

  it('reads a repository conjunct planted on the e2e job as a condition of its own', () => {
    const planted = e2eConditionPlanted('github.repository == vars.HB_PUBLIC_REPO');

    expect(e2eConditionFaults(planted).unexpected).toEqual([
      'github.repository == vars.HB_PUBLIC_REPO',
    ]);
  });

  // A hand-added job that runs the suite fails here. A hand-added matrix entry
  // carries no invocation line of its own; "takes every matrix entry from inside
  // the generated block" is what catches that one.
  it('invokes the e2e suite from one workflow step, the one the matrix drives', () => {
    const invocations = yamlFilesUnder(GITHUB_DIR).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('#') && /pnpm e2e(?![\w-])|playwright test\b/.test(line))
        .map((line) => `${path.relative(GITHUB_DIR, file)}: ${line}`)
    );

    expect(invocations).toEqual([
      'workflows/ci.yml: run: pnpm e2e --project="$E2E_PROJECT" --grep-invert "$E2E_GREP_INVERT"',
    ]);
  });
});

/**
 * The markers themselves, on disk.
 *
 * The generators refuse a file whose pairs are not the ones their sections
 * declare, so the declared-side assertions are that same fact read a step
 * earlier: they fail in the vitest job without either generator being run, and
 * they reach the ops dropdown, whose generator this suite never invokes. The
 * disk-side assertion runs the other direction and is asked by no generator —
 * a marker nothing declares is one neither generator ever looks for, so only a
 * sweep of every workflow file finds it. Every assertion derives its
 * expectations from the two generators that own markers — this file's section
 * map with its per-file ownership, plus the ops dropdown's marker and owners. A hand-written
 * list of which blocks must exist would rot the same way the blocks do, and the
 * ops pair is the one a hand-written list would have missed: it belongs to the
 * other generator.
 */
describe('generated markers on disk', () => {
  // An owner that is not on disk yet is skipped, as updateGeneratedFiles skips
  // it: ownership can be declared in the same change that writes the sections a
  // workflow will carry, before the workflow itself is written. What holds that
  // window closed is the workflow's own binding test, not this sweep.
  const workflowPaths = [...new Set([...WORKFLOW_FILES, DISPATCH_WORKFLOW_PATH])];
  const workflows = workflowPaths
    .map((relativePath) => ({
      relativePath,
      filePath: path.resolve(__dirname, '..', relativePath),
    }))
    .filter(({ filePath }) => existsSync(filePath))
    .map(({ relativePath, filePath }) => ({
      relativePath,
      text: readFileSync(filePath, 'utf8'),
    }));
  const ownership = new Map<string, readonly string[]>([
    ...Object.entries(workflowSections()).map(
      ([marker, section]) => [marker, section.owners] as [string, readonly string[]]
    ),
    [DISPATCH_OPTIONS_MARKER, DISPATCH_OPTIONS_OWNERS],
  ]);
  const markers = [...ownership.keys()];

  it('renders every generated section into exactly the pairs its ownership declares', () => {
    const mismatches = workflows.flatMap(({ relativePath, text }) =>
      markers.flatMap((marker) => {
        const declared = (ownership.get(marker) ?? []).filter(
          (owner) => owner === relativePath
        ).length;
        const found = occurrences(text, `# BEGIN GENERATED: ${marker}\n`);
        return declared === found
          ? []
          : [`${relativePath}: ${marker} — ${String(declared)} declared, ${String(found)} found`];
      })
    );

    expect(
      mismatches,
      'a declared pair that is not there regenerates into nothing, and a pair no declaration places is a block regeneration never reaches'
    ).toEqual([]);
  });

  // The other direction, and the only one that reaches a file no ownership
  // names: the two assertions around it ask whether each declared pair is where
  // it says it is, over the workflow files ownership lists. A marker nothing
  // declares — in any workflow, including the five neither generator writes —
  // is invisible to both, which is exactly the block a generator will never
  // rewrite again.
  it('declares every generated marker present under .github', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const undeclared = yamlFilesUnder(GITHUB_DIR).flatMap((file) => {
      const relativePath = path.relative(repoRoot, file);
      return [...readFileSync(file, 'utf8').matchAll(/^ *# BEGIN GENERATED: (\S+)$/gm)]
        .map((match) => match[1]!)
        .filter((marker) => !(ownership.get(marker) ?? []).includes(relativePath))
        .map((marker) => `${relativePath}: ${marker}`);
    });

    expect(
      undeclared,
      'a marker no section declares is a generated-looking block no generator reaches, frozen where it was written'
    ).toEqual([]);
  });

  // The workflow sweeps above read the `#` form; a Markdown owner carries its
  // pair as HTML comments, so it needs its own reading or is swept by nothing.
  it('carries every pair declared into a Markdown owner as HTML comments', () => {
    const markdownOwners = [...ownership].flatMap(([marker, owners]) =>
      [...new Set(owners.filter((owner) => owner.endsWith('.md')))].map((owner) => ({
        marker,
        owner,
        declared: owners.filter((candidate) => candidate === owner).length,
      }))
    );
    expect(markdownOwners).not.toEqual([]);

    const mismatches = markdownOwners.flatMap(({ marker, owner, declared }) => {
      const text = readFileSync(path.resolve(__dirname, '..', owner), 'utf8');
      const begins = occurrences(text, `<!-- BEGIN GENERATED: ${marker} -->\n`);
      const ends = occurrences(text, `<!-- END GENERATED: ${marker} -->`);
      return begins === declared && ends === declared
        ? []
        : [
            `${owner}: ${marker} — ${String(declared)} declared, ${String(begins)}/${String(ends)} found`,
          ];
    });

    expect(mismatches).toEqual([]);
  });

  it('keeps both markers of every pair, so no block escapes regeneration', () => {
    const unbalanced = workflows.flatMap(({ relativePath, text }) =>
      markers
        .map((marker) => ({
          marker,
          begins: occurrences(text, `# BEGIN GENERATED: ${marker}`),
          ends: occurrences(text, `# END GENERATED: ${marker}`),
        }))
        .filter(({ begins, ends }) => begins !== ends)
        .map(
          ({ marker, begins, ends }) =>
            `${relativePath}: ${marker} has ${String(begins)} BEGIN and ${String(ends)} END markers`
        )
    );

    expect(
      unbalanced,
      'a half-deleted marker pair leaves its block outside regeneration, where the drift gate cannot see it'
    ).toEqual([]);
  });
});

const SKILLS_STEP = 'Skills drift check';
const GENERATED_BLOCK_STEP = 'Generated block drift check';
/** The two trees the skills generator writes into: skills, then templated agents. */
const SKILLS_PATHSPEC = ['.claude/skills/', '.claude/agents/'];
const SKILLS_GENERATOR = 'pnpm generate:skills';

/** Those trees as enumeration roots, which take no trailing slash. */
const SKILLS_SUBJECT_ROOTS = SKILLS_PATHSPEC.map((tree) => tree.replace(/\/$/, ''));

/** The generator's own sidecar, the one path under those trees git may ignore. */
const SKILLS_SIDECAR = `${SKILLS_PATHSPEC[0] ?? ''}.cache/*`;

const MIGRATION_STEP = 'Drizzle migration drift check';
/** The borrow job's one working step, which is how a probe reaches that job. */
const BORROW_STEP = "Read staging's proof of this commit";
const MIGRATION_GENERATOR = 'pnpm --filter @hushbox/db db:generate';
const MIGRATION_PATHS = ['packages/db/drizzle/'];

const GENERATED_BLOCK_GENERATORS = ['pnpm generate:env', 'pnpm generate:ops-dispatch'];
const GENERATED_BLOCK_PATHS = ['.github/workflows/', 'apps/api/wrangler.toml', 'docs/SECRETS.md'];

/**
 * The line the named step opens on, refusing a step the workflow does not carry.
 *
 * The refusal sits here rather than in a caller because a deleted step is the
 * weakening this pin exists to catch, and every reading of it has to say so: a
 * walk handed the miss instead climbs out of the top of the file and reports a
 * shape nothing here asked about.
 */
function stepNamed(lines: string[], name: string): number {
  const step = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (step === -1) {
    throw new Error(
      `ci.yml has no "${name}" step, so the drift it gates is committed with nothing objecting`
    );
  }
  return step;
}

/** Every line of the named step's mapping. */
function driftStep(text: string, name: string): string[] {
  const lines = text.split('\n');
  return linesUnder(lines, stepNamed(lines, name));
}

/**
 * The `git status` a drift step measures: the shell variable it captures into,
 * and the pathspec it measures over. Both come out of the step's own command,
 * so a pathspec named anywhere else — the comment on the step, this test —
 * satisfies none of it.
 */
const DRIFT_MEASUREMENT = /^\s*([A-Za-z_]\w*)="\$\(git status --porcelain -- ([^)]+)\)"\s*$/;

interface DriftMeasurement {
  readonly variable: string;
  readonly pathspec: string[];
}

function driftMeasurement(block: string[]): DriftMeasurement | undefined {
  for (const line of block) {
    const found = DRIFT_MEASUREMENT.exec(line);
    if (found !== null) {
      return { variable: found[1] ?? '', pathspec: (found[2] ?? '').trim().split(/\s+/) };
    }
  }
  return undefined;
}

/**
 * Whether a non-empty measurement ends the run: the captured variable tested
 * non-empty, and a non-zero `exit` inside the branch that test opens. Read as
 * text rather than executed — `sh` is not a tool this repo's checks may assume
 * — so this judges the step's shape, never its behaviour.
 */
function endsTheRunOnDrift(block: string[]): boolean {
  const measured = driftMeasurement(block);
  if (measured === undefined) return false;

  const guard = new RegExp(String.raw`\[ +-n +"\$\{?${measured.variable}\}?" +\]`);
  const opened = block.findIndex((line) => guard.test(line));
  if (opened === -1) return false;

  const closed = block.findIndex((line, at) => at > opened && line.trim() === 'fi');
  if (closed === -1) return false;

  return block.slice(opened, closed).some((line) => /^\s*exit +[1-9]\d*\s*$/.test(line));
}

/**
 * The question the step puts to git before it measures: which tree it
 * enumerates, which path under that tree it leaves out, and the flags it asks
 * `git check-ignore` with.
 *
 * `git status` reports no untracked path an ignore rule covers, so a rule
 * reaching the skills tree costs this step exactly the half it exists for — a
 * committed deletion of a generated SKILL.md and a committed SKILL.template.md
 * whose SKILL.md was never committed both regenerate into untracked files the
 * rule keeps silent, while a tracked file regeneration modifies is still
 * reported. Asking git which paths under the measured tree it ignores is the
 * same question one layer earlier, and it is asked of git rather than of
 * `.gitignore`'s text: an effective ignore status is what blinds the
 * measurement, and no reading of that file's contents answers it.
 */
const IGNORED_SUBJECT_PROBE =
  /^\s*if find (.+?) -type f -not -path '([^']*)' \| git check-ignore ([^;]*); then\s*$/;

interface IgnoredSubjectProbe {
  readonly roots: string[];
  readonly excluded: string;
  readonly flags: string[];
}

function ignoredSubjectProbe(block: string[]): IgnoredSubjectProbe | undefined {
  for (const line of block) {
    const found = IGNORED_SUBJECT_PROBE.exec(line);
    if (found !== null) {
      return {
        roots: (found[1] ?? '').trim().split(/\s+/),
        excluded: found[2] ?? '',
        flags: (found[3] ?? '').trim().split(/\s+/),
      };
    }
  }
  return undefined;
}

/**
 * Whether that question is asked above the measurement it protects, with
 * `--no-index`, and answered by ending the run.
 *
 * `--no-index` is what makes the refusal fire on the rule rather than on the
 * drift the rule happens to be hiding: without it `git check-ignore` skips
 * every tracked path, so a rule over a fully committed tree reads clean and is
 * announced only once drift arrives — which is the moment the announcement is
 * worth least. Measured against a throwaway repository, not reasoned about.
 */
function refusesAnIgnoredSubject(block: string[]): boolean {
  const opened = block.findIndex((line) => IGNORED_SUBJECT_PROBE.test(line));
  if (opened === -1) return false;
  if (!(ignoredSubjectProbe(block)?.flags ?? []).includes('--no-index')) return false;

  const measured = block.findIndex((line) => DRIFT_MEASUREMENT.test(line));
  if (measured === -1 || opened > measured) return false;

  const closed = block.findIndex((line, at) => at > opened && line.trim() === 'fi');
  if (closed === -1) return false;

  return block.slice(opened, closed).some((line) => /^\s*exit +[1-9]\d*\s*$/.test(line));
}

/**
 * Whether the step regenerates before it measures.
 *
 * The order is the claim, not the presence: a step that measures first and
 * regenerates afterwards reads a tree the generator has not touched, so it
 * reports nothing while every line this pin reads is still there — a disarm
 * that costs the gate everything and shows in no other assertion. Presence
 * alone is a strictly weaker reading than the sentence it stands for.
 */
function runsGeneratorsFirst(
  block: string[],
  generators: readonly string[],
  measures: RegExp
): boolean {
  const measured = block.findIndex((line) => measures.test(line));
  if (measured === -1) return false;
  return generators.every((generator) => {
    const at = block.findIndex((line) => line.trim() === generator);
    return at !== -1 && at < measured;
  });
}

function regenerates(block: string[]): boolean {
  return runsGeneratorsFirst(block, [SKILLS_GENERATOR], DRIFT_MEASUREMENT);
}

/**
 * The `git diff` a drift step measures: the paths it diffs, and whatever it
 * falls back to when that diff reports a difference.
 *
 * `--exit-code` is inside the anchor rather than beside it, because it is what
 * makes the diff a measurement at all: without it `git diff` reports the
 * difference on stdout and exits 0, and the step passes over every drift it
 * just printed. The paths come out of the step's own command, so a path named
 * in the comment on the step satisfies none of it.
 */
const DIFF_MEASUREMENT = /^\s*git diff --exit-code\s+(.*)$/;

interface DiffMeasurement {
  readonly paths: string[];
  readonly fallback: string;
}

function diffMeasurement(block: string[]): DiffMeasurement | undefined {
  for (const line of block) {
    const found = DIFF_MEASUREMENT.exec(line);
    if (found === null) continue;
    const [scope = '', ...rest] = (found[1] ?? '').split('||');
    return {
      paths: scope.trim().split(/\s+/).filter(Boolean),
      fallback: rest.join('||').trim(),
    };
  }
  return undefined;
}

/**
 * Whether a difference ends the run.
 *
 * A step whose diff is its last command needs no fallback — the runner's shell
 * ends the step on the non-zero exit — so an absent fallback is the strong
 * shape rather than a missing one. What is read here is the fallback the step
 * does carry: an arm that reports the drift and ends the run keeps the gate, an
 * arm that swallows the exit turns a printed difference into a pass.
 */
function endsTheRunOnDiff(block: string[]): boolean {
  const measured = diffMeasurement(block);
  if (measured === undefined) return false;
  return measured.fallback === '' || /\bexit +[1-9]\d*\b/.test(measured.fallback);
}

/** The value of a mapping's own entry under `key`, comments and nesting aside. */
function immediateEntry(block: string[], key: string): string | undefined {
  const keyIndent = Math.min(
    ...block.filter((line) => line.trim() !== '').map((line) => indentOf(line))
  );
  const entry = block.find(
    (line) => indentOf(line) === keyIndent && new RegExp(String.raw`^\s*${key}:`).test(line)
  );
  return entry === undefined ? undefined : entry.slice(entry.indexOf(':') + 1).trim();
}

/**
 * A `github.repository` comparison, a term a job guard may be built from
 * without gating an event out.
 */
const REPOSITORY_SCOPE = /^github\.repository == vars\.\w+$/;

/** The job whose output selects a borrowed run, and the clause its dependants read it through. */
const BORROW_JOB = 'borrow';

/**
 * The borrow clause. It is false only where the borrow job wrote
 * `borrowed=true`, which that job's steps do on the deploying push alone —
 * pinned by `scripts/ci-workflow.test.ts` — so on a pull request the output is
 * empty and the clause holds. Admitted only beside a need on that job, since
 * without one the expression reads nothing and says nothing about the event.
 */
const BORROW_CLAUSE = "needs.borrow.outputs.borrowed != 'true'";

/**
 * The clause that keeps a dispatched run out of a check. It is false on a
 * `workflow_dispatch` alone, so on a pull request it holds.
 */
const DISPATCH_SKIP = "github.event_name != 'workflow_dispatch'";

/**
 * The one status function a guard may carry without gating an event out: it
 * holds on every event until the run is cancelled. Any other can gate —
 * `failure()` runs the job only past a failed need.
 */
const RUNS_PAST_SKIPS = '!cancelled()';

/**
 * A job guard with its YAML double quotes and GitHub's `${{ … }}` wrapper taken
 * off, where either encloses the whole guard.
 *
 * `if: expr`, `if: "expr"` and `if: ${{ expr }}` are the same guard in three
 * spellings — the quotes are YAML's, which a guard opening with `!` needs — so
 * a reading that treats them as different reddens on a rewording that gated
 * nothing out. A guard splicing an interpolation into a larger expression keeps
 * its braces, because that is not the same expression; a quoted guard carrying
 * an escape keeps it, and reddens.
 */
function unwrappedGuard(guard: string): string {
  const quoted = /^"(.*)"$/.exec(guard.trim());
  const unquoted = (quoted === null ? guard : (quoted[1] ?? '')).trim();
  const whole = /^\$\{\{(.*)\}\}$/.exec(unquoted);
  return (whole === null ? unquoted : (whole[1] ?? '')).trim();
}

/**
 * The conjuncts of a job guard this reading does not recognise as scoping the
 * run to a repository.
 *
 * A guard built only of `github.repository == vars.<NAME>` comparisons cannot
 * keep a pull request out: in every repository it admits, every event reaches
 * the job. A conjunct deciding something else gates the job, and with it both
 * drift checks, while every step inside them still reads exactly as it shipped
 * — the one weakening a step-level reading is structurally unable to see,
 * which is why the guard is read whole rather than searched for the two
 * expressions that spell it most obviously.
 *
 * It is an allowlist, and its cost is measured rather than assumed: a guard
 * that scopes the run to a repository some other way reddens too.
 * `github.repository == '<owner>/<repo>'` and
 * `github.repository_owner == '<owner>'` gate no event out, and nothing here
 * can tell them from a conjunct that does — so what reddens is a review, and
 * the assertion message claims only that. The `${{ … }}` wrapper and YAML's
 * double quotes are the equivalent spellings normalised away instead of
 * reviewed, since each is the same expression written another way rather than a
 * different guard. Beside the repository comparisons it admits
 * {@link RUNS_PAST_SKIPS}, which gates no event out, {@link DISPATCH_SKIP},
 * which gates out a dispatch alone, and {@link BORROW_CLAUSE} beside a need on
 * the borrow job. Splitting on `&&` without honouring parentheses can only over-split a
 * nested guard, so the reading errs towards more conjuncts to justify, never
 * fewer.
 */
function unrecognisedGuardConjuncts(
  guard: string | undefined,
  needs: readonly string[] = []
): string[] {
  if (guard === undefined) return [];
  return unwrappedGuard(guard)
    .split('&&')
    .filter((conjunct) => conjunct.trim() !== RUNS_PAST_SKIPS && conjunct.trim() !== DISPATCH_SKIP)
    .map((conjunct) => conjunct.replaceAll('(', '').replaceAll(')', '').trim())
    .filter((conjunct) => !(conjunct === BORROW_CLAUSE && needs.includes(BORROW_JOB)))
    .filter(
      (conjunct) => !conjunct.split('||').every((term) => REPOSITORY_SCOPE.test(term.trim()))
    );
}

/** The jobs a job's `needs:` names, in either inline shape; any other shape refuses. */
function needsOf(job: string[]): string[] {
  const value = immediateEntry(job, 'needs');
  if (value === undefined) return [];
  const list = /^\[(.*)\]$/.exec(value);
  if (list !== null) {
    return (list[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  if (/^[\w-]+$/.test(value)) return [value];
  throw new Error(
    `ci.yml: a job's needs are written as "${value}", a shape this reading cannot walk, so it cannot say which jobs a pull request waits on`
  );
}

/** A job's mapping, found by the name another job's `needs:` gives it. */
function namedJob(lines: string[], name: string): string[] {
  const jobs = lines.indexOf('jobs:');
  const job = lines.findIndex((line, at) => at > jobs && line === `  ${name}:`);
  if (jobs === -1 || job === -1) {
    throw new Error(`ci.yml has no "${name}" job, which a job's needs name`);
  }
  return linesUnder(lines, job);
}

/**
 * The needs of a job that can keep a pull request from it. A skipped need
 * skips its dependant, so a need is harmless only where it too starts on every
 * pull request: by this file's reading, a guard it recognises and needs that
 * pass the same test.
 */
function needsGatingPullRequests(lines: string[], job: string[]): string[] {
  return needsOf(job).filter((name) => {
    const needed = namedJob(lines, name);
    return (
      unrecognisedGuardConjuncts(immediateEntry(needed, 'if'), needsOf(needed)).length > 0 ||
      needsGatingPullRequests(lines, needed).length > 0
    );
  });
}

/** The `jobs:` entry holding the named step, refusing anything else. */
function jobHolding(lines: string[], name: string): number {
  const steps = enclosingKey(lines, stepNamed(lines, name));
  if (!/^\s*steps:$/.test(lines[steps] ?? '')) {
    throw new Error(
      `ci.yml: expected the "${name}" step to sit under a "steps:" key, found "${(lines[steps] ?? '').trim()}"`
    );
  }

  const job = enclosingKey(lines, steps);
  const jobs = lines[enclosingKey(lines, job)] ?? '';
  if (!/^\s*jobs:$/.test(jobs)) {
    throw new Error(
      `ci.yml: expected the job holding the "${name}" step to be an entry of "jobs:", found it under "${jobs.trim()}"`
    );
  }
  return job;
}

/** The mapping of the job holding the named step. */
function jobBlock(text: string, name: string): string[] {
  const lines = text.split('\n');
  return linesUnder(lines, jobHolding(lines, name));
}

/** The mapping of the job holding the skills step. */
function skillsJobBlock(text: string): string[] {
  return jobBlock(text, SKILLS_STEP);
}

const ciWorkflow = (): string => readFileSync(CI_WORKFLOW, 'utf8');

/**
 * The pin on the gate that pins every generated block.
 *
 * Read at the standard `describe('the skills drift check')` is read at, rather
 * than the one it shipped with: that reading checked the step existed and
 * diffed `apps/api/wrangler.toml`, and left the step's failure condition, both
 * of its generator invocations, the rest of its scope and the job it sits in
 * with nothing holding them. The two gates guard the same class of drift, so a
 * reader comparing them would have taken the weaker one for the standard.
 *
 * WHAT THIS COVERS. The step exists under that name; it runs both generators
 * before it measures; it diffs exactly the two paths it is the only gate over;
 * a difference ends the run; the step carries neither a condition that could
 * skip it nor a `continue-on-error` that would absorb its failure; and its job
 * needs only jobs that themselves start on every pull request, absorbs no
 * failure of its own and carries a guard built of nothing but
 * `github.repository == vars.<NAME>` comparisons and, beside a need on the
 * borrow job, the borrow clause, under a workflow the `pull_request` event
 * triggers.
 *
 * `apps/api/wrangler.toml` is the path the scope reading is really about: it
 * carries no generated markers, so nothing but this step's argument list
 * decides whether its regenerated `[vars]` block is diffed at all. It is named
 * in the comment on that step too, which is why the scope is read out of the
 * step's own command — a mention anywhere else satisfies none of it.
 *
 * WHAT THIS DOES NOT COVER, on the same terms as its sibling: the step's
 * behaviour, since every assertion reads text and none runs it; an `on:` filter
 * that keeps pull requests off the workflow selectively; and whether the
 * generators still render what they should, which is this file's other
 * describes' subject. It needs no reading of the ignore rules its sibling
 * carries, and that asymmetry is a fact about the instrument rather than an
 * omission: `git diff` reads the index and the work tree, so it never consults
 * an ignore rule and no rule can narrow what it reports.
 */
describe('the generated block drift check', () => {
  it('regenerates both generated surfaces before it measures drift', () => {
    expect(
      runsGeneratorsFirst(
        driftStep(ciWorkflow(), GENERATED_BLOCK_STEP),
        GENERATED_BLOCK_GENERATORS,
        DIFF_MEASUREMENT
      ),
      'the generated block drift check no longer runs both of its generators above its diff, so it compares committed text against a tree the missing generator never rewrote and passes over that generator whole'
    ).toBe(true);
  });

  it('diffs the generated wrangler config and the secrets document alongside the workflows', () => {
    expect(
      diffMeasurement(driftStep(ciWorkflow(), GENERATED_BLOCK_STEP))?.paths,
      'the drift check no longer diffs exactly the workflow tree, apps/api/wrangler.toml — whose regenerated [vars] block sits inside no marker pair and so is reached by no other gate — and docs/SECRETS.md, whose inventory block no workflow diff reaches'
    ).toEqual(GENERATED_BLOCK_PATHS);
  });

  it('ends the run when that diff reports a difference', () => {
    expect(
      endsTheRunOnDiff(driftStep(ciWorkflow(), GENERATED_BLOCK_STEP)),
      'the generated block drift check no longer ends the run on a difference, so it prints the drift and passes'
    ).toBe(true);
  });

  it('carries no condition of its own that could skip it', () => {
    expect(immediateKeys(driftStep(ciWorkflow(), GENERATED_BLOCK_STEP))).not.toContain('if');
  });

  it('does not absorb its own failure', () => {
    expect(immediateKeys(driftStep(ciWorkflow(), GENERATED_BLOCK_STEP))).not.toContain(
      'continue-on-error'
    );
  });

  it('sits in a job no pull request is gated out of', () => {
    const lines = ciWorkflow().split('\n');
    const job = linesUnder(lines, jobHolding(lines, GENERATED_BLOCK_STEP));

    expect(immediateKeys(linesUnder(lines, lines.indexOf('on:')))).toContain('pull_request');
    expect(
      needsGatingPullRequests(lines, job),
      'the job holding the drift checks waits on a job a pull request can be kept from, and a skipped need skips its dependant'
    ).toEqual([]);
    expect(
      unrecognisedGuardConjuncts(immediateEntry(job, 'if'), needsOf(job)),
      'the job holding the generated block drift check carries a guard this reading does not recognise: it admits `github.repository == vars.<NAME>` comparisons, `!cancelled()`, the clause keeping a dispatch out, and the borrow clause beside a need on the borrow job, and nothing else, because those alone keep no pull request out. What is unrecognised may be a conjunct that keeps a pull request out of the check while every step in it reads clean, or the same repository scope spelled another way — this reads the guard, never the settings behind it, so it reddens on both and a reader decides which one it is'
    ).toEqual([]);
  });

  it('sits in a job that does not absorb its failure', () => {
    expect(
      immediateKeys(jobBlock(ciWorkflow(), GENERATED_BLOCK_STEP)),
      'the job holding the generated block drift check now swallows its own failure, so the step exits non-zero and the run passes regardless'
    ).not.toContain('continue-on-error');
  });
});

/**
 * The pin on the gate that pins every generated skill.
 *
 * This step shipped with nothing holding it: it could be deleted, its pathspec
 * narrowed, its generator invocation dropped or its failure branch neutered,
 * and every gate in the repository stayed green. The `Generated block drift
 * check` step is read at this same standard by
 * `describe('the generated block drift check')` — the two gates guard the same
 * class of drift, and a reader comparing them should not find one of them
 * pinned harder than the other.
 *
 * WHAT THIS COVERS. The step exists under that name; it regenerates before it
 * measures; it refuses to measure a subject git ignores, over the whole skills
 * tree bar the generator's own sidecar; it measures `git status --porcelain`
 * over exactly the skills tree; a non-empty measurement reaches a non-zero
 * exit; the step carries neither a condition that could skip it nor a
 * `continue-on-error` that would absorb its failure; and it sits in the same
 * job as its generated-block sibling — a job that needs only jobs that
 * themselves start on every pull request, absorbs no failure of its own, and
 * carries a guard built of nothing but `github.repository == vars.<NAME>`
 * comparisons and, beside a need on the borrow job, the borrow clause, wrapped
 * in `${{ … }}` or not — under a workflow the `pull_request` event triggers.
 * The job half matters
 * as much as the step half: a conjunct on the job's guard, or a
 * `continue-on-error` on the job, gates or swallows both drift checks while
 * every line of both steps reads as it shipped.
 *
 * The refusal is what an ignore rule reaching this tree would otherwise cost,
 * and the cost is asymmetric rather than total: a TRACKED generated file that
 * regeneration modifies is still reported despite such a rule, while a
 * committed deletion of a generated SKILL.md and a committed SKILL.template.md
 * whose SKILL.md was never committed both regenerate into untracked files the
 * rule keeps `git status` silent about. Those two are the whole reason this
 * step measures with `git status` rather than the `git diff --exit-code` its
 * two siblings use, so a rule over this tree used to reduce it to their
 * strength without a word. What the step reads is git's answer about the paths
 * it measures, never `.gitignore`'s text: the text is a rule set whose effect
 * depends on precedence, negation and every other ignore file, and only the
 * effect blinds the measurement.
 *
 * WHAT THIS DOES NOT COVER, so the next reader does not over-trust it —
 *
 *   - the step's BEHAVIOUR. Every assertion here reads the step's text; none
 *     runs it. A command that parses as this shape and does something else is
 *     invisible to all of it;
 *   - an `on:` filter that keeps pull requests off the workflow selectively — a
 *     `paths-ignore` under `pull_request:`, say. The trigger is read as present,
 *     never as unfiltered. The syntactic guard reading is also not the
 *     reachability walk `ci-workflow.test.ts` runs for the credential boundary;
 *   - whether the generator itself still regenerates what it should, which is
 *     `scripts/skills/generate-skills.test.ts`'s subject, not this one.
 */
describe('the skills drift check', () => {
  it('regenerates every skill before it measures drift', () => {
    expect(
      regenerates(driftStep(ciWorkflow(), SKILLS_STEP)),
      'the skills drift check no longer runs its generator above its measurement, so it measures a tree the generator has not touched and reports nothing at all while every line of the step reads as it shipped'
    ).toBe(true);
  });

  it('measures drift over the whole skills tree and the agents tree', () => {
    expect(
      driftMeasurement(driftStep(ciWorkflow(), SKILLS_STEP))?.pathspec,
      'the skills drift check no longer measures exactly the trees the generator writes into, so committed drift outside its pathspec ships unopposed'
    ).toEqual(SKILLS_PATHSPEC);
  });

  it('ends the run when that measurement is non-empty', () => {
    expect(
      endsTheRunOnDrift(driftStep(ciWorkflow(), SKILLS_STEP)),
      'the skills drift check no longer exits non-zero on drift, so it prints the drift and passes'
    ).toBe(true);
  });

  it('refuses to measure a tree git ignores', () => {
    expect(
      refusesAnIgnoredSubject(driftStep(ciWorkflow(), SKILLS_STEP)),
      'the skills drift check no longer refuses a subject git ignores, so an ignore rule reaching the skills tree costs it the untracked drift it measures with git status to catch and it exits 0 on a committed deletion of a generated skill'
    ).toBe(true);
  });

  it('asks that question over the whole tree bar the generator sidecar', () => {
    const probe = ignoredSubjectProbe(driftStep(ciWorkflow(), SKILLS_STEP));

    expect(probe?.roots, 'the refusal no longer enumerates the trees the step measures').toEqual(
      SKILLS_SUBJECT_ROOTS
    );
    expect(
      probe?.excluded,
      'the refusal leaves out more than the generator sidecar, so a rule over the paths it stopped enumerating passes it unmentioned'
    ).toBe(SKILLS_SIDECAR);
  });

  it('carries no condition of its own that could skip it', () => {
    expect(immediateKeys(driftStep(ciWorkflow(), SKILLS_STEP))).not.toContain('if');
  });

  it('does not absorb its own failure', () => {
    expect(immediateKeys(driftStep(ciWorkflow(), SKILLS_STEP))).not.toContain('continue-on-error');
  });

  it('runs in the job its generated-block sibling runs in', () => {
    const lines = ciWorkflow().split('\n');

    expect(
      jobHolding(lines, SKILLS_STEP),
      'the two drift checks have come apart, so one of them now sits in a job whose guard nothing here reads'
    ).toBe(jobHolding(lines, GENERATED_BLOCK_STEP));
  });

  it('sits in a job no pull request is gated out of', () => {
    const lines = ciWorkflow().split('\n');
    const job = linesUnder(lines, jobHolding(lines, SKILLS_STEP));

    expect(immediateKeys(linesUnder(lines, lines.indexOf('on:')))).toContain('pull_request');
    expect(
      needsGatingPullRequests(lines, job),
      'the job holding the drift checks waits on a job a pull request can be kept from, and a skipped need skips its dependant'
    ).toEqual([]);
    expect(
      unrecognisedGuardConjuncts(immediateEntry(job, 'if'), needsOf(job)),
      'the job holding both drift checks carries a guard this reading does not recognise: it admits `github.repository == vars.<NAME>` comparisons, `!cancelled()`, the clause keeping a dispatch out, and the borrow clause beside a need on the borrow job, and nothing else, because those alone keep no pull request out. What is unrecognised may be a conjunct that keeps a pull request out of both drift checks while every step in them reads clean, or the same repository scope spelled another way — this reads the guard, never the settings behind it, so it reddens on both and a reader decides which one it is'
    ).toEqual([]);
  });

  it('sits in a job that does not absorb its failure', () => {
    expect(
      immediateKeys(skillsJobBlock(ciWorkflow())),
      'the job holding both drift checks now swallows its own failure, so the step exits non-zero and the run passes regardless'
    ).not.toContain('continue-on-error');
  });
});

/**
 * The pin on the gate that keeps the migration set matching the schema.
 *
 * `docs/BUILD-AND-CI.md` states this as a CI gate — an uncommitted
 * `packages/db/drizzle/` diff fails the build — while the step itself shipped
 * with nothing holding it: it could be deleted, its scope narrowed, its
 * generator dropped or its failure swallowed, and every gate in the repository
 * stayed green. Its two neighbours in the same job are read at this standard by
 * `describe('the generated block drift check')` and
 * `describe('the skills drift check')` — the three guard the same class of
 * drift, and a reader comparing them should not find one of them pinned less
 * hard than the others.
 *
 * WHAT THIS COVERS. The step exists under that name; it regenerates before it
 * measures; it diffs exactly the directory the generator writes; a difference
 * ends the run; the step carries neither a condition that could skip it nor a
 * `continue-on-error` that would absorb its failure; and its job needs only
 * jobs that themselves start on every pull request, absorbs no failure of its
 * own and carries a guard built of nothing but `github.repository ==
 * vars.<NAME>` comparisons and, beside a need on the borrow job, the borrow
 * clause, under a workflow the `pull_request` event triggers.
 *
 * WHAT THIS DOES NOT COVER, on the same terms as its two neighbours: the step's
 * behaviour, since every assertion reads text and none runs it; an `on:` filter
 * that keeps pull requests off the workflow selectively; and whether the
 * generator still renders the migration the schema asks for, which is the db
 * package's subject rather than this one. Like the generated-block reading and
 * unlike the skills one it asks nothing about ignore rules, and that asymmetry
 * is a fact about the instrument rather than an omission: `git diff` reads the
 * index and the work tree, so it consults no ignore rule and no rule can narrow
 * what it reports.
 */
describe('the Drizzle migration drift check', () => {
  it('regenerates the migration set before it measures drift', () => {
    expect(
      runsGeneratorsFirst(
        driftStep(ciWorkflow(), MIGRATION_STEP),
        [MIGRATION_GENERATOR],
        DIFF_MEASUREMENT
      ),
      'the migration drift check no longer runs its generator above its diff, so it compares committed migrations against a schema the generator never read and passes over every schema edit'
    ).toBe(true);
  });

  it('diffs the directory the generator writes', () => {
    expect(
      diffMeasurement(driftStep(ciWorkflow(), MIGRATION_STEP))?.paths,
      'the migration drift check no longer diffs exactly the migration directory, so a schema edit whose generated output lands outside its scope ships with nothing objecting'
    ).toEqual(MIGRATION_PATHS);
  });

  it('ends the run when that diff reports a difference', () => {
    expect(
      endsTheRunOnDiff(driftStep(ciWorkflow(), MIGRATION_STEP)),
      'the migration drift check no longer ends the run on a difference, so it prints the drift and passes'
    ).toBe(true);
  });

  it('carries no condition of its own that could skip it', () => {
    expect(immediateKeys(driftStep(ciWorkflow(), MIGRATION_STEP))).not.toContain('if');
  });

  it('does not absorb its own failure', () => {
    expect(immediateKeys(driftStep(ciWorkflow(), MIGRATION_STEP))).not.toContain(
      'continue-on-error'
    );
  });

  it('sits in a job no pull request is gated out of', () => {
    const lines = ciWorkflow().split('\n');
    const job = linesUnder(lines, jobHolding(lines, MIGRATION_STEP));

    expect(immediateKeys(linesUnder(lines, lines.indexOf('on:')))).toContain('pull_request');
    expect(
      needsGatingPullRequests(lines, job),
      'the job holding the drift checks waits on a job a pull request can be kept from, and a skipped need skips its dependant'
    ).toEqual([]);
    expect(
      unrecognisedGuardConjuncts(immediateEntry(job, 'if'), needsOf(job)),
      'the job holding the migration drift check carries a guard this reading does not recognise: it admits `github.repository == vars.<NAME>` comparisons, `!cancelled()`, the clause keeping a dispatch out, and the borrow clause beside a need on the borrow job, and nothing else, because those alone keep no pull request out. What is unrecognised may be a conjunct that keeps a pull request out of the check while every step in it reads clean, or the same repository scope spelled another way — this reads the guard, never the settings behind it, so it reddens on both and a reader decides which one it is'
    ).toEqual([]);
  });

  it('sits in a job that does not absorb its failure', () => {
    expect(
      immediateKeys(jobBlock(ciWorkflow(), MIGRATION_STEP)),
      'the job holding the migration drift check now swallows its own failure, so the step exits non-zero and the run passes regardless'
    ).not.toContain('continue-on-error');
  });
});

/**
 * The skills-drift reading, shown against a step weakened each way it can be
 * weakened.
 *
 * A pin whose assertions cannot be made to fail is indistinguishable from one
 * that reads nothing, and reading the shipped file proves only the green half.
 * Each weakening is derived from the shipped text rather than written out here,
 * so a fixture cannot drift from the step it stands for; {@link weakened}
 * refuses an anchor the file does not carry exactly once, which keeps both a
 * probe that silently applied to nothing and one that applied to a
 * same-worded line in another step from reading as a pass.
 */
function weakened(from: string, to: string): string {
  const text = ciWorkflow();
  const carried = occurrences(text, from);
  if (carried !== 1) {
    throw new Error(
      `ci.yml carries ${JSON.stringify(from)} ${String(carried)} times, so this probe would prove nothing: a replace of the first copy of text the file words twice measures whichever step reaches it first`
    );
  }
  return text.replace(from, to);
}

/**
 * The shipped workflow with the job holding `step` carrying `key: value` —
 * rewriting the entry the job declares, adding one where it declares none.
 *
 * Walked to rather than quoted, so a renamed job or a reworded guard cannot
 * leave a probe applying to nothing; refusing a no-op is what stops a weakening
 * that changed the file in no way from reading as a pass.
 *
 * The step is named by the caller rather than fixed at the skills step, because
 * a probe that always mutates the skills step's job measures that job whatever
 * job the case is about — and three steps read here sit in one job today, which
 * is a fact about the file rather than a property anything holds.
 */
function jobWeakened(key: string, value: string, step: string = SKILLS_STEP): string {
  const lines = ciWorkflow().split('\n');
  const job = jobHolding(lines, step);
  const indent = indentOf(lines[job] ?? '') + 2;
  const declared = linesUnder(lines, job).findIndex(
    (line) => indentOf(line) === indent && new RegExp(String.raw`^\s*${key}:`).test(line)
  );
  const entry = `${' '.repeat(indent)}${key}: ${value}`;
  const rewritten =
    declared === -1
      ? [...lines.slice(0, job + 1), entry, ...lines.slice(job + 1)]
      : lines.map((line, at) => (at === job + 1 + declared ? entry : line));

  if (rewritten.join('\n') === lines.join('\n')) {
    throw new Error(
      `ci.yml already carries "${key}: ${value}" on that job, so this probe would prove nothing`
    );
  }
  return rewritten.join('\n');
}

/**
 * The shipped workflow with one step's mapping rewritten, every other byte of
 * the file left where it was.
 *
 * Scoping a probe to the step it is about is what keeps a whole-file replace
 * from landing in a neighbouring step that words a line the same way — the
 * migration check's `git diff --exit-code`, the four other steps running
 * `pnpm generate:env`. Refusing a rewrite that changed nothing is the same
 * guard {@link weakened} carries: a probe that applied to nothing reads exactly
 * like a reading with nothing to object to.
 */
function stepBlockRewritten(name: string, rewrite: (block: string[]) => string[]): string {
  const lines = ciWorkflow().split('\n');
  const step = stepNamed(lines, name);
  const block = linesUnder(lines, step);
  const rewritten = rewrite(block);
  if (rewritten.join('\n') === block.join('\n')) {
    throw new Error(
      `ci.yml: the "${name}" step is unchanged by this probe, so it would prove nothing`
    );
  }
  return [...lines.slice(0, step + 1), ...rewritten, ...lines.slice(step + 1 + block.length)].join(
    '\n'
  );
}

/**
 * The shipped workflow with the one line of a step carrying `anchor` rewritten,
 * or dropped where `replacement` is undefined.
 *
 * The anchor is required to occur exactly once in the step: a probe anchored on
 * text the step words twice edits whichever copy comes first, which changes the
 * file, passes every guard built for a probe that applied to nothing, and
 * measures a line other than the one the case names.
 */
function withStepLine(name: string, anchor: string, replacement?: string): string {
  return stepBlockRewritten(name, (block) => {
    const carrying = block.filter((line) => line.includes(anchor));
    if (carrying.length !== 1) {
      throw new Error(
        `ci.yml: the "${name}" step carries ${JSON.stringify(anchor)} ${String(carrying.length)} times, so a probe anchored on it would measure a line other than the one it names`
      );
    }
    return block.flatMap((line) => {
      if (!line.includes(anchor)) return [line];
      return replacement === undefined ? [] : [line.replace(anchor, replacement)];
    });
  });
}

/**
 * The shipped workflow with one whole command dropped from a step.
 *
 * Matched on the whole line rather than on a substring of it, because a step
 * that names its generators in its own failure message carries each of those
 * commands twice — once as the command and once inside the echo — and a
 * substring probe drops whichever comes first. Which is not the line any case
 * here is about, and every guard written for a probe that applied to nothing
 * passes it.
 */
function withoutStepCommand(name: string, command: string): string {
  return stepBlockRewritten(name, (block) => {
    const carrying = block.filter((line) => line.trim() === command);
    if (carrying.length !== 1) {
      throw new Error(
        `ci.yml: the "${name}" step runs ${JSON.stringify(command)} ${String(carrying.length)} times, so dropping it would prove nothing about the one this case names`
      );
    }
    return block.filter((line) => line.trim() !== command);
  });
}

/**
 * The shipped workflow with the skills step's generator moved below its
 * measurement, every other byte of the step left where it was.
 *
 * The two lines are swapped in place rather than quoted, so a reworded command
 * cannot leave the probe applying to nothing; refusing a step that does not
 * already run the generator above the measurement is what stops a swap that
 * moved nothing from reading as a pass.
 */
function generatorMovedBelowMeasurement(): string {
  return stepBlockRewritten(SKILLS_STEP, (block) => {
    const generator = block.findIndex((line) => line.trim() === SKILLS_GENERATOR);
    const measured = block.findIndex((line) => DRIFT_MEASUREMENT.test(line));
    if (generator === -1 || measured === -1 || generator > measured) {
      throw new Error(
        `ci.yml does not run ${SKILLS_GENERATOR} above its measurement, so this probe would prove nothing`
      );
    }
    return block.map((line, at) => {
      if (at === generator) return block[measured] ?? '';
      if (at === measured) return block[generator] ?? '';
      return line;
    });
  });
}

/**
 * The shipped workflow with the skills step's ignore refusal moved below the
 * measurement it protects, the refusal itself left word for word.
 *
 * Moved whole rather than deleted, because the weakening this stands for is the
 * order: a refusal that runs after the measurement has already reported nothing
 * cannot stop the measurement being believed, while every line of it still
 * reads as it shipped.
 */
function refusalMovedBelowMeasurement(): string {
  return stepBlockRewritten(SKILLS_STEP, (block) => {
    const opened = block.findIndex((line) => IGNORED_SUBJECT_PROBE.test(line));
    const closed = block.findIndex((line, at) => at > opened && line.trim() === 'fi');
    const measured = block.findIndex((line) => DRIFT_MEASUREMENT.test(line));
    if (opened === -1 || closed === -1 || measured === -1 || opened > measured) {
      throw new Error(
        'ci.yml does not refuse an ignored subject above its measurement, so this probe would prove nothing'
      );
    }

    const refusal = block.slice(opened, closed + 1);
    const without = [...block.slice(0, opened), ...block.slice(closed + 1)];
    const below = without.findIndex((line) => DRIFT_MEASUREMENT.test(line));
    return [...without.slice(0, below + 1), ...refusal, ...without.slice(below + 1)];
  });
}

/**
 * The shipped workflow with the ignore refusal's own exit turned into a zero.
 *
 * Walked to inside the refusal's `if … fi` rather than anchored on the text,
 * because the step words `exit 1` twice — once in that refusal and once in the
 * branch the drift measurement opens — and a text probe would neuter whichever
 * came first while every guard for a probe that applied to nothing still passed.
 */
function refusalExitNeutered(): string {
  return stepBlockRewritten(SKILLS_STEP, (block) => {
    const opened = block.findIndex((line) => IGNORED_SUBJECT_PROBE.test(line));
    const closed = block.findIndex((line, at) => at > opened && line.trim() === 'fi');
    const exits = block
      .slice(opened, closed)
      .findIndex((line) => /^\s*exit +[1-9]\d*\s*$/.test(line));
    if (opened === -1 || closed === -1 || exits === -1) {
      throw new Error(
        'ci.yml does not end the run inside its ignore refusal, so this probe would prove nothing'
      );
    }
    return block.map((line, at) =>
      at === opened + exits ? line.replace(/exit +[1-9]\d*/, 'exit 0') : line
    );
  });
}

describe('the skills-drift reading of a weakened step', () => {
  it('refuses a probe whose anchor the workflow does not carry', () => {
    expect(() => weakened('- name: No such step', '')).toThrow('would prove nothing');
  });

  it('finds no step once the step is renamed away', () => {
    expect(() =>
      driftStep(weakened(`- name: ${SKILLS_STEP}`, '- name: Something else'), SKILLS_STEP)
    ).toThrow(`has no "${SKILLS_STEP}" step`);
  });

  it('reads a pathspec dropping the agents tree as narrower than the measured trees', () => {
    const narrowed = weakened(
      `--porcelain -- ${SKILLS_PATHSPEC.join(' ')})`,
      `--porcelain -- ${SKILLS_PATHSPEC[0] ?? ''})`
    );

    expect(driftMeasurement(driftStep(narrowed, SKILLS_STEP))?.pathspec).not.toEqual(
      SKILLS_PATHSPEC
    );
  });

  it('reads an inverted guard as not ending the run', () => {
    const inverted = weakened('if [ -n "$DRIFT" ]; then', 'if [ -z "$DRIFT" ]; then');

    expect(endsTheRunOnDrift(driftStep(inverted, SKILLS_STEP))).toBe(false);
  });

  it('reads a zero exit as not ending the run', () => {
    const passing = weakened(
      'and commit."\n            exit 1',
      'and commit."\n            exit 0'
    );

    expect(endsTheRunOnDrift(driftStep(passing, SKILLS_STEP))).toBe(false);
  });

  it('refuses a job weakening the workflow already carries', () => {
    const guard = immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '';

    expect(() => jobWeakened('if', guard)).toThrow('would prove nothing');
  });

  it('reads a job guard conjunct beyond the repository as gating the job', () => {
    const guard = unwrappedGuard(immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '');
    const gated = skillsJobBlock(
      jobWeakened('if', `"${guard} && vars.HB_RUN_DRIFT_CHECKS == 'true'"`)
    );

    expect(unrecognisedGuardConjuncts(immediateEntry(gated, 'if'), needsOf(gated))).toEqual([
      "vars.HB_RUN_DRIFT_CHECKS == 'true'",
    ]);
  });

  it('reads the clause keeping a dispatch out as gating no pull request out', () => {
    const guard = unwrappedGuard(immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '');
    const unkept = guard.replace(` && ${DISPATCH_SKIP}`, '');
    const kept = skillsJobBlock(jobWeakened('if', `"${unkept} && ${DISPATCH_SKIP}"`));

    expect(unrecognisedGuardConjuncts(immediateEntry(kept, 'if'), needsOf(kept))).toEqual([]);
  });

  it('reads the clause keeping pull requests out as gating the job', () => {
    const guard = unwrappedGuard(immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '');
    const gated = skillsJobBlock(
      jobWeakened('if', `"${guard} && github.event_name != 'pull_request'"`)
    );

    expect(unrecognisedGuardConjuncts(immediateEntry(gated, 'if'), needsOf(gated))).toEqual([
      "github.event_name != 'pull_request'",
    ]);
  });

  it('reads a ${{ }}-wrapped repository guard as the guard it wraps', () => {
    const guard = unwrappedGuard(immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '');
    const wrapped = skillsJobBlock(jobWeakened('if', `\${{ ${guard} }}`));

    expect(unrecognisedGuardConjuncts(immediateEntry(wrapped, 'if'), needsOf(wrapped))).toEqual([]);
  });

  it('reads a double-quoted guard as the guard it quotes', () => {
    const guard = unwrappedGuard(immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '');
    const quoted = skillsJobBlock(
      jobWeakened('if', `"${guard} && vars.HB_RUN_DRIFT_CHECKS == 'true'"`)
    );

    expect(unrecognisedGuardConjuncts(immediateEntry(quoted, 'if'), needsOf(quoted))).toEqual([
      "vars.HB_RUN_DRIFT_CHECKS == 'true'",
    ]);
  });

  it('reads a status function that runs the job only past a failure as gating the job', () => {
    const guard = unwrappedGuard(immediateEntry(skillsJobBlock(ciWorkflow()), 'if') ?? '');
    const failing = skillsJobBlock(jobWeakened('if', `"${guard} && failure()"`));

    expect(unrecognisedGuardConjuncts(immediateEntry(failing, 'if'), needsOf(failing))).toEqual([
      'failure',
    ]);
  });

  // The allowlist's ruled cost, pinned so it is read as a decision rather than
  // an oversight: this guard scopes the run to one repository and gates no
  // event out, and the reading reddens on it anyway because nothing here can
  // tell it from a guard that does.
  it('reads a repository comparison against a literal as unrecognised', () => {
    const literal = skillsJobBlock(jobWeakened('if', "github.repository == 'owner/repo'"));

    expect(unrecognisedGuardConjuncts(immediateEntry(literal, 'if'), needsOf(literal))).toEqual([
      "github.repository == 'owner/repo'",
    ]);
  });

  it('reads a job that absorbs its failure as carrying continue-on-error', () => {
    const absorbing = jobWeakened('continue-on-error', 'true');

    expect(immediateKeys(skillsJobBlock(absorbing))).toContain('continue-on-error');
  });

  it.each([GENERATED_BLOCK_STEP, SKILLS_STEP, MIGRATION_STEP])(
    'reads the borrow clause without a need on the borrow job as gating the job holding the %s',
    (step) => {
      const unneeded = jobBlock(jobWeakened('needs', '[]', step), step);

      expect(unrecognisedGuardConjuncts(immediateEntry(unneeded, 'if'), needsOf(unneeded))).toEqual(
        [BORROW_CLAUSE]
      );
    }
  );

  it.each([GENERATED_BLOCK_STEP, SKILLS_STEP, MIGRATION_STEP])(
    'reads a need on a job no pull request starts as gating the job holding the %s',
    (step) => {
      const text = jobWeakened('needs', `[${BORROW_JOB}, build]`, step);

      expect(needsGatingPullRequests(text.split('\n'), jobBlock(text, step))).toEqual(['build']);
    }
  );

  it.each([GENERATED_BLOCK_STEP, SKILLS_STEP, MIGRATION_STEP])(
    'reads the borrow job kept from pull requests as gating the job holding the %s',
    (step) => {
      const borrowGuard = immediateEntry(jobBlock(ciWorkflow(), BORROW_STEP), 'if') ?? '';
      const text = jobWeakened(
        'if',
        `${borrowGuard} && github.event_name != 'pull_request'`,
        BORROW_STEP
      );

      expect(needsGatingPullRequests(text.split('\n'), jobBlock(text, step))).toEqual([BORROW_JOB]);
    }
  );

  it('refuses a needs shape it cannot walk rather than reading it as waiting on nothing', () => {
    const text = jobWeakened('needs', '${{ fromJSON(vars.NEEDS) }}');

    expect(() => needsGatingPullRequests(text.split('\n'), skillsJobBlock(text))).toThrow(
      'cannot walk'
    );
  });

  it('refuses to name a job for a step the workflow no longer carries', () => {
    const renamed = weakened(`- name: ${SKILLS_STEP}`, '- name: Something else').split('\n');

    expect(() => jobHolding(renamed, SKILLS_STEP)).toThrow(`has no "${SKILLS_STEP}" step`);
  });

  it('reads a dropped generator invocation as absent', () => {
    const dropped = weakened(`          ${SKILLS_GENERATOR}\n`, '');

    expect(regenerates(driftStep(dropped, SKILLS_STEP))).toBe(false);
  });

  it('reads a generator invoked below the measurement as not regenerating first', () => {
    expect(regenerates(driftStep(generatorMovedBelowMeasurement(), SKILLS_STEP))).toBe(false);
  });

  it('refuses a step-scoped probe whose anchor the step does not carry', () => {
    expect(() => withStepLine(SKILLS_STEP, 'no such command')).toThrow('0 times');
  });

  it('reads a dropped ignore refusal as not refusing', () => {
    const dropped = withStepLine(SKILLS_STEP, 'git check-ignore', '# nothing to ask');

    expect(refusesAnIgnoredSubject(driftStep(dropped, SKILLS_STEP))).toBe(false);
  });

  it('reads an ignore refusal below the measurement as not refusing', () => {
    expect(refusesAnIgnoredSubject(driftStep(refusalMovedBelowMeasurement(), SKILLS_STEP))).toBe(
      false
    );
  });

  it('reads a refusal that asks the index rather than the rules as not refusing', () => {
    const indexed = withStepLine(SKILLS_STEP, ' --no-index', '');

    expect(refusesAnIgnoredSubject(driftStep(indexed, SKILLS_STEP))).toBe(false);
  });

  it('reads a refusal that exits zero as not refusing', () => {
    expect(refusesAnIgnoredSubject(driftStep(refusalExitNeutered(), SKILLS_STEP))).toBe(false);
  });

  it('reads a refusal enumerating the skills tree alone as not asking about every tree', () => {
    const narrowed = withStepLine(
      SKILLS_STEP,
      `if find ${SKILLS_SUBJECT_ROOTS.join(' ')} `,
      `if find ${SKILLS_SUBJECT_ROOTS[0] ?? ''} `
    );

    expect(ignoredSubjectProbe(driftStep(narrowed, SKILLS_STEP))?.roots).not.toEqual(
      SKILLS_SUBJECT_ROOTS
    );
  });

  it('reads a refusal that leaves out the whole tree as leaving out more than the sidecar', () => {
    const hollowed = withStepLine(SKILLS_STEP, `-not -path '${SKILLS_SIDECAR}'`, "-not -path '*'");

    expect(ignoredSubjectProbe(driftStep(hollowed, SKILLS_STEP))?.excluded).not.toBe(
      SKILLS_SIDECAR
    );
  });
});

/**
 * The generated-block reading, shown against a step weakened each way it can be
 * weakened.
 *
 * Every weakening is scoped to the step's own mapping rather than replaced
 * across the file, because this step's every command is worded again elsewhere
 * in the workflow: four other steps run `pnpm generate:env`, and the
 * `Drizzle migration drift check` step runs its own `git diff --exit-code`. A
 * file-wide replace of any of them lands somewhere other than the step the
 * case names.
 */
describe('the generated-block reading of a weakened step', () => {
  it('finds no step once the step is renamed away', () => {
    expect(() =>
      driftStep(
        weakened(`- name: ${GENERATED_BLOCK_STEP}`, '- name: Something else'),
        GENERATED_BLOCK_STEP
      )
    ).toThrow(`has no "${GENERATED_BLOCK_STEP}" step`);
  });

  it.each(GENERATED_BLOCK_GENERATORS)('reads %s dropped as not regenerating first', (generator) => {
    const dropped = withoutStepCommand(GENERATED_BLOCK_STEP, generator);

    expect(
      runsGeneratorsFirst(
        driftStep(dropped, GENERATED_BLOCK_STEP),
        GENERATED_BLOCK_GENERATORS,
        DIFF_MEASUREMENT
      )
    ).toBe(false);
  });

  it('reads a generator invoked below the diff as not regenerating first', () => {
    const below = stepBlockRewritten(GENERATED_BLOCK_STEP, (block) => {
      const generator = block.findIndex((line) => line.trim() === GENERATED_BLOCK_GENERATORS[0]);
      const measured = block.findIndex((line) => DIFF_MEASUREMENT.test(line));
      return block.map((line, at) => {
        if (at === generator) return block[measured] ?? '';
        if (at === measured) return block[generator] ?? '';
        return line;
      });
    });

    expect(
      runsGeneratorsFirst(
        driftStep(below, GENERATED_BLOCK_STEP),
        GENERATED_BLOCK_GENERATORS,
        DIFF_MEASUREMENT
      )
    ).toBe(false);
  });

  it('reads a diff without --exit-code as measuring nothing', () => {
    const reporting = withStepLine(GENERATED_BLOCK_STEP, 'git diff --exit-code', 'git diff');

    expect(diffMeasurement(driftStep(reporting, GENERATED_BLOCK_STEP))).toBeUndefined();
    expect(endsTheRunOnDiff(driftStep(reporting, GENERATED_BLOCK_STEP))).toBe(false);
  });

  it.each(GENERATED_BLOCK_PATHS)(
    'reads %s dropped from the scope as a narrower scope',
    (dropped) => {
      const narrowed = withStepLine(GENERATED_BLOCK_STEP, `${dropped} `, '');

      expect(diffMeasurement(driftStep(narrowed, GENERATED_BLOCK_STEP))?.paths).not.toEqual(
        GENERATED_BLOCK_PATHS
      );
    }
  );

  it('reads a scope narrowed to one workflow as narrower than the workflow tree', () => {
    const oneFile = withStepLine(
      GENERATED_BLOCK_STEP,
      `${GENERATED_BLOCK_PATHS[0] ?? ''} `,
      `${GENERATED_BLOCK_PATHS[0] ?? ''}ci.yml `
    );

    expect(diffMeasurement(driftStep(oneFile, GENERATED_BLOCK_STEP))?.paths).not.toEqual(
      GENERATED_BLOCK_PATHS
    );
  });

  it('reads a swallowed difference as not ending the run', () => {
    const swallowed = stepBlockRewritten(GENERATED_BLOCK_STEP, (block) =>
      block.map((line) => {
        const measured = DIFF_MEASUREMENT.exec(line);
        if (measured === null) return line;
        return `${line.split('||')[0] ?? ''}|| true`;
      })
    );

    expect(endsTheRunOnDiff(driftStep(swallowed, GENERATED_BLOCK_STEP))).toBe(false);
  });

  it('reads a step condition as one that could skip it', () => {
    const skippable = stepBlockRewritten(GENERATED_BLOCK_STEP, (block) => [
      `${' '.repeat(indentOf(block[0] ?? ''))}if: \${{ vars.HB_RUN_DRIFT_CHECKS == 'true' }}`,
      ...block,
    ]);

    expect(immediateKeys(driftStep(skippable, GENERATED_BLOCK_STEP))).toContain('if');
  });

  it('reads a step that absorbs its failure as carrying continue-on-error', () => {
    const absorbing = stepBlockRewritten(GENERATED_BLOCK_STEP, (block) => [
      `${' '.repeat(indentOf(block[0] ?? ''))}continue-on-error: true`,
      ...block,
    ]);

    expect(immediateKeys(driftStep(absorbing, GENERATED_BLOCK_STEP))).toContain(
      'continue-on-error'
    );
  });

  it('reads a job guard conjunct beyond the repository as gating the job', () => {
    const guard = unwrappedGuard(
      immediateEntry(jobBlock(ciWorkflow(), GENERATED_BLOCK_STEP), 'if') ?? ''
    );
    const gated = jobBlock(
      jobWeakened('if', `"${guard} && vars.HB_RUN_DRIFT_CHECKS == 'true'"`),
      GENERATED_BLOCK_STEP
    );

    expect(unrecognisedGuardConjuncts(immediateEntry(gated, 'if'), needsOf(gated))).toEqual([
      "vars.HB_RUN_DRIFT_CHECKS == 'true'",
    ]);
  });

  it('reads a job that absorbs its failure as carrying continue-on-error', () => {
    const absorbing = jobWeakened('continue-on-error', 'true');

    expect(immediateKeys(jobBlock(absorbing, GENERATED_BLOCK_STEP))).toContain('continue-on-error');
  });
});

/**
 * The migration-drift reading, shown against a step weakened each way it can be
 * weakened.
 *
 * Every weakening is scoped to the step's own mapping rather than replaced
 * across the file, for the reason its generated-block neighbour gives: this
 * step's `git diff --exit-code` is worded again in that neighbour, and a
 * file-wide replace of it lands in whichever step comes first.
 */
describe('the migration-drift reading of a weakened step', () => {
  it('finds no step once the step is renamed away', () => {
    expect(() =>
      driftStep(weakened(`- name: ${MIGRATION_STEP}`, '- name: Something else'), MIGRATION_STEP)
    ).toThrow(`has no "${MIGRATION_STEP}" step`);
  });

  it('reads a dropped generator invocation as not regenerating first', () => {
    const dropped = withoutStepCommand(MIGRATION_STEP, MIGRATION_GENERATOR);

    expect(
      runsGeneratorsFirst(
        driftStep(dropped, MIGRATION_STEP),
        [MIGRATION_GENERATOR],
        DIFF_MEASUREMENT
      )
    ).toBe(false);
  });

  it('reads a generator invoked below the diff as not regenerating first', () => {
    const below = stepBlockRewritten(MIGRATION_STEP, (block) => {
      const generator = block.findIndex((line) => line.trim() === MIGRATION_GENERATOR);
      const measured = block.findIndex((line) => DIFF_MEASUREMENT.test(line));
      return block.map((line, at) => {
        if (at === generator) return block[measured] ?? '';
        if (at === measured) return block[generator] ?? '';
        return line;
      });
    });

    expect(
      runsGeneratorsFirst(driftStep(below, MIGRATION_STEP), [MIGRATION_GENERATOR], DIFF_MEASUREMENT)
    ).toBe(false);
  });

  it('reads a diff without --exit-code as measuring nothing', () => {
    const reporting = withStepLine(MIGRATION_STEP, 'git diff --exit-code', 'git diff');

    expect(diffMeasurement(driftStep(reporting, MIGRATION_STEP))).toBeUndefined();
    expect(endsTheRunOnDiff(driftStep(reporting, MIGRATION_STEP))).toBe(false);
  });

  it('reads a scope moved off the migration directory as a different scope', () => {
    const elsewhere = withStepLine(
      MIGRATION_STEP,
      `${MIGRATION_PATHS[0] ?? ''} `,
      'packages/db/schema/ '
    );

    expect(diffMeasurement(driftStep(elsewhere, MIGRATION_STEP))?.paths).not.toEqual(
      MIGRATION_PATHS
    );
  });

  it('reads a swallowed difference as not ending the run', () => {
    const swallowed = stepBlockRewritten(MIGRATION_STEP, (block) =>
      block.map((line) => {
        const measured = DIFF_MEASUREMENT.exec(line);
        if (measured === null) return line;
        return `${line.split('||')[0] ?? ''}|| true`;
      })
    );

    expect(endsTheRunOnDiff(driftStep(swallowed, MIGRATION_STEP))).toBe(false);
  });

  it('reads a step condition as one that could skip it', () => {
    const skippable = stepBlockRewritten(MIGRATION_STEP, (block) => [
      `${' '.repeat(indentOf(block[0] ?? ''))}if: \${{ vars.HB_RUN_DRIFT_CHECKS == 'true' }}`,
      ...block,
    ]);

    expect(immediateKeys(driftStep(skippable, MIGRATION_STEP))).toContain('if');
  });

  it('reads a step that absorbs its failure as carrying continue-on-error', () => {
    const absorbing = stepBlockRewritten(MIGRATION_STEP, (block) => [
      `${' '.repeat(indentOf(block[0] ?? ''))}continue-on-error: true`,
      ...block,
    ]);

    expect(immediateKeys(driftStep(absorbing, MIGRATION_STEP))).toContain('continue-on-error');
  });

  it('reads a job guard conjunct beyond the repository as gating the job', () => {
    const guard = unwrappedGuard(
      immediateEntry(jobBlock(ciWorkflow(), MIGRATION_STEP), 'if') ?? ''
    );
    const gated = jobBlock(
      jobWeakened('if', `"${guard} && vars.HB_RUN_DRIFT_CHECKS == 'true'"`, MIGRATION_STEP),
      MIGRATION_STEP
    );

    expect(unrecognisedGuardConjuncts(immediateEntry(gated, 'if'), needsOf(gated))).toEqual([
      "vars.HB_RUN_DRIFT_CHECKS == 'true'",
    ]);
  });

  it('reads a job that absorbs its failure as carrying continue-on-error', () => {
    const absorbing = jobWeakened('continue-on-error', 'true', MIGRATION_STEP);

    expect(immediateKeys(jobBlock(absorbing, MIGRATION_STEP))).toContain('continue-on-error');
  });
});

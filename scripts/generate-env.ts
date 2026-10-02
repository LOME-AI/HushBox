import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadManifest, type OpsManifest } from '@hushbox/ops/generate-labels';
import {
  envConfig,
  Destination,
  Mode,
  isSecret,
  isProductionSecret,
  getDestinations,
  resolveValue,
  resolveRaw,
  type EnvMode,
  type VariableConfig,
} from '../packages/shared/src/env/env.config.js';
import { CI_SECRETS } from '../packages/shared/src/env/ci-secrets.js';
import {
  runbookPath,
  type Credential,
  type SecretStore,
} from '../packages/shared/src/env/env-types.js';
import { BACKUP_VARIABLES } from './lib/backup/run.js';
import { ESCROW_BUCKET_ENV_NAMES } from './lib/escrow/upload.js';
import { composeProjectName, getWorktreeConfig } from './lib/cli/worktree.js';
import { portEnvName } from './lib/stack/dev-ports.js';
import { stagedWriteSync } from './lib/staged-write.js';
import { portsFor, SERVICE_KEYS, type ServiceKey, type StackMode } from './lib/stack/port-plan.js';
import {
  frontendModeFor,
  isPerCheckoutMode,
  stackModeFor,
  writesStackFiles,
} from './lib/stack/stack-mode.js';
import {
  STACK_BUCKET_LIST_VARIABLE,
  STACK_BUCKET_VARIABLES,
  applyStackBucket,
  stackBucketList,
} from './lib/stack/stack-bucket.js';
import { composeEnvValues } from './lib/stack/compose-env.js';
import { applyStackDatabase } from './lib/stack/stack-database.js';
import { SURFACE_ORIGINS } from './lib/deployed-surfaces.js';
import { generateE2eMatrix, generateE2eRunSet } from './lib/playwright/e2e-workflow-sections.js';
import { GITLEAKS_VERSION } from './lib/privacy/gitleaks.js';
import { isMainModule } from './lib/cli/is-main.js';
import { parseCommandLine, readCommandLine, type CommandSpec } from './lib/cli/command-line.js';

export const WORKFLOW_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/build-android.yml',
  '.github/workflows/build-ios.yml',
  '.github/workflows/run-ops-script.yml',
  '.github/workflows/escrow-secrets.yml',
  '.github/workflows/backup.yml',
] as const;

/** The secrets document; its prose is hand-written, its inventory table generated. */
export const SECRETS_DOC = 'docs/SECRETS.md';

/** The checkout this generator belongs to, where the ops manifest it reads lives. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Every committed file that carries a generated block. */
export const GENERATED_FILES = [...WORKFLOW_FILES, SECRETS_DOC] as const;

type GeneratedFile = (typeof GENERATED_FILES)[number];

const [
  CI_WORKFLOW,
  ANDROID_WORKFLOW,
  IOS_WORKFLOW,
  OPS_DISPATCH_WORKFLOW,
  ESCROW_WORKFLOW,
  BACKUP_WORKFLOW,
] = WORKFLOW_FILES;

/**
 * Where a section renders: one entry per marker pair, so a file holding two
 * pairs of the same marker is listed twice. The tuple is non-empty by type,
 * which is what makes a section owned by nothing a compile error rather than a
 * block that generates into no file at all.
 */
type SectionOwners = readonly [GeneratedFile, ...GeneratedFile[]];

interface GeneratedSection {
  readonly owners: SectionOwners;
  readonly content: string;
}

/**
 * Where the deploy's version comes from, in the expression a workflow reads it
 * with. One spelling behind every step that binds it: the Worker's own version,
 * the client bundles the build bakes, and the production environment file the
 * build generates all carry the same string, and a second spelling of it is a
 * second answer to what version is deployed.
 */
const VERSION_JOB_OUTPUT = '${{ needs.version.outputs.version }}';

/**
 * Where each published legal effective date comes from in the deploy pipeline,
 * in the expression a workflow reads it with. One spelling behind every step
 * that binds it, for the reason {@link VERSION_JOB_OUTPUT} states: the dates the
 * marketing pages render and the ones the app bundle renders are the same
 * answer, and a second spelling of either is a second answer to when a document
 * took effect.
 */
const LEGAL_DATE_JOB_OUTPUTS: Record<string, string> = {
  VITE_PRIVACY_POLICY_EFFECTIVE_DATE: '${{ needs.version.outputs.privacy_policy_effective_date }}',
  VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE:
    '${{ needs.version.outputs.terms_of_service_effective_date }}',
};

/**
 * The same two dates where no version job exists to read them off. Each native
 * workflow is a single job taking its values as workflow inputs, so it binds the
 * inputs its caller derived — the reason {@link PRODUCTION_ENV_VARIANTS} gives
 * for the version.
 */
const LEGAL_DATE_WORKFLOW_INPUTS: Record<string, string> = {
  VITE_PRIVACY_POLICY_EFFECTIVE_DATE: '${{ inputs.privacy-policy-effective-date }}',
  VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE: '${{ inputs.terms-of-service-effective-date }}',
};

/**
 * Build variants for release workflows.
 * Each variant overrides specific frontend env vars in the generated build-env section.
 * Keys not in the overrides map use the default envConfig production values.
 */
const BUILD_VARIANTS: Record<string, { owners: SectionOwners; overrides: Record<string, string> }> =
  {
    'build-env': {
      owners: [CI_WORKFLOW],
      overrides: { VITE_APP_VERSION: VERSION_JOB_OUTPUT, ...LEGAL_DATE_JOB_OUTPUTS },
    },
    // Per-platform OTA bundles built in one CI step; the shell loop supplies
    // VITE_PLATFORM per iteration, overriding this block's base value.
    'build-env-mobile': {
      owners: [CI_WORKFLOW],
      overrides: { VITE_APP_VERSION: VERSION_JOB_OUTPUT, ...LEGAL_DATE_JOB_OUTPUTS },
    },
    // Each native job builds its own bundle: the platform flag is compiled into
    // the JavaScript, so a bundle built elsewhere carries that build's platform
    // into this one's artifact with no other symptom.
    'build-env-ios': {
      owners: [IOS_WORKFLOW],
      overrides: {
        VITE_PLATFORM: 'ios',
        VITE_APP_VERSION: '${{ inputs.version }}',
        ...LEGAL_DATE_WORKFLOW_INPUTS,
      },
    },
    'build-env-android': {
      owners: [ANDROID_WORKFLOW],
      overrides: {
        VITE_PLATFORM: '${{ inputs.vite-platform }}',
        VITE_APP_VERSION: '${{ inputs.version }}',
        ...LEGAL_DATE_WORKFLOW_INPUTS,
      },
    },
  };

/**
 * Per-platform variants of the production environment block, declared the way
 * the build variants above are. Each native workflow is a single job that takes
 * the version as a workflow input, so the version-job expression the pipeline's
 * own block binds resolves to nothing there and the step exits naming the
 * version as a missing required value.
 */
const PRODUCTION_ENV_VARIANTS: Record<
  string,
  { owners: SectionOwners; overrides: Record<string, string> }
> = {
  'production-env': {
    owners: [CI_WORKFLOW],
    overrides: { VITE_APP_VERSION: VERSION_JOB_OUTPUT, ...LEGAL_DATE_JOB_OUTPUTS },
  },
  'production-env-ios': {
    owners: [IOS_WORKFLOW],
    overrides: { VITE_APP_VERSION: '${{ inputs.version }}', ...LEGAL_DATE_WORKFLOW_INPUTS },
  },
  'production-env-android': {
    owners: [ANDROID_WORKFLOW],
    overrides: { VITE_APP_VERSION: '${{ inputs.version }}', ...LEGAL_DATE_WORKFLOW_INPUTS },
  },
};

/**
 * Build variants whose step runs the whole-workspace `turbo build` rather than
 * only the web bundle. That build also assembles the sandbox origin's dist,
 * which bakes ESM_CDN_URL into its `/config.js` and fail-fasts when the value
 * is absent — so those steps must carry the variable, while the web-only
 * variants must not (an unread variable in a build block is noise).
 */
const WORKSPACE_BUILD_VARIANTS: ReadonlySet<string> = new Set(['build-env']);

/**
 * The per-platform OTA bundle checksums, each bound to the output the upload
 * step records under the Worker key's own name. The value is minted when the
 * bundle is zipped, so a step output is the only thing that carries it.
 */
const OTA_CHECKSUM_OUTPUTS: Record<string, string> = Object.fromEntries(
  [
    'APP_BUNDLE_CHECKSUM_IOS',
    'APP_BUNDLE_CHECKSUM_ANDROID',
    'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT',
  ].map((key) => [key, `\${{ steps.ota.outputs.${key} }}`])
);

/**
 * Deploy secret overrides.
 * Keys here use the specified value instead of `${{ secrets.X }}` in
 * the generated deploy-secrets section. Used to source APP_VERSION
 * from the version job output, and the OTA checksums from the upload
 * step's outputs, rather than a GitHub secret.
 */
const DEPLOY_SECRET_OVERRIDES: Record<string, string> = {
  APP_VERSION: VERSION_JOB_OUTPUT,
  ...OTA_CHECKSUM_OUTPUTS,
};

/** The production origin the post-deploy API health probe addresses. */
const DEPLOY_VERIFY_KEYS: readonly (keyof typeof envConfig)[] = ['API_URL'];

/**
 * Escape a value for dotenv format.
 * Double-quotes by default (escaping backslashes); single-quotes values that
 * contain double quotes; throws on values containing both quote kinds.
 */
export function escapeEnvValue(value: string, key?: string): string {
  // dotenv-family parsers (wrangler's .dev.vars loader included) do NOT
  // unescape \" inside double-quoted values, so a JSON value written as
  // "{\"kty\":…}" reaches consumers with literal backslashes and fails
  // JSON.parse. Single-quoted values are taken verbatim, so quote-bearing
  // values (e.g. CF_ACCESS_DEV_PRIVATE_JWK) are single-quoted instead.
  if (value.includes('"')) {
    if (value.includes("'")) {
      // No dotenv quoting style represents a value holding BOTH quote kinds
      // faithfully (double-quoting writes \" that dotenv keeps verbatim;
      // single-quoting cannot contain a literal '). Refuse rather than write
      // a silently-corrupt line.
      throw new Error(
        `Cannot write env value for ${key ?? '<unknown key>'}: it contains both double and single quotes, which no dotenv quoting style can represent faithfully. Change the value to use at most one quote kind.`
      );
    }
    return `'${value}'`;
  }
  // Escape backslashes first, then double quotes
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

/**
 * A local-stack service named in host position, as `<service>.localhost`. The
 * registry spells no port of its own, so nothing there can drift from the
 * allocation: an unknown name fails here rather than reaching a file. Written
 * as a host rather than a port so a registry value is a URL a parser accepts
 * both before and after substitution.
 */
const LOCAL_SERVICE_HOST = /(\w+)\.localhost/g;

/**
 * The host spelling of every declared service — the key lowercased, derived
 * rather than written down a second time. `URL` lowercases a hostname, so a
 * registry value spelling one with a capital would not equal its own origin,
 * and the loopback exemption in
 * `packages/shared/src/env/env-registry-content.ts` would stop applying to it:
 * a credential-bearing entry's emulator address would become a leak needle. So
 * any other spelling is refused rather than substituted.
 */
const SERVICE_BY_HOST: ReadonlyMap<string, ServiceKey> = new Map(
  SERVICE_KEYS.map((key): [string, ServiceKey] => [key.toLowerCase(), key])
);

/** Substitute each `<service>.localhost` in a resolved env value with its allocated origin. */
export function applyWorktreePorts(value: string, ports: Readonly<Record<string, number>>): string {
  return value.replaceAll(LOCAL_SERVICE_HOST, (_match, host: string) => {
    const service = SERVICE_BY_HOST.get(host);
    const port = service === undefined ? undefined : ports[service];
    if (port === undefined) {
      throw new Error(
        `The environment registry names ${host}.localhost, which is no declared service host. Declare the service in the port plan or correct the name. Declared: ${[...SERVICE_BY_HOST.keys()].join(', ')}.`
      );
    }
    return `localhost:${String(port)}`;
  });
}

/**
 * The value the generator writes for `config` in `mode`, or null where the mode
 * resolves none: the registry value with the stack's ports, database and bucket
 * written into it. Every registry value a mode's env files carry is written from
 * here, so a reader that needs what a stack's files hold asks this rather than
 * re-deriving it.
 */
export function generatedValue(
  config: VariableConfig,
  mode: EnvMode,
  ports: Readonly<Record<string, number>>,
  getSecret: (name: string) => string
): string | null {
  const resolved = resolveValue(config, mode, getSecret);
  if (resolved === null) return null;
  const stack = stackModeFor(mode);
  return applyStackBucket(applyStackDatabase(applyWorktreePorts(resolved, ports), stack), stack);
}

/**
 * Generate the stack lines of the scripts env file.
 *
 * Always writes the HB_*_PORT vars, HB_STACK_SLOT — the slot the whole file is
 * bound to — and HB_ENV_MODE, the mode this generation ran under, so a command
 * that loads the file resolves the stack these ports came from and bakes the
 * values this run wrote. The mode is written rather than its stack because two
 * modes can share one stack, and which of them wrote the file is what a build
 * needs to name the frontend file it bakes.
 *
 * COMPOSE_PROJECT_NAME comes from that same slot, so the project a bring-up
 * acts on and the ports it publishes always name one stack. Naming it in every
 * mode is what makes a mode standing in for a stack able to bring one up at
 * all: the compose file demands the variable rather than defaulting to a shared
 * project, and the idle-killer daemon fail-fasts without it.
 */
function generatePortLines(
  ports: Record<ServiceKey, number>,
  slot: number,
  mode: EnvMode
): string[] {
  return [
    '',
    isPerCheckoutMode(mode) ? '# Worktree configuration' : '# Port configuration',
    `COMPOSE_PROJECT_NAME=${escapeEnvValue(composeProjectName(slot), 'COMPOSE_PROJECT_NAME')}`,
    // ensure-stack.ts and its helpers read the slot to scope per-slot cache paths
    // and the idle-daemon TCP sentinel.
    `HB_STACK_SLOT=${escapeEnvValue(String(slot))}`,
    `HB_ENV_MODE=${escapeEnvValue(mode)}`,
    ...SERVICE_KEYS.map((key) => `${portEnvName(key)}=${escapeEnvValue(String(ports[key]))}`),
  ];
}

/**
 * Generate the compose lines of the scripts env file.
 *
 * Every value `docker-compose.yml` interpolates that no registry entry carries
 * ready to use, derived in `scripts/lib/stack/compose-env.ts` from the one
 * spelling the registry already holds. They are written in every mode, and
 * identically in every mode, because one compose project holds one Postgres
 * cluster and one object store however many stacks a checkout runs.
 */
function generateComposeLines(values: Readonly<Record<string, string>>): string[] {
  return [
    '',
    '# Compose configuration',
    ...Object.entries(values).map(([key, value]) => `${key}=${escapeEnvValue(value, key)}`),
  ];
}

/**
 * Generate the bucket line of the scripts env file.
 *
 * The compose file creates whatever this names, so the set of buckets a stack
 * holds is declared once — in `scripts/lib/stack/stack-bucket.ts` — and
 * resolved here against the stack being written, rather than restated in an
 * entrypoint nothing can import a module into.
 */
function generateBucketLines(env: NodeJS.ProcessEnv): string[] {
  return [
    '',
    '# Object-store buckets',
    `${STACK_BUCKET_LIST_VARIABLE}=${escapeEnvValue(stackBucketList(env), STACK_BUCKET_LIST_VARIABLE)}`,
  ];
}

/**
 * Re-exposed from the mode module beside the port plan, which is where the
 * env-mode-to-stack relation lives so that a Vite config — which cannot import
 * this file — reads the same answer. Forwarding, not declaring: there is one
 * such relation in the repository, and this is a door onto it for the callers
 * that already reach the generator.
 */
export { stackModeFor } from './lib/stack/stack-mode.js';

/** The stack whose generated files carry no mode in their names. */
const UNSUFFIXED_STACK_MODE: StackMode = 'development';

export interface GeneratedEnvPaths {
  readonly backend: string;
  readonly frontend: string;
  readonly scripts: string;
}

/**
 * Where a mode's generated env files land, relative to the repo root.
 *
 * The backend and scripts files belong to the stack the mode runs, so a
 * `pnpm dev` and a `pnpm e2e` running together cannot overwrite each other's
 * ports; they follow wrangler's convention of an unsuffixed default beside a
 * per-stack sibling, so the default stack keeps the spelling every consumer
 * already reads. The frontend file is named for {@link frontendModeFor}'s
 * answer, because that is how a bundler resolves one: the stack's name wherever
 * the mode runs one, and the mode's own name where it runs none. A mode that
 * runs none writes only that file — the other two names resolve to the stack
 * its port allocation comes from, and it writes nothing there.
 */
export function generatedEnvPaths(mode: EnvMode): GeneratedEnvPaths {
  const stackMode = stackModeFor(mode);
  const suffix = stackMode === UNSUFFIXED_STACK_MODE ? '' : `.${stackMode}`;
  return {
    backend: path.join('apps', 'api', `.dev.vars${suffix}`),
    frontend: `.env.${frontendModeFor(mode)}`,
    scripts: `.env.scripts${suffix}`,
  };
}

/**
 * Replace `filePath` with `content`, and only when the bytes differ. Answers
 * whether it wrote.
 *
 * Every local `pnpm test:*` and `pnpm dev` regenerates these files on its way
 * in, so an unchanged regeneration must not touch them at all — with several
 * running at once, the ordinary run writes nothing. When the content does
 * change, the bytes land on a temporary path first and are moved into place,
 * so a reader of the target sees the whole old file or the whole new one and
 * never a fragment. Every file this generator produces is read-modify-write by
 * something, this one included: a reader that catches a truncate-in-place
 * mid-flight writes the emptiness back, which is how a tracked wrangler
 * configuration lost every line above its variables block.
 *
 * A write that cannot land is raised rather than reported and stepped over:
 * what every other command reads out of these files is which database, bucket
 * and ports it talks to, so a generation that quietly skipped one leaves the
 * next command pointed at another stack's.
 *
 * Two shapes of content reach here, and only one of them can discard somebody
 * else's edit. Content computed from the registry owes the file on disk
 * nothing, and comes through {@link writeGeneratedFile}. Content derived from
 * the file's own bytes carries whatever was read across the window to the
 * write, so an edit landing inside it is simply not in the replacement; every
 * write of that shape in this module comes through
 * {@link writeReadModifiedFile}, which refuses rather than overwrite.
 */
function writeIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) return false;

  stagedWriteSync(filePath, content);
  return true;
}

/**
 * Write back a committed file this run read and modified, refusing if the bytes
 * on disk are no longer the ones that were read.
 *
 * A read-modify-write over a file a human also edits can discard that edit with
 * nothing in the tree saying so: the replacement is derived from the bytes read,
 * so whatever landed in between is simply not in it, and the staged write makes
 * the overwrite clean rather than torn. Nothing has been observed losing a change
 * this way; the path exists and the window is open.
 *
 * The comparison is of content because content is what is at risk. A
 * modification time is a different claim — coarse at some filesystems'
 * resolution, restorable by anything that copies attributes, and moved by a
 * checkout that changed no byte — and a length says nothing about a substitution
 * that keeps it, which is the shape of most edits to these files.
 *
 * Refusing is the whole disposition: no merge, no retry, no lock. What is left
 * is the window between this check and the write it guards, which is as narrow
 * as it goes without one; the other writer's bytes stay where they are, and
 * regeneration is idempotent, so re-running the command is the repair.
 */
function writeReadModifiedFile(
  filePath: string,
  relativePath: string,
  readContent: string,
  updated: string
): boolean {
  if (readFileSync(filePath, 'utf8') !== readContent) {
    // The message carries the remedy because nothing else reaches the
    // developer: scripts/lib/cli/run-main.ts prints an error's message chain
    // and no stack, and `pnpm dev` is where this fires most.
    throw new Error(
      `${relativePath} changed while this run was regenerating it, so writing it back ` +
        'would have discarded that change. It was left as it is; re-run the command.'
    );
  }

  return writeIfChanged(filePath, updated);
}

function writeGeneratedFile(rootDir: string, relativePath: string, content: string): void {
  const wrote = writeIfChanged(path.resolve(rootDir, relativePath), content);
  console.error(`  ${wrote ? 'Generated' : 'Unchanged'} ${relativePath}`);
}

function writeBackendEnv(rootDir: string, backendPath: string, backendLines: string[]): string[] {
  const devVariablesContent =
    ['# Auto-generated - do not edit', '', ...backendLines].join('\n') + '\n';
  writeGeneratedFile(rootDir, backendPath, devVariablesContent);
  return [updateWranglerToml(rootDir), ...updateGeneratedFiles(rootDir)];
}

/**
 * Generate every env file for `mode`, and rewrite the generated blocks of the
 * committed files that carry them.
 *
 * Destinations, at the paths {@link generatedEnvPaths} gives the mode:
 * - Dest.Backend  → the dev-vars file
 * - Dest.Frontend → the Vite env file (VITE_* vars only)
 * - Dest.Scripts  → the scripts env file (migrations, seed, etc.)
 *
 * Modes:
 * - development (default): Generate files with development values
 * - test: The vitest stack with development values — its own data plane, so a
 *   test run shares no database, bucket or Redis keyspace with `pnpm dev`
 * - ciVitest: The same stack from CI, taking the CI secrets from process.env;
 *   it refuses to generate on a machine that holds none, which is what keeps a
 *   local run off them
 * - e2e: Local E2E tests (no secrets, adds VITE_E2E=true)
 * - ciE2E: CI E2E tests (inherits e2e + Helcim secrets from process.env)
 * - production: Its frontend file, and nothing else at all — it runs no stack,
 *   so it writes neither file a stack's own processes read, and rewrites no
 *   generated block of a committed file either. The production values in
 *   wrangler.toml are written by {@link updateWranglerToml} under whichever
 *   mode does write a backend file
 *
 * Every value's port templates are substituted with the slot's allocation for
 * the mode's stack, so two checkouts — and the two stacks of one checkout —
 * never write each other's ports.
 *
 * Returns the committed files that carry generated content — wrangler.toml, the
 * workflow files and the secrets document — because the pre-commit hook stages
 * exactly this list: a file that becomes a generated-block owner is staged by
 * having joined `GENERATED_FILES`, with no second list to keep in step. The
 * list is the same whether or not this run changed any bytes, since the hook
 * refuses an empty one. The env files themselves are git-ignored, so they are
 * not in it. Progress goes to stderr to keep stdout that list alone.
 */
export function generateEnvFiles(
  rootDir: string,
  mode: EnvMode = Mode.Development,
  options: { skipBackend?: boolean } = {}
): string[] {
  // skipBackend generates only what a web bundle consumes (the frontend and
  // scripts files), skipping the dev-vars file, wrangler, and the workflow
  // rewrite. The backend secrets are never referenced, so they are not
  // required — used by `build:e2e`, which builds the frontend and never reads
  // the backend env.
  const { skipBackend = false } = options;
  const missing: string[] = [];
  // Every mode binds the generating checkout's own slot, the modes standing in
  // for a stack included. A stand-in file naming some other slot names a
  // compose project and a set of containers that belong to whichever checkout
  // holds that slot, and a tear-down reached from an ordinary entry then
  // destroys their stack; two checkouts that would collide clash on ports
  // instead, loudly. A runner holds one checkout, so it takes the first slot
  // there as it always did.
  const { slot } = getWorktreeConfig(rootDir);
  const paths = generatedEnvPaths(mode);
  const ports = portsFor({ slot, mode: stackModeFor(mode) });
  const getSecret = (name: string): string => {
    const val = process.env[name];
    if (!val) {
      missing.push(name);
      return ''; // Placeholder, will throw after collecting all missing
    }
    return val;
  };

  const generateLines = (destination: Destination): string[] =>
    Object.entries(envConfig)
      .filter(([, config]) => getDestinations(config as VariableConfig, mode).includes(destination))
      .map(([key, config]) => {
        const value = generatedValue(config as VariableConfig, mode, ports, getSecret);
        /* istanbul ignore next -- @preserve defensive check */
        if (value === null) return null;
        return `${key}=${escapeEnvValue(value, key)}`;
      })
      .filter((line): line is string => line !== null);

  const composeValues: Record<string, string> = { ...composeEnvValues() };

  /**
   * What this run writes into the stack's own two files, or `undefined` where
   * the mode runs no stack.
   *
   * Both files are read by a stack's live processes, so a mode that runs none
   * must write neither: its values would land on whatever is running there.
   * Resolved here rather than past the frontend write, so that every secret the
   * two demand is collected by the one gate below — and never demanded at all
   * when there is nothing to write them to.
   */
  const stack = writesStackFiles(mode)
    ? {
        backendLines: skipBackend ? [] : generateLines(Destination.Backend),
        scriptsLines: generateLines(Destination.Scripts),
        // Each bucket variable's value, taken from whichever home carries it: the
        // registry for the entries it holds, the compose-facing derivation for the
        // emulator bucket the registry spells no entry for. Resolved regardless of
        // destination, because a stack's buckets are not all written to one file.
        buckets: Object.fromEntries(
          STACK_BUCKET_VARIABLES.map((variable): [string, string | undefined] => {
            const config = (envConfig as Record<string, VariableConfig | undefined>)[variable];
            if (config === undefined) return [variable, composeValues[variable]];
            return [variable, generatedValue(config, mode, ports, getSecret) ?? undefined];
          })
        ),
      }
    : undefined;

  const frontendLines = generateLines(Destination.Frontend);

  if (missing.length > 0) {
    throw new Error(`Missing required secrets in process.env: ${missing.join(', ')}`);
  }

  const frontendContent =
    [
      '# Auto-generated from packages/shared/src/env/env.config.ts',
      '# Do not edit directly - run: pnpm generate:env',
      '',
      ...frontendLines,
    ].join('\n') + '\n';
  writeGeneratedFile(rootDir, paths.frontend, frontendContent);

  if (stack === undefined) {
    console.error('✓ All environment files generated');
    return [];
  }

  const portLines = generatePortLines(ports, slot, mode);
  const envScriptsContent =
    [
      '# Auto-generated - do not edit',
      '',
      ...stack.scriptsLines,
      ...portLines,
      ...generateComposeLines(composeValues),
      ...generateBucketLines(stack.buckets),
    ].join('\n') + '\n';
  writeGeneratedFile(rootDir, paths.scripts, envScriptsContent);

  const written = skipBackend ? [] : writeBackendEnv(rootDir, paths.backend, stack.backendLines);

  console.error('✓ All environment files generated');
  return written;
}

/**
 * Update wrangler.toml with [vars] section containing production non-secret values.
 * Returns the path it wrote.
 *
 * Everything outside the variables block is carried across from the bytes this
 * reads, so the write is a read-modify-write over a committed file: one that
 * changed inside that window is refused rather than overwritten, by
 * {@link writeReadModifiedFile}.
 */
function updateWranglerToml(rootDir: string): string {
  const relativePath = 'apps/api/wrangler.toml';
  const tomlPath = path.resolve(rootDir, relativePath);
  const held = readFileSync(tomlPath, 'utf8');

  const withoutVariables = held.replace(/\n?\[vars\][\s\S]*?(?=\n\[[^\]]+\]|$)/, '');

  // Build new [vars] section with production non-secret values from backend
  const variablesLines: string[] = ['', '[vars]'];
  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Backend)) continue;

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    // Only include literal production values (not secrets)
    if (raw && typeof raw === 'string') {
      variablesLines.push(`${key} = "${raw}"`);
    }
  }

  const secretKeys = getBackendSecretKeys();
  /* istanbul ignore next -- @preserve always true with current config */
  if (secretKeys.length > 0) {
    variablesLines.push('', '# Secrets deployed via CI (wrangler deploy --secrets-file):');
    for (const key of secretKeys) {
      variablesLines.push(`# - ${key}`);
    }
  }

  const wrote = writeReadModifiedFile(
    tomlPath,
    relativePath,
    held,
    withoutVariables.trimEnd() + variablesLines.join('\n') + '\n'
  );
  console.error(`  ${wrote ? 'Updated' : 'Unchanged'} ${relativePath} [vars]`);
  return tomlPath;
}

/**
 * Get the list of backend keys that are secrets (the set the deploy upload carries).
 */
function getBackendSecretKeys(): string[] {
  return Object.entries(envConfig)
    .filter(([, config]) => {
      const destinations = getDestinations(config as VariableConfig, Mode.Production);
      return (
        destinations.includes(Destination.Backend) && isProductionSecret(config as VariableConfig)
      );
    })
    .map(([key]) => key);
}

/**
 * The two spellings of a marker pair: a YAML comment in the workflows, an HTML
 * comment in the Markdown document, where `#` opens a heading.
 */
const MARKER_FORMS = {
  yaml: { open: '# ', close: '' },
  markdown: { open: '<!-- ', close: ' -->' },
} as const;

/**
 * Every complete marker pair for one marker, in either form. Both markers are
 * pinned to the end of their line, which is what keeps `build-env` off
 * `build-env-mobile`: without the END-side pin, a `build-env` block that lost
 * its own END marker matches through to the sibling's, and the replacement
 * writes over everything between — deleting the sibling's whole block, markers
 * included.
 */
function sectionPattern(marker: string): RegExp {
  const pairs = Object.values(MARKER_FORMS).map(
    ({ open, close }) =>
      String.raw`${open}BEGIN GENERATED: ${marker}${close}\n[\s\S]*?${open}END GENERATED: ${marker}${close}`
  );
  return new RegExp(String.raw`([ ]*)(?:${pairs.join('|')})(?=\r?\n|$)`, 'g');
}

/**
 * Replace a marked section, keeping the marker form the file uses.
 * Detects indentation from the BEGIN marker and applies it to generated content.
 *
 * On its own this leaves a file that has lost its markers untouched; it is
 * {@link updateGeneratedFiles} that refuses such a file, by counting the pairs each
 * section's ownership declares.
 */
export function replaceSection(content: string, marker: string, newContent: string): string {
  return content.replace(sectionPattern(marker), (matched: string, indent: string) => {
    const { open, close } = matched.trimStart().startsWith(MARKER_FORMS.markdown.open)
      ? MARKER_FORMS.markdown
      : MARKER_FORMS.yaml;
    const indentedContent = newContent
      .split('\n')
      .map((line) => (line ? indent + line : line))
      .join('\n');
    return `${indent}${open}BEGIN GENERATED: ${marker}${close}\n${indentedContent}${indent}${open}END GENERATED: ${marker}${close}`;
  });
}

/**
 * Emit named envConfig entries as plain literals resolved for the mode — for
 * steps that need a non-secret registry value (e.g. NODE_ENV) present in the
 * workflow env block.
 */
function generateLiteralLines(
  mode: EnvMode,
  literalKeys: readonly (keyof typeof envConfig)[]
): string[] {
  return literalKeys.map((key) => `  ${literalEntry(mode, key)}`);
}

/** One registry literal as a mapping entry, resolved for the mode. */
function literalEntry(mode: EnvMode, key: keyof typeof envConfig): string {
  const raw = resolveRaw(envConfig[key] as VariableConfig, mode);
  /* istanbul ignore next -- @preserve defensive check */
  if (typeof raw !== 'string') {
    throw new TypeError(`literalKeys entry ${key} must resolve to a plain value in mode ${mode}`);
  }
  return `${key}: ${raw}`;
}

/**
 * Generate a secrets env section for a given mode.
 * Uses the secret name for BOTH the env var name AND GitHub secret reference.
 * `literalKeys` rides along as plain literals (see generateLiteralLines).
 * `overrides`, keyed by that same secret name, replaces the reference for a
 * marker no GitHub secret backs — a value the run itself mints.
 */
function generateSecretsEnv(
  mode: EnvMode,
  destinations?: readonly Destination[],
  literalKeys: readonly (keyof typeof envConfig)[] = [],
  overrides: Record<string, string> = {}
): string {
  const lines: string[] = ['env:', ...generateLiteralLines(mode, literalKeys)];

  for (const [, config] of Object.entries(envConfig)) {
    if (
      destinations &&
      !getDestinations(config as VariableConfig, mode).some((d) => destinations.includes(d))
    ) {
      continue;
    }
    const raw = resolveRaw(config as VariableConfig, mode);
    if (raw && isSecret(raw)) {
      const stored = `\${{ secrets.${raw.name} }}`;
      lines.push(`  ${raw.name}: ${overrides[raw.name] ?? stored}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the ops-env section: the union of every manifest entry's
 * `requires_secrets`, each bound to its production value and keyed by its
 * canonical Worker-env-var name (the env.config.ts key) — not the GitHub secret
 * name — so a script reading `process.env.OPENROUTER_API_KEY` works identically
 * locally and in CI. The union is static because which entries a run carries is
 * chosen at run time, from PR labels or the manual runner's dropdown.
 *
 * Only Backend- and Ops-lane variables are bindable, and none of
 * {@link DEPLOY_SECRET_OVERRIDES}: those are minted by the deploy run's own jobs
 * and steps, which the manual runner has none of. Bare mapping entries, for the
 * reason {@link generateDeploySecretsEnv} carries — each copy sits inside an
 * ops-script step's own `env:`, beside that step's own entries.
 */
export function generateOpsEnv(manifest: OpsManifest): string {
  const required = new Set(manifest.scripts.flatMap((script) => script.requires_secrets));
  const lines: string[] = [];
  for (const [key, config] of Object.entries(envConfig)) {
    if (!required.has(key) || key in DEPLOY_SECRET_OVERRIDES) continue;
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Backend) && !destinations.includes(Destination.Ops)) {
      continue;
    }
    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    if (raw && isSecret(raw)) lines.push(`${key}: \${{ secrets.${raw.name} }}`);
    else if (typeof raw === 'string') lines.push(`${key}: ${raw}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Generate the deploy-verify-env section: the production origin the post-deploy
 * API health probe addresses, as a registry literal in a bare mapping entry
 * (placed as {@link generateDeploySecretsEnv} explains).
 */
function generateDeployVerifyEnv(): string {
  return literalEntries(DEPLOY_VERIFY_KEYS);
}

/**
 * Generate the deploy-surfaces-env section: the production origin of every
 * surface the post-deploy surface probe proves, in the form of
 * {@link generateDeployVerifyEnv}.
 */
function generateDeploySurfacesEnv(): string {
  return literalEntries(SURFACE_ORIGINS);
}

/** Production registry literals as bare mapping entries. */
function literalEntries(keys: readonly (keyof typeof envConfig)[]): string {
  return keys.map((key) => literalEntry(Mode.Production, key)).join('\n') + '\n';
}

/**
 * Generate the build-env section (production frontend values).
 * Overrides replace envConfig values for specific keys (e.g., VITE_PLATFORM, VITE_APP_VERSION).
 * `literalKeys` rides along for non-frontend registry values a build step needs
 * (see WORKSPACE_BUILD_VARIANTS).
 */
function generateBuildEnv(
  overrides: Record<string, string> = {},
  literalKeys: readonly (keyof typeof envConfig)[] = []
): string {
  const lines: string[] = ['env:', ...generateLiteralLines(Mode.Production, literalKeys)];

  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Frontend)) continue;

    if (key in overrides) {
      /* v8 ignore next -- guarded by `key in overrides`, so the lookup is always defined */
      lines.push(`  ${key}: ${overrides[key] ?? ''}`);
      continue;
    }

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    // All frontend vars have production values
    /* istanbul ignore next -- @preserve defensive check */
    if (!raw) continue;

    // A frontend variable's production value is always a secret or a literal.
    if (isSecret(raw)) {
      lines.push(`  ${key}: \${{ secrets.${raw.name} }}`);
    } else if (typeof raw === 'string') {
      lines.push(`  ${key}: ${raw}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** One secret the deploy pushes: the Worker's key, and where the value comes from. */
interface DeploySecret {
  readonly key: string;
  readonly reference: string;
}

/**
 * The secrets the deploy pushes, in registry order. One list behind both the
 * encoder and the env block binding its values: the encoder reads each key
 * from its environment, so a key present on one side only would refuse the
 * whole batch.
 */
function deploySecrets(): DeploySecret[] {
  const secrets: DeploySecret[] = [];

  for (const [key, config] of Object.entries(envConfig)) {
    const destinations = getDestinations(config as VariableConfig, Mode.Production);
    if (!destinations.includes(Destination.Backend)) continue;

    const raw = resolveRaw(config as VariableConfig, Mode.Production);
    /* v8 ignore next -- defensive: every deploy secret resolves to a non-empty ref in Production */
    if (raw && isSecret(raw)) {
      const override = DEPLOY_SECRET_OVERRIDES[key];
      secrets.push({ key, reference: override ?? `\${{ secrets.${raw.name} }}` });
    }
  }

  return secrets;
}

/** The Worker keys the deploy publishes: the list the encoder reads from its environment. */
export function deploySecretKeys(): string[] {
  return deploySecrets().map(({ key }) => key);
}

/**
 * Generate the deploy-secrets section: the encoder's output handed to the
 * API's `wrangler deploy` as its secrets file, so every Worker secret lands in
 * the same upload and version as the code — coupled halves never skew, and the
 * version and checksums `/updates/current` serves go live only with the code
 * that serves them. `--tag` annotates that version with the release it ships.
 *
 * The output is captured before wrangler starts, because a pipe starts both
 * ends at once: under the step's `set -e` an encoder refusal ends the step
 * before wrangler could deploy with an empty secrets file.
 *
 * The command names no secret. A value substituted into the command as an
 * expression is pasted in as text before bash parses the line, so bash's own
 * quote removal and backslash escaping run over the secret's bytes — which
 * collapses the `\n` escapes inside a service-account private key — and a
 * value handed to a helper as an argument is readable on that process's
 * command line while it runs. The encoder reads its keys from
 * {@link deploySecretKeys} and their values from the step's environment, and
 * refuses the whole batch when one is missing; its output is expanded only
 * quoted, as the argument of the `printf` builtin, in bash's own process.
 * `pnpm -w exec` runs the encoder from the workspace root.
 */
function generateDeploySecrets(): string {
  return String.raw`secrets_json="$(pnpm -w exec tsx scripts/encode-deploy-secrets.ts)"
printf '%s\n' "$secrets_json" | pnpm exec wrangler deploy --secrets-file /dev/stdin --tag "v$VERSION" --message "$GITHUB_SHA"
`;
}

/**
 * Generate the deploy-secrets-env section: the bindings those commands read.
 * Bare mapping entries rather than a whole `env:` block, because it sits inside
 * the step's own `env:` beside the wrangler credentials the registry does not
 * carry. Unprefixed, so the entries render on the marker's own column: Prettier
 * pulls a marker comment onto the column of the entries around it, and content
 * indented past its marker would gain two more spaces on every
 * format-then-regenerate cycle until the mapping no longer parses.
 */
function generateDeploySecretsEnv(): string {
  return (
    deploySecrets()
      .map(({ key, reference }) => `${key}: ${reference}`)
      .join('\n') + '\n'
  );
}

/**
 * Generate the verify-secrets section (for loop of secret names).
 */
function generateVerifySecrets(): string {
  return `for secret in ${getBackendSecretKeys().join(' ')}; do\n`;
}

/**
 * Generate the decode-google-services section (base64 decode command for workflow).
 */
function generateGoogleServicesDecode(): string {
  const config = envConfig.GOOGLE_SERVICES_JSON_BASE64;
  const raw = resolveRaw(config as VariableConfig, Mode.Production);
  /* istanbul ignore next -- @preserve defensive check */
  if (!raw || !isSecret(raw)) return '';

  const lines = [
    `run: echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 -d > apps/web/android/app/google-services.json`,
    `env:`,
    `  GOOGLE_SERVICES_JSON_BASE64: \${{ secrets.${raw.name} }}`,
  ];
  return lines.join('\n') + '\n';
}

const INVENTORY_COLUMNS = [
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
] as const;

type InventoryColumn = (typeof INVENTORY_COLUMNS)[number];
type InventoryRow = Readonly<Record<InventoryColumn, string>>;

/** Prose in a table cell: a bare pipe would end the cell. */
function tableCell(text: string): string {
  return text.replaceAll('|', String.raw`\|`);
}

/**
 * Every declaration the inventory lists — the registry entries carrying a
 * credential and `CI_SECRETS` — in code-unit name order. Not locale collation:
 * that differs between ICU builds, and the table is drift-checked byte for byte.
 */
function credentialDeclarations(): (readonly [string, Credential])[] {
  const registry = Object.entries(envConfig).flatMap(
    ([key, config]): (readonly [string, Credential])[] => {
      const { credential } = config as VariableConfig;
      return credential ? [[key, credential]] : [];
    }
  );
  return [...registry, ...Object.entries(CI_SECRETS)].toSorted(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * Whether the escrow captures this credential. The loss class is the stance and
 * the only field that decides it: a second `backup` field would equal the loss
 * class for every credential, and two fields that must agree are the sync
 * contract `docs/CODE-RULES.md` bans.
 */
function isEscrowed(credential: Credential): boolean {
  return credential.onLoss === 'restoreFromCopy';
}

/**
 * The escrow job that captures one declaration, named by the environment that
 * job declares. A job declaring an environment reads that environment's secrets
 * and the repository's alike, so a repository-scoped declaration is within
 * reach of every job and the production one takes it: capturing it from both
 * would write the same bytes twice, under two set names. Any other `github:`
 * store names the one environment holding it, whose job is the only one that
 * can read it. A store no GitHub secret backs has no job at all and is refused
 * here, rather than generated into a block no workflow carries.
 */
export function escrowEnvironmentOf(name: string, store: SecretStore): string {
  const environment = store.startsWith('github:') ? store.slice('github:'.length) : '';
  if (environment === '') {
    throw new Error(
      `${name} says a copy of it is escrowed, but no GitHub secret holds it — its store is ` +
        `${store} — so no escrow job can bind it. Store it on GitHub, or give it another ` +
        'loss class.'
    );
  }
  return environment === 'repository' ? 'production' : environment;
}

/** The environments the escrow runs under: one per job {@link escrowEnvironmentOf} names. */
export function escrowEnvironments(): string[] {
  return [
    ...new Set(
      credentialDeclarations()
        .filter(([, credential]) => isEscrowed(credential))
        .map(([name, credential]) => escrowEnvironmentOf(name, credential.store))
    ),
    // Code-unit order, for the reason {@link credentialDeclarations} carries:
    // the markers these name are drift-checked byte for byte.
  ].toSorted((a, b) => (a < b ? -1 : 1));
}

/** The marker of one environment's bindings, which its job carries a pair of. */
export function escrowSectionMarker(environment: string): string {
  return `escrow-secrets-env-${environment}`;
}

/**
 * The declaration names the escrow captures, in the inventory's name order —
 * one environment's set, or every environment's when none is named.
 */
export function escrowedSecretKeys(environment?: string): string[] {
  return credentialDeclarations()
    .filter(
      ([name, credential]) =>
        isEscrowed(credential) &&
        (environment === undefined || escrowEnvironmentOf(name, credential.store) === environment)
    )
    .map(([name]) => name);
}

/**
 * The GitHub secret holding one escrowed declaration's production value. A
 * registry entry names it in that entry's production marker, which is a
 * different name whenever one declaration's modes carry separate secrets; a
 * `CI_SECRETS` entry is itself keyed by the name a workflow reads.
 */
function productionSecretName(key: string): string {
  const declared = Object.entries(envConfig).find(([name]) => name === key);
  const raw = declared ? resolveRaw(declared[1] as VariableConfig, Mode.Production) : undefined;
  if (raw && isSecret(raw)) return raw.name;
  /* v8 ignore next -- defensive: the escrow copies the production value, so an escrowed declaration is either a CI_SECRETS key or a registry entry resolving to a production secret */
  if (!(key in CI_SECRETS)) throw new Error(`No production GitHub secret holds ${key}`);
  return key;
}

/**
 * What the escrow run reads and where each value comes from: the key is the
 * environment variable the escrow script reads and stores the copy under, and
 * the name is the GitHub secret holding the value. Binding the name rather than
 * reusing the key is what keeps a declaration whose secret is named differently
 * from resolving to an empty string, which the escrow refuses the whole run on.
 */
export function escrowedSecretNames(): string[] {
  return escrowedSecretKeys().map((key) => productionSecretName(key));
}

/** One inventory row; the family links to its runbook relative to the document. */
function inventoryRow([name, credential]: readonly [string, Credential]): InventoryRow {
  const runbook = path.posix.relative(
    path.posix.dirname(SECRETS_DOC),
    runbookPath(credential.family)
  );
  return {
    Name: `\`${name}\``,
    Family: `[${credential.family}](${runbook})`,
    Store: credential.store,
    Description: tableCell(credential.description),
    Replace: credential.replace,
    'On loss': credential.onLoss,
    Escrowed: isEscrowed(credential) ? 'yes' : '',
    'User-visible': tableCell(credential.userVisible),
    'Coupled with': (credential.coupledWith ?? []).map((other) => `\`${other}\``).join(', '),
    'Leak impact': credential.leakImpact,
  };
}

/**
 * A Markdown table in the shape Prettier prints, so the block is formatted as
 * written: every cell padded to its column's widest entry, three at least, and
 * the rule row filled to that width. Widths are code-unit lengths, which are
 * Prettier's display widths while every cell is ASCII.
 */
function markdownTable(rows: readonly InventoryRow[]): string {
  const widths = Object.fromEntries(
    INVENTORY_COLUMNS.map((column) => [
      column,
      Math.max(3, column.length, ...rows.map((row) => row[column].length)),
    ])
  ) as Record<InventoryColumn, number>;
  const line = (cell: (column: InventoryColumn) => string): string =>
    `| ${INVENTORY_COLUMNS.map((column) => cell(column).padEnd(widths[column])).join(' | ')} |`;

  return (
    [
      line((column) => column),
      line((column) => '-'.repeat(widths[column])),
      ...rows.map((row) => line((column) => row[column])),
    ].join('\n') + '\n'
  );
}

/**
 * The secrets document's inventory block. A blank line on each side of the
 * table, because Prettier separates a table from the HTML comment beside it
 * with one and would otherwise rewrite the block.
 */
export function generateSecretsInventory(
  declarations: readonly (readonly [string, Credential])[] = credentialDeclarations()
): string {
  return `\n${markdownTable(declarations.map((declaration) => inventoryRow(declaration)))}\n`;
}

/** One env mapping entry: the name a step reads on the left, the secret on the right. */
function secretBinding(key: string, name: string): string {
  return `${key}: \${{ secrets.${name} }}`;
}

/**
 * Generate the escrow-secrets-env section: the step bindings the escrow run
 * reads, its own transport included. The transport is bound beside the escrow
 * set rather than inside it, because the escrow set is every `restoreFromCopy`
 * declaration and these four are `reissueAtVendor`; it is derived from
 * {@link ESCROW_BUCKET_ENV_NAMES}, the map the upload reads them through, so a
 * name the workflow binds is a name the upload reads. Bare mapping entries
 * rather than a whole `env:` block, for the reason
 * {@link generateDeploySecretsEnv} carries.
 */
function generateEscrowSecretsEnv(environment: string): string {
  return (
    [
      ...escrowedSecretKeys(environment).map((key) =>
        secretBinding(key, productionSecretName(key))
      ),
      ...Object.values(ESCROW_BUCKET_ENV_NAMES).map((key) => secretBinding(key, key)),
    ].join('\n') + '\n'
  );
}

/**
 * Generate the backup-env section: every variable one backup run reads, bound
 * to its production value. Derived from the run's own variable map rather than
 * from a list here, so a variable the orchestrator starts reading cannot reach
 * the workflow unbound, and a binding the orchestrator no longer reads cannot
 * linger. A whole job-level `env:` block, because every step of the job runs
 * the same command and reads the same values.
 */
function generateBackupEnv(): string {
  const lines = Object.values(BACKUP_VARIABLES).map((key) => {
    const raw = resolveRaw(envConfig[key] as VariableConfig, Mode.Production);
    if (isSecret(raw)) return `  ${secretBinding(key, raw.name)}`;
    /* v8 ignore next -- defensive: every backup variable resolves in Production, by the section's own test */
    if (typeof raw !== 'string') throw new TypeError(`${key} has no production value`);
    return `  ${key}: ${raw}`;
  });
  return ['env:', ...lines].join('\n') + '\n';
}

/**
 * Every section this generator writes, keyed by its marker, each declaring the
 * files that own it. Ownership is declared here and derived nowhere else: it is
 * what the write loop below renders from and what it holds every workflow file
 * to, so a section whose pairs are not where it says they are stops the
 * generator instead of quietly generating into nothing.
 */
export function workflowSections(): Record<string, GeneratedSection> {
  const sections: Record<string, GeneratedSection> = {
    'vitest-env': { owners: [CI_WORKFLOW], content: generateSecretsEnv(Mode.CiVitest) },
    // Two jobs generate the e2e environment: the browser suite and the mobile
    // suite, each with its own "Generate environment files" step.
    'e2e-env': {
      owners: [CI_WORKFLOW, CI_WORKFLOW],
      content: generateSecretsEnv(Mode.CiE2E),
    },
    // NODE_ENV rides along as a literal: createEnvUtilities fail-fasts on a
    // missing NODE_ENV, and its development value is what builds the e2e
    // marketing islands on React's development build. The web app's own Vite
    // config pins React's production build whatever this carries.
    'e2e-build-env': {
      owners: [CI_WORKFLOW],
      content: generateSecretsEnv(
        Mode.CiE2E,
        [Destination.Frontend, Destination.Scripts],
        ['NODE_ENV']
      ),
    },
    // generate-headers.ts reads VITE_API_URL (to match the CSP connect-src to
    // the origin the client bundles were built against) and SANDBOX_ORIGIN_URL
    // (the frame-src allowance for the document sandbox). It runs directly,
    // not through scripts/with-env.ts, so the workflow env block is its only
    // source. Emitted as registry literals — empty destinations means no
    // secrets ride along.
    'headers-env': {
      owners: [CI_WORKFLOW],
      content: generateSecretsEnv(Mode.Production, [], ['VITE_API_URL', 'SANDBOX_ORIGIN_URL']),
    },
    // One copy per ops-script step: in the deploy, the resolver, which checks
    // each labelled script's declared secrets against its own environment, and
    // the pre- and post-deploy runners, which hand that environment to the
    // scripts; in the manual runner, its resolver and the step that runs the
    // selected script.
    'ops-env': {
      owners: [CI_WORKFLOW, CI_WORKFLOW, CI_WORKFLOW, OPS_DISPATCH_WORKFLOW, OPS_DISPATCH_WORKFLOW],
      content: generateOpsEnv(loadManifest(REPO_ROOT)),
    },
    // An ops script that classifies its environment through createEnvUtilities
    // refuses to run without NODE_ENV, a literal `requires_secrets` does not carry.
    'ops-dispatch-run-env': {
      owners: [OPS_DISPATCH_WORKFLOW],
      content: literalEntries(['NODE_ENV']),
    },
    'deploy-verify-env': { owners: [CI_WORKFLOW], content: generateDeployVerifyEnv() },
    'deploy-surfaces-env': { owners: [CI_WORKFLOW], content: generateDeploySurfacesEnv() },
    'deploy-secrets': { owners: [CI_WORKFLOW], content: generateDeploySecrets() },
    'deploy-secrets-env': { owners: [CI_WORKFLOW], content: generateDeploySecretsEnv() },
    'verify-secrets': { owners: [CI_WORKFLOW], content: generateVerifySecrets() },
    'decode-google-services': {
      owners: [ANDROID_WORKFLOW],
      content: generateGoogleServicesDecode(),
    },
    // .gitleaks.toml's allowlist rests on version-specific merge semantics, so
    // the engine CI installs must be the engine the local hook installs. The
    // pin is declared once, in scripts/lib/privacy/gitleaks.ts, and emitted here.
    'gitleaks-version': {
      owners: [CI_WORKFLOW],
      content: `GITLEAKS_VERSION: '${GITLEAKS_VERSION}'\n`,
    },
    'e2e-matrix': { owners: [CI_WORKFLOW], content: generateE2eMatrix() },
    'e2e-run-set': { owners: [CI_WORKFLOW], content: generateE2eRunSet() },
    'backup-env': { owners: [BACKUP_WORKFLOW], content: generateBackupEnv() },
    'secrets-inventory': { owners: [SECRETS_DOC], content: generateSecretsInventory() },
  };

  for (const environment of escrowEnvironments()) {
    sections[escrowSectionMarker(environment)] = {
      owners: [ESCROW_WORKFLOW],
      content: generateEscrowSecretsEnv(environment),
    };
  }

  // Production is the one mode with no committed environment file, so every job
  // whose build bakes one writes it first. Every value that file carries is
  // resolved out of the step's own environment: the stored client secrets from
  // the secrets context, and the version from wherever the workflow it runs in
  // receives it, which no stored secret backs.
  for (const [marker, variant] of Object.entries(PRODUCTION_ENV_VARIANTS)) {
    sections[marker] = {
      owners: variant.owners,
      content: generateSecretsEnv(Mode.Production, [Destination.Frontend], [], variant.overrides),
    };
  }

  for (const [marker, variant] of Object.entries(BUILD_VARIANTS)) {
    sections[marker] = {
      owners: variant.owners,
      content: generateBuildEnv(
        variant.overrides,
        WORKSPACE_BUILD_VARIANTS.has(marker) ? ['ESM_CDN_URL'] : []
      ),
    };
  }

  return sections;
}

/** Marker pairs of one section a file must carry, from the section's owners. */
function declaredPairs(section: GeneratedSection, relativePath: GeneratedFile): number {
  return section.owners.filter((owner) => owner === relativePath).length;
}

/**
 * Rewrite the generated blocks of every file that carries one: the workflows
 * and the secrets document.
 *
 * Every file is measured before any of them is written, over the markers the
 * section map declares and no others: a declared pair the file does not carry
 * would otherwise be regenerated into nothing at all, and a declared pair in a
 * file that does not own it is a block regeneration reaches from nowhere. Both
 * stop the run, before the first write, naming every mismatch rather than the
 * first.
 *
 * A pair whose marker no section declares is outside that measurement — this
 * looks only for markers it renders — so it passes here and regenerates
 * byte-for-byte. The sweep in generate-env.test.ts is what catches it: it reads
 * the markers off every workflow file rather than off the section map, so
 * retiring it as redundant would reopen that shape.
 *
 * A file that does not exist is skipped, which is what lets a test tree hold
 * only the files it is about.
 *
 * Every file is read before any is written, so each one's write is a
 * read-modify-write over a committed file with a window in between; a file that
 * changed inside its own window is refused rather than overwritten, by
 * {@link writeReadModifiedFile}.
 *
 * Returns the path of every file that carries a block, written this run or
 * already matching, which is what the pre-commit hook stages.
 */
export function updateGeneratedFiles(rootDir: string): string[] {
  const sections = Object.entries(workflowSections());
  const present = GENERATED_FILES.filter((relativePath) =>
    existsSync(path.resolve(rootDir, relativePath))
  ).map((relativePath) => ({
    relativePath,
    content: readFileSync(path.resolve(rootDir, relativePath), 'utf8'),
  }));

  const mismatches = present.flatMap(({ relativePath, content }) =>
    sections.flatMap(([marker, section]) => {
      const declared = declaredPairs(section, relativePath);
      const found = [...content.matchAll(sectionPattern(marker))].length;
      return declared === found
        ? []
        : [`${relativePath}: ${marker} — ${String(declared)} declared, ${String(found)} found`];
    })
  );

  if (mismatches.length > 0) {
    // The message carries the remedy because the stack does not reach the
    // developer: scripts/lib/cli/run-main.ts prints `error.message` alone, and
    // `pnpm dev` is where this fires most.
    throw new Error(
      `Generated sections do not match the marker pairs on disk:\n${mismatches
        .map((mismatch) => `  ${mismatch}`)
        .join('\n')}\n` +
        "Restore the missing marker pair, or update the section's owners in " +
        'scripts/generate-env.ts to match where it renders now.'
    );
  }

  return present.map(({ relativePath, content }) => {
    let updated = content;
    for (const [marker, section] of sections) {
      if (declaredPairs(section, relativePath) > 0) {
        updated = replaceSection(updated, marker, section.content);
      }
    }
    const filePath = path.resolve(rootDir, relativePath);
    const wrote = writeReadModifiedFile(filePath, relativePath, content, updated);
    console.error(`  ${wrote ? 'Updated' : 'Unchanged'} ${relativePath}`);
    return filePath;
  });
}

export const COMMAND_LINE = {
  command: 'pnpm generate:env',
  summary: "Writes this checkout's environment files for one mode.",
  flags: [
    {
      flag: '--mode',
      kind: 'value',
      placeholder: '<mode>',
      summary: 'Which mode to generate for. Defaults to development.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/** A line asking for usage generates nothing; the entry point never runs it. */
export function parseArgs(args: readonly string[]): EnvMode {
  const parsed = parseCommandLine(COMMAND_LINE, args);
  if (parsed.kind === 'help') return Mode.Development;
  const mode = parsed.flags['--mode'];
  if (mode === undefined) return Mode.Development;
  const validModes = Object.values(Mode);
  if (validModes.includes(mode as Mode)) return mode as EnvMode;
  throw new Error(`Invalid mode: ${mode}. Valid modes: ${validModes.join(', ')}`);
}

/* v8 ignore start */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (readCommandLine(COMMAND_LINE, argv) !== null) {
    console.log(generateEnvFiles(process.cwd(), parseArgs(argv)).join('\n'));
  }
}
/* v8 ignore stop */

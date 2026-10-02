import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { formatUsage, parseCommandLine, type CommandSpec } from './lib/cli/command-line.js';

/** How a module treats an argument it was not written to expect. */
type Handling =
  | { readonly kind: 'parsed'; readonly load: () => Promise<unknown> }
  | { readonly kind: 'forwards' | 'positional' };

/**
 * Owns its whole command line and answers for every token in it. The loader
 * sits beside the classification rather than in a second list, so the module a
 * row names and the module the assertions drive cannot come apart.
 */
function parsed(load: () => Promise<unknown>): Handling {
  return { kind: 'parsed', load };
}

/** Hands the argv it does not consume to another tool, whose parser answers for it. */
const FORWARDS: Handling = { kind: 'forwards' };

/** Reads bare arguments only, and already refuses a line it cannot read. */
const POSITIONAL: Handling = { kind: 'positional' };

/**
 * How every command a developer can type in this tree treats an argument it
 * does not recognise. The map is the derivation of the affected set, made
 * executable: a module that becomes an entry point, or starts reading argv,
 * and is named in neither direction fails the completeness check below, so a
 * new script cannot quietly acquire a parser that ignores what it was not
 * written to expect.
 *
 * The population is entry points rather than argv readers because the two
 * differ: `verify-env.ts` reads its arguments through a default parameter and
 * holds no `process.argv` of its own, so a scan for that text alone put it out
 * of scope while it was silently dropping every flag but the one it wanted.
 *
 * What the map cannot see, stated so nobody reads more assurance into it than
 * it carries: it classifies by declaration, so a module declared `positional`
 * that later grows a flag still passes; it says nothing about what a parse
 * does with the arguments it does recognise; and of the `parsed` rows only
 * those declaring `effect: 'reports'` are proven by execution — see
 * {@link DRIVEN}.
 */
const ARGUMENT_HANDLING: Readonly<Record<string, Handling>> = {
  'backup.ts': parsed(() => import('./backup.js')),
  'build-admin-bundle.ts': parsed(() => import('./build-admin-bundle.js')),
  'build-marketing-site.ts': parsed(() => import('./build-marketing-site.js')),
  'build-web-bundle.ts': parsed(() => import('./build-web-bundle.js')),
  'cap-test-update.ts': parsed(() => import('./cap-test-update.js')),
  'clean.ts': parsed(() => import('./clean.js')),
  'concurrency.ts': parsed(() => import('./concurrency.js')),
  'configure-git-clone.ts': parsed(() => import('./configure-git-clone.js')),
  'release/deploy-shipped.ts': parsed(() => import('./release/deploy-shipped.js')),
  'release/deploy-verdict.ts': parsed(() => import('./release/deploy-verdict.js')),
  'dev-clean.ts': parsed(() => import('./dev-clean.js')),
  'dev.ts': parsed(() => import('./dev.js')),
  'docker-cleanup.ts': parsed(() => import('./docker-cleanup.js')),
  'drizzle-studio.ts': parsed(() => import('./drizzle-studio.js')),
  'e2e-clean.ts': parsed(() => import('./e2e-clean.js')),
  'e2e-preview.ts': parsed(() => import('./e2e-preview.js')),
  'encode-deploy-secrets.ts': parsed(() => import('./encode-deploy-secrets.js')),
  'ensure-gitleaks.ts': parsed(() => import('./ensure-gitleaks.js')),
  'ensure-stack-cli.ts': parsed(() => import('./ensure-stack-cli.js')),
  'escrow-secrets.ts': parsed(() => import('./escrow-secrets.js')),
  'exec-runtime-shim.ts': parsed(() => import('./exec-runtime-shim.js')),
  'gate-auditor.ts': parsed(() => import('./gate-auditor.js')),
  'generate-design-tokens.ts': parsed(() => import('./generate-design-tokens.js')),
  'generate-env.ts': parsed(() => import('./generate-env.js')),
  'generate-headers.ts': parsed(() => import('./generate-headers.js')),
  'gitleaks-scan.ts': parsed(() => import('./gitleaks-scan.js')),
  'publication/green-borrow.ts': parsed(() => import('./publication/green-borrow.js')),
  'legal-effective-dates.ts': parsed(() => import('./legal-effective-dates.js')),
  'linear/board.ts': parsed(() => import('./linear/board.js')),
  'lint-check.ts': parsed(() => import('./lint-check.js')),
  'merge-marketing-into-web.ts': parsed(() => import('./merge-marketing-into-web.js')),
  'mobile-test.ts': parsed(() => import('./mobile-test.js')),
  'normalize-commit-date.ts': parsed(() => import('./normalize-commit-date.js')),
  'normalize-migration-journal.ts': parsed(() => import('./normalize-migration-journal.js')),
  'preview.ts': parsed(() => import('./preview.js')),
  'publication/publish-mirror.ts': parsed(() => import('./publication/publish-mirror.js')),
  'publication/publish-staging-tip.ts': parsed(
    () => import('./publication/publish-staging-tip.js')
  ),
  'publish-model-weights.ts': parsed(() => import('./publish-model-weights.js')),
  'readme/generate-banner.ts': parsed(() => import('./readme/generate-banner.js')),
  'readme/generate-icons.ts': parsed(() => import('./readme/generate-icons.js')),
  'readme/generate-problem-flow.ts': parsed(() => import('./readme/generate-problem-flow.js')),
  'readme/generate-readme.ts': parsed(() => import('./readme/generate-readme.js')),
  'readme/generate-tables.ts': parsed(() => import('./readme/generate-tables.js')),
  'readme/preview-readme.ts': parsed(() => import('./readme/preview-readme.js')),
  'refresh-catalog.ts': parsed(() => import('./refresh-catalog.js')),
  'skills/generate-skills.ts': parsed(() => import('./skills/generate-skills.js')),
  'stack-teardown.ts': parsed(() => import('./stack-teardown.js')),
  'publication/sync-alignment.ts': parsed(() => import('./publication/sync-alignment.js')),
  'publication/sync-auditor.ts': parsed(() => import('./publication/sync-auditor.js')),
  'publication/sync-inbound.ts': parsed(() => import('./publication/sync-inbound.js')),
  'test-skills.ts': parsed(() => import('./test-skills.js')),
  'verify-bundle.ts': parsed(() => import('./verify-bundle.js')),
  'verify-commit-dates.ts': parsed(() => import('./verify-commit-dates.js')),
  'verify-document-paths.ts': parsed(() => import('./verify-document-paths.js')),
  'verify-db-objects.ts': parsed(() => import('./verify-db-objects.js')),
  'verify-design-tokens.ts': parsed(() => import('./verify-design-tokens.js')),
  'verify-env.ts': parsed(() => import('./verify-env.js')),
  'verify-evidence.ts': parsed(() => import('./verify-evidence.js')),
  'verify-licenses.ts': parsed(() => import('./verify-licenses.js')),
  'verify-typecheck-coverage.ts': parsed(() => import('./verify-typecheck-coverage.js')),
  'bake-mobile-image.ts': parsed(() => import('./bake-mobile-image.js')),
  'cards/cli.ts': parsed(() => import('./cards/cli.js')),
  'records/cli.ts': parsed(() => import('./records/cli.js')),
  'lib/stack/idle-killer-daemon-entry.ts': parsed(
    () => import('./lib/stack/idle-killer-daemon-entry.js')
  ),

  'compose.ts': FORWARDS,
  'docket.ts': FORWARDS,
  'e2e-run.ts': FORWARDS,
  'gitleaks.ts': FORWARDS,
  'lint-package.ts': FORWARDS,
  'lint-unused.ts': FORWARDS,
  'package-vitest.ts': FORWARDS,
  'run-checks.ts': FORWARDS,
  'run-package-tests.ts': FORWARDS,
  'run-workers-tests.ts': FORWARDS,
  'test-batch.ts': FORWARDS,
  'test-watch-ui.ts': FORWARDS,
  'test-watch.ts': FORWARDS,
  'turbo-pool.ts': FORWARDS,
  'turbo-run.ts': FORWARDS,
  'with-build-lease.ts': FORWARDS,
  'with-env.ts': FORWARDS,
  'with-run-claim.ts': FORWARDS,
  'with-runner-cache-claim.ts': FORWARDS,

  'bound-mutants.ts': POSITIONAL,
  'bound-sweep.ts': POSITIONAL,
  'cassette-store.ts': POSITIONAL,
  'release/compute-next-version.ts': POSITIONAL,
  'cron-trigger.ts': POSITIONAL,
  'db-auth-ready.ts': POSITIONAL,
  'db-bucket-ready.ts': POSITIONAL,
  'release/deploy-order-guard.ts': POSITIONAL,
  'extract-version.ts': POSITIONAL,
  'fix-binary-privacy.ts': POSITIONAL,
  'generate-assets.ts': POSITIONAL,
  'generate-screenshots.ts': POSITIONAL,
  'git-window.ts': POSITIONAL,
  'lib/cli/is-main.ts': POSITIONAL,
  'lib/cli/run-cli.ts': POSITIONAL,
  'lib/playwright/projects.ts': POSITIONAL,
  'lib/test-run/test-db-scratch-template.ts': POSITIONAL,
  'lib/wrangler/api-worker-entry.ts': POSITIONAL,
  'open-url.ts': POSITIONAL,
  'pre-push.ts': POSITIONAL,
  'privacy-check.ts': POSITIONAL,
  'privacy-gate.ts': POSITIONAL,
  'privacy-sweep.ts': POSITIONAL,
  'seed.ts': POSITIONAL,
  'stack-database-ready.ts': POSITIONAL,
  'stamp-build-identity.ts': POSITIONAL,
  'release/verify-deployed-surfaces.ts': POSITIONAL,
  'wrangler-dev.ts': POSITIONAL,
};

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'coverage', '.cache']);

/**
 * A module a developer can type at, or one that reads the arguments of a
 * process. The second half catches a helper that parses on an entry point's
 * behalf; the first catches an entry point that parses through one.
 */
function ownsACommandLine(source: string): boolean {
  return source.includes('isMainModule(import.meta.url)') || source.includes('process.argv');
}

async function commandLineModules(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('__')) continue;
      found.push(...(await commandLineModules(absolute)));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    if (!ownsACommandLine(readFileSync(absolute, 'utf8'))) continue;
    found.push(path.relative(SCRIPTS_DIR, absolute).split(path.sep).join('/'));
  }
  return found;
}

const PARSED = Object.entries(ARGUMENT_HANDLING).filter(
  (entry): entry is [string, Extract<Handling, { kind: 'parsed' }>] => entry[1].kind === 'parsed'
);

/**
 * A command line the check can type, and the words that reach it. A module that
 * dispatches on a command word declares one grammar per word beside its own, so
 * every word is driven rather than only the dispatch that routes to it.
 */
interface Driven {
  readonly module: string;
  readonly spec: CommandSpec;
  readonly words: readonly string[];
  /**
   * Whether both this line and the entry point it is typed at declare that
   * running them changes nothing. Read off the specifications themselves, so
   * the executed set cannot drift from what the entry points say about
   * themselves.
   */
  readonly reportsOnly: boolean;
}

/** A specification that has declared its run changes nothing. */
function reports(spec: CommandSpec | undefined): boolean {
  return spec?.effect === 'reports';
}

async function declarationsOf(
  module: string,
  handling: Extract<Handling, { kind: 'parsed' }>
): Promise<Driven[]> {
  const { COMMAND_LINE, SUBCOMMAND_LINES } = (await handling.load()) as {
    COMMAND_LINE?: CommandSpec;
    SUBCOMMAND_LINES?: Readonly<Record<string, CommandSpec>>;
  };
  if (COMMAND_LINE === undefined) throw new Error(`${module} exports no COMMAND_LINE spec`);
  return [
    { module, spec: COMMAND_LINE, words: [], reportsOnly: reports(COMMAND_LINE) },
    ...Object.entries(SUBCOMMAND_LINES ?? {}).map(([word, spec]) => ({
      module,
      spec,
      words: [word],
      reportsOnly: reports(COMMAND_LINE) && reports(spec),
    })),
  ];
}

const loaded = await Promise.all(
  PARSED.map(([module, handling]) => declarationsOf(module, handling))
);

const DECLARED: readonly Driven[] = loaded.flat();

/** An argument no grammar in this tree names, so every command line must refuse it. */
const UNKNOWN_FLAG = '--not-a-flag-this-takes';

const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/**
 * The keys a Node process needs to start, and nothing else.
 *
 * Driving an entry point in this environment is the assertion: what a command
 * prints when asked for its usage is decided by the command line alone. It is
 * how the board CLI's defect shows up — an entry that builds its API client
 * before parsing demands a write credential from the one person who typed a
 * help flag because they do not yet know what the tool does.
 */
const STARTUP_ENVIRONMENT: NodeJS.ProcessEnv = Object.fromEntries(
  ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);

interface Outcome {
  /** Undefined when a signal ended the process, which is a failure like any other. */
  readonly exitCode: number | undefined;
  readonly output: string;
}

/**
 * Run one module the way a developer runs it, and report what the process did.
 *
 * The module is executed rather than imported because the defects this check
 * exists to catch live in the wiring between a declared grammar and the entry
 * that is supposed to consult it, and an import reaches the grammar without
 * ever crossing that wiring.
 */
async function drive(module: string, args: readonly string[]): Promise<Outcome> {
  const entry = path.join(SCRIPTS_DIR, ...module.split('/'));
  const run = await execa(process.execPath, ['--import', TSX_LOADER, entry, ...args], {
    cwd: REPO_ROOT,
    env: STARTUP_ENVIRONMENT,
    extendEnv: false,
    all: true,
    reject: false,
    timeout: 120_000,
  });
  return { exitCode: run.exitCode, output: run.all };
}

interface Driving {
  readonly row: Driven;
  readonly help: Outcome;
  readonly refusal: Outcome;
}

async function driveBoth(row: Driven): Promise<Driving> {
  return {
    row,
    help: await drive(row.module, [...row.words, '--help']),
    refusal: await drive(row.module, [...row.words, UNKNOWN_FLAG]),
  };
}

/**
 * The command lines this check EXECUTES, as against the ones it only inspects.
 *
 * Driving an entry point is running it, and running it is safe only while its
 * wiring holds: the entry refuses the line before it acts. That is exactly the
 * property under test, so a check that drove every entry would carry out the
 * act — end this machine's processes, recreate its stack — on the day the
 * property broke, which is the worst moment for a test suite to become the
 * hazard it was written to catch.
 *
 * So the executed set is what the entry points themselves license: a
 * specification declaring `effect: 'reports'` says its run changes nothing, and
 * an entry declaring nothing is read as able to act and is never executed here.
 * The wiring of every other entry point — that its main guard reads its own
 * declared grammar before anything else runs — is held structurally instead, by
 * the `entry-points-read-their-command-line-first` architecture rule, which
 * proves it without starting a process.
 */
const DRIVEN: readonly Driven[] = DECLARED.filter(({ reportsOnly }) => reportsOnly);

/** How many entry points run at once. Each is a process; the bound keeps the check cheap. */
const AT_ONCE = 5;

const DRIVINGS: Driving[] = [];
for (let index = 0; index < DRIVEN.length; index += AT_ONCE) {
  DRIVINGS.push(
    ...(await Promise.all(DRIVEN.slice(index, index + AT_ONCE).map((row) => driveBoth(row))))
  );
}

describe('argument handling across scripts/', () => {
  it('classifies every module that owns a command line', async () => {
    const found = await commandLineModules(SCRIPTS_DIR);
    expect(found.toSorted((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(ARGUMENT_HANDLING).toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('reads a command line for every module declared as parsing its own', () => {
    expect(new Set(DECLARED.map(({ module }) => module))).toEqual(
      new Set(PARSED.map(([module]) => module))
    );
  });

  it('executes only command lines whose entry point declares its run changes nothing', () => {
    expect(DRIVINGS.filter(({ row }) => row.spec.effect !== 'reports')).toEqual([]);
  });

  it('executes at least one entry point, so the driven half is not dead machinery', () => {
    expect(DRIVINGS.length).toBeGreaterThan(0);
  });
});

describe.each(DRIVINGS)('$row.spec.command (in $row.module)', ({ row, help, refusal }) => {
  it('answers a help request with usage and exits zero, at its own entry', () => {
    expect({ exitCode: help.exitCode, names: help.output.includes(row.spec.command) }).toEqual({
      exitCode: 0,
      names: true,
    });
  });

  it('refuses an argument it does not name, at its own entry', () => {
    expect({
      failed: refusal.exitCode !== 0,
      names: refusal.output.includes(UNKNOWN_FLAG),
    }).toEqual({ failed: true, names: true });
  });
});

describe.each(DECLARED)('$spec.command (in $module)', ({ spec }) => {
  it('refuses a flag it does not name', () => {
    expect(() => parseCommandLine(spec, [UNKNOWN_FLAG])).toThrow(UNKNOWN_FLAG);
  });

  it('reads --help as a request for usage rather than a run', () => {
    expect(parseCommandLine(spec, ['--help']).kind).toBe('help');
  });

  it('prints usage naming the command a developer types', () => {
    expect(formatUsage(spec)).toContain(spec.command);
  });
});

describe.each(DECLARED.filter(({ spec }) => spec.flags.length > 0))(
  '$spec.command (in $module)',
  ({ spec }) => {
    it('refuses a misspelling of a flag it does name', () => {
      const misspelt = `${spec.flags[0]?.flag ?? ''}x`;
      expect(() => parseCommandLine(spec, [misspelt])).toThrow(misspelt);
    });
  }
);

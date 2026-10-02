// The browser-matrix extension is the one ESLint extension that imports
// TypeScript (the E2E project registry) directly, so it is the one whose load
// can fail for a reason that has nothing to do with lint. The facts below are
// about that import: that it really is the registry being passed to the rule,
// and that losing it says, in words, WHICH of the two causes it was — a Node
// without type stripping, or a Node where someone turned it off. The message
// names an action either way, so the action clause proves neither; only the
// cause clause separates them, and each direction is asserted on the substring
// the other cannot produce.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PLANE_PROJECTS } from '../../../scripts/lib/playwright/projects.ts';
import extensionConfig from './browser-matrix.config.mjs';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const configUrl = pathToFileURL(path.join(here, 'browser-matrix.config.mjs')).href;

/** The clause that names the cause. Absent from the message's static action clause. */
const FLAG_CAUSE = '--no-experimental-strip-types set, which turns type stripping off';

/**
 * The version sentence running straight into the action with nothing between
 * them — what the message reads like when no flag is set anywhere.
 *
 * One contiguous span rather than a positive assertion plus a `not`: the message
 * is built as a single string, so a cause clause appearing anywhere in this
 * region breaks the span, whereas a separate negative could only execute after
 * the positive had already passed — and under the mutants that matter it never
 * got that far.
 */
const NO_CAUSE_TAIL =
  `Running: Node ${process.version}. ` +
  'Do this: run lint on Node 22.18 or newer and do not pass --no-experimental-strip-types.';

/**
 * This process's environment with `NODE_OPTIONS` removed, so a child's value for
 * it is only ever the one a caller declares. Stripping it here rather than
 * overwriting it is what lets a caller ask for the variable to be ABSENT, which
 * is a third state and the one most machines are actually in.
 */
const { NODE_OPTIONS: _ambientNodeOptions, ...AMBIENT_ENVIRONMENT } = process.env;

/**
 * The default: the variable present and empty, which is not the same state as absent.
 * @type {NodeJS.ProcessEnv}
 */
const CLEARED_NODE_OPTIONS = { NODE_OPTIONS: '' };

/**
 * The stderr of a child Node that failed to load the extension at `url`.
 *
 * A child because every one of these states is a process-start decision. The
 * default clears `NODE_OPTIONS` rather than inheriting it, so an assertion reads
 * this invocation's flags and not whatever the ambient environment carries — a
 * machine exporting the flag would otherwise invert a no-flag case silently. A
 * caller testing a carrier declares its own environment: `{ NODE_OPTIONS: flag }`
 * for the carrier lint actually arrives through (pnpm and turbo pass an
 * environment, not a node command line), or `{}` for the variable being unset,
 * which is the state the guard meets on a machine nobody has configured.
 *
 * @param {string} url
 * @param {string[]} nodeArguments
 * @param {NodeJS.ProcessEnv} [environment]
 */
async function stderrOfLoading(url, nodeArguments, environment = CLEARED_NODE_OPTIONS) {
  try {
    await execFileAsync(
      process.execPath,
      [...nodeArguments, '--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      { cwd: here, env: { ...AMBIENT_ENVIRONMENT, ...environment } }
    );
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) throw error;
    return `${error.stderr}`;
  }
  throw new Error('the extension loaded, so this can prove nothing about how it fails');
}

/**
 * State one: type stripping switched off. A developer on Node < 22.18 is in it
 * permanently, and this repo declares no floor that would keep anyone out of it.
 *
 * The flag reaches the guard by two routes and the guard reads both, so each is
 * loaded separately: a node command line (rare — nobody types one to run lint)
 * and `NODE_OPTIONS` (the realistic one, since pnpm and turbo carry the
 * environment and not the argv).
 */
const loadWithFlagOnCommandLine = () =>
  stderrOfLoading(configUrl, ['--no-experimental-strip-types']);

const loadWithFlagInNodeOptions = () =>
  stderrOfLoading(configUrl, [], { NODE_OPTIONS: '--no-experimental-strip-types' });

/**
 * State two: type stripping working, registry unreachable. Reached by loading a
 * byte-copy of the shipped extension from a directory where its relative
 * registry path resolves to nothing; the rule import is shimmed back to the real
 * one so that the registry is the only thing broken.
 *
 * Takes the child's environment because the guard reads `NODE_OPTIONS` on every
 * path through it, including this one where no flag is set anywhere: the
 * variable being cleared and the variable being absent are different states of
 * that read, and only the second is what an unconfigured machine presents.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 */
async function loadWhereTheRegistryIsMissing(environment) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-matrix-'));
  try {
    await mkdir(path.join(directory, 'rules'));
    const rule = pathToFileURL(path.join(here, 'rules', 'matrix-declaration.mjs')).href;
    await writeFile(
      path.join(directory, 'rules', 'matrix-declaration.mjs'),
      `export { default } from ${JSON.stringify(rule)};\n`
    );
    const copy = path.join(directory, 'browser-matrix.config.mjs');
    await copyFile(path.join(here, 'browser-matrix.config.mjs'), copy);
    return await stderrOfLoading(pathToFileURL(copy).href, [], environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the browser-matrix extension', () => {
  it('passes the rule the plane projects the registry declares', () => {
    const [entry] = extensionConfig;
    if (entry === undefined) throw new Error('the extension registers no config entry');
    expect(entry.rules['browser-matrix/matrix-declaration'][1].planes).toEqual(PLANE_PROJECTS);
  });

  it('names the Node requirement and what is missing when it cannot read the registry', async () => {
    const stderr = await loadWithFlagOnCommandLine();
    // Each of these is a whole sentence only the guard emits. Node's own
    // ERR_UNKNOWN_FILE_EXTENSION text carries the registry path and its crash
    // footer carries the running version, so a bare path, a bare version or the
    // bare words "type stripping" would all be satisfied by the very output this
    // guard exists to replace — an assertion passing on the failure it is meant
    // to have prevented.
    expect(stderr).toContain(
      'ESLint cannot read the E2E project registry (scripts/lib/playwright/projects.ts).'
    );
    expect(stderr).toContain(
      "The browser-matrix extension imports it as TypeScript, which needs Node's type stripping."
    );
    expect(stderr).toContain(
      'Required: Node 22.18 or newer, where type stripping is on by default.'
    );
    expect(stderr).toContain(`Running: Node ${process.version}`);
  });

  it('blames the flag when a node command line is what turned stripping off', async () => {
    expect(await loadWithFlagOnCommandLine()).toContain(FLAG_CAUSE);
  });

  it('blames the flag when NODE_OPTIONS is what turned stripping off', async () => {
    // The carrier a developer actually trips: lint runs through pnpm and turbo,
    // which pass an environment, not a node command line.
    expect(await loadWithFlagInNodeOptions()).toContain(FLAG_CAUSE);
  });

  it('still explains itself when NODE_OPTIONS is not set at all', async () => {
    // The state of an unconfigured machine, and the one the guard is most likely
    // to run in. Reading the unset variable as a string is what keeps this an
    // explanation rather than a crash inside the code that exists to prevent one.
    const stderr = await loadWhereTheRegistryIsMissing({});
    expect(stderr).toContain(NO_CAUSE_TAIL);
  });

  it('blames no flag when stripping is on and the registry is simply unreachable', async () => {
    const stderr = await loadWhereTheRegistryIsMissing();
    // The reader is told the runtime is fine and the path is not.
    expect(stderr).toContain(NO_CAUSE_TAIL);
  });
});

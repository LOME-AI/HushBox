import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { reachesThroughReferences, referencedScripts, rootScripts } from './lib/root-manifest.js';
import { ENV_MODE_FLAG } from './with-env.js';

const WITH_ENV = 'scripts/with-env.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** The mutation runner, as a manifest token names it. */
const MUTATION_RUNNER = 'stryker';

/** As much of the mutation runner's configuration as the question needs. */
const MutationConfig = z.object({ testRunner: z.string() });

function mutationTestRunner(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'stryker.config.json'), 'utf8')
  );
  return MutationConfig.parse(parsed).testRunner;
}

/**
 * Root scripts known to run on the e2e stack today. The derivation below finds
 * them on its own; this list is the non-vacuity floor, so a discovery bug that
 * narrows the derived set to nothing cannot pass silently.
 */
const KNOWN_E2E_SCRIPTS: readonly string[] = [
  'e2e',
  'e2e:admin',
  'e2e:prepare',
  'weights:seed:e2e',
];

/**
 * The same floor for the scripts that run the suite, which runs on the stack of
 * its own name. The watcher and the mutation entries are in it because each was
 * once written without a selection, which is the defect this floor keeps
 * derivable.
 */
const KNOWN_TEST_SCRIPTS: readonly string[] = [
  'test',
  'test:all',
  'test:api',
  'test:watch',
  'mutation',
  'mutation:incremental',
];

/**
 * The root script every bring-up in this manifest goes through. A script that
 * runs the suite has to reach this one: the stack it names carries a database
 * of its own, and a checkout that has never brought that stack up has never
 * made it.
 */
const BRING_UP_SCRIPT = 'ensure-stack';

/** A root script whose name puts it in the e2e family. */
function isE2eScriptName(name: string): boolean {
  return /^e2e(:|$)/.test(name) || name.endsWith(':e2e');
}

/**
 * A root script that runs the suite: the test family by name, and any script
 * running the mutation runner, whose configuration drives the suite as its test
 * runner rather than saying so in the name.
 */
function runsTheSuite(name: string, body: string): boolean {
  return /^test(:|$)/.test(name) || body.includes(MUTATION_RUNNER);
}

/**
 * The e2e-family scripts that load env through the wrapper. A family member
 * that reaches the wrapper only through another pnpm script is not one: the
 * script it delegates to carries the selection, and the stack propagates from
 * there through the loaded scripts file.
 */
function wrappedE2eScripts(): [string, string][] {
  return Object.entries(rootScripts()).filter(
    ([name, body]) => isE2eScriptName(name) && body.includes(WITH_ENV)
  );
}

/**
 * Every root script that runs the suite, wrapped or not. Unwrapped is not an
 * exemption here as it is for the e2e family above: a script that runs the
 * suite reaches the data plane the suite writes, so one reaching no wrapper is
 * the defect rather than a member that carries its selection elsewhere.
 */
function suiteScripts(): [string, string][] {
  return Object.entries(rootScripts()).filter(([name, body]) => runsTheSuite(name, body));
}

/**
 * Whether running a body reaches the one bring-up, however many scripts it
 * delegates through. The bring-up is named as the root script rather than as
 * the module behind it, because what a suite entry has to adopt is the
 * preparation every sibling already runs, not a second path to the same state.
 */
function bringsStackUp(body: string, scripts: Readonly<Record<string, string>>): boolean {
  return reachesThroughReferences(body, scripts, (reached) =>
    referencedScripts(reached, scripts).includes(BRING_UP_SCRIPT)
  );
}

describe('e2e root scripts', () => {
  it('finds the e2e-family scripts that load env through the wrapper', () => {
    const names = wrappedE2eScripts().map(([name]) => name);

    expect(names).toEqual(expect.arrayContaining([...KNOWN_E2E_SCRIPTS]));
  });

  it('finds the scripts that run the suite', () => {
    const names = suiteScripts().map(([name]) => name);

    expect(names).toEqual(expect.arrayContaining([...KNOWN_TEST_SCRIPTS]));
  });

  it('still names the suite as what the mutation runner drives', () => {
    expect(
      mutationTestRunner(),
      "the mutation entries are held to the suite's stack because this is what they run; a runner that is no longer the suite makes that claim untrue"
    ).toBe('vitest');
  });

  it('selects the e2e stack on every one of them', () => {
    const missing = wrappedE2eScripts()
      .filter(([, body]) => !body.includes(`${WITH_ENV} ${ENV_MODE_FLAG} e2e`))
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  it('selects the test stack on every script that runs the suite', () => {
    const missing = suiteScripts()
      .filter(([, body]) => !body.includes(`${WITH_ENV} ${ENV_MODE_FLAG} test`))
      .map(([name]) => name);

    expect(
      missing,
      'these run the suite against whichever stack the environment already names, which on a developer machine is the one a running dev stack is using'
    ).toEqual([]);
  });

  // What the case below asserts is an empty list, which a derivation that
  // reads a bring-up into every body also produces. This is the other half of
  // that non-vacuity floor: a script that runs the suite and prepares nothing
  // is still recognised as preparing nothing.
  it('still recognises a script that runs the suite with nothing preparing its stack', () => {
    const scripts = {
      'a-suite-run': `tsx ${WITH_ENV} ${ENV_MODE_FLAG} test vitest`,
      [BRING_UP_SCRIPT]: 'tsx scripts/ensure-stack-cli.ts',
    };

    expect(bringsStackUp(scripts['a-suite-run'], scripts)).toBe(false);
  });

  it('brings its stack up on every script that runs the suite', () => {
    const scripts = rootScripts();
    const missing = suiteScripts()
      .filter(([, body]) => !bringsStackUp(body, scripts))
      .map(([name]) => name);

    expect(
      missing,
      `these run the suite against a stack nothing has made: the database that stack resolves is created by the bring-up, and a checkout that has never run one has never had it. Run the bring-up first, as \`pnpm ${BRING_UP_SCRIPT}\` under scripts/with-run-claim.ts, the way every sibling that runs the suite already does`
    ).toEqual([]);
  });

  it('leaves the flag off the scripts that load the default stack', () => {
    const stray = Object.entries(rootScripts())
      .filter(([name, body]) => !isE2eScriptName(name) && !runsTheSuite(name, body))
      .filter(([, body]) => body.includes(`${WITH_ENV} ${ENV_MODE_FLAG}`))
      .map(([name]) => name);

    expect(stray).toEqual([]);
  });
});

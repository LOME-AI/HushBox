// Every vitest invocation is sized from one store of what this machine has
// really run, so every vitest invocation has to put its own run into that
// store. A launcher records the run it spawned from outside it; a run nobody
// launched — the watch-mode UI, and any bare runner resolving this
// configuration — has no such outside, and its only end-of-run moment is a
// reporter this configuration declares for itself.
//
// Which is also why the declaration cannot double-record: vitest replaces the
// resolved reporter list wholesale as soon as a command line names a reporter
// of its own, and every launcher that records names one. The last two
// assertions here are that behaviour of the runner, measured rather than
// remembered, because it is what keeps the two recorders off the same run.
import { fileURLToPath } from 'node:url';

import { resolveConfig } from 'vitest/node';
import { describe, expect, it } from 'vitest';

import rootConfig from './vitest.config.ts';

const CONFIG_FILE = fileURLToPath(new URL('vitest.config.ts', import.meta.url));

/** The reporters given as objects; a name and a `[name, options]` pair are neither. */
function inlineReporters(reporters) {
  return (reporters ?? []).filter(
    (reporter) => typeof reporter === 'object' && reporter !== null && !Array.isArray(reporter)
  );
}

/** What each declared object reporter offers as an end-of-run hook. */
function endOfRunHooks(reporters) {
  return inlineReporters(reporters).map((reporter) => typeof reporter.onTestRunEnd);
}

describe('the shared test configuration', () => {
  it('declares an end-of-run hook of its own', () => {
    expect(endOfRunHooks(rootConfig.test.reporters)).toEqual(['function']);
  });

  it('keeps the console reporter its own declaration would otherwise displace', () => {
    expect(rootConfig.test.reporters?.[0]).toBe('default');
  });

  it('survives a run whose command line names no reporter', async () => {
    const { vitestConfig } = await resolveConfig({ config: CONFIG_FILE, watch: false });

    expect(endOfRunHooks(vitestConfig.reporters)).toEqual(['function']);
  });

  it('is dropped by a run whose command line names its own reporters', async () => {
    const { vitestConfig } = await resolveConfig({
      config: CONFIG_FILE,
      watch: false,
      reporter: ['default', 'json'],
    });

    // The declared count rides in the same assertion because without it the
    // survivors being empty is equally true of a configuration that declared
    // nothing — which is the state this whole file exists to leave behind.
    expect({
      declared: inlineReporters(rootConfig.test.reporters).length,
      survived: inlineReporters(vitestConfig.reporters).length,
    }).toEqual({ declared: 1, survived: 0 });
  });
});

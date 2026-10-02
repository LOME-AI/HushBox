/**
 * The duplication gate's threshold is the number `.jscpd.json` declares, as
 * the tool itself merges it.
 *
 * Read from the tool rather than from the file, because jscpd can fail open:
 * a config that loses its `threshold` key merges to no threshold at all, and
 * with none the check that fails the run is never added. A wrong-typed value
 * under an explicit `--config` is fatal, so it needs no guard here; what
 * survives that is an absent or renamed key and the diagnostics jscpd prints
 * and carries on past, which is why its stderr is held to the one line naming
 * the config it loaded.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { rootScripts, tokensOf } from './lib/root-manifest.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const CONFIG_FILE = '.jscpd.json';

const SCAN_SCRIPT = 'duplication:scan';

const CONFIG_SOURCE_LINE = `Using config from ${CONFIG_FILE}`;

const DeclaredShape = z.object({ threshold: z.number() });

const MergedShape = z.object({ threshold: z.number().nullable() });

interface DebugRun {
  readonly threshold: number | null;
  readonly stderrLines: readonly string[];
}

/** The words the scan script passes to jscpd, the command name dropped. */
function scanArguments(): string[] {
  const body = rootScripts()[SCAN_SCRIPT];
  if (body === undefined) throw new Error(`package.json declares no "${SCAN_SCRIPT}" script`);
  const [command, ...rest] = tokensOf(body);
  if (command !== 'jscpd') throw new Error(`"${SCAN_SCRIPT}" does not run jscpd`);
  return rest;
}

function declaredThreshold(): number {
  const raw: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, CONFIG_FILE), 'utf8'));
  return DeclaredShape.parse(raw).threshold;
}

/**
 * The scan's own arguments plus `--debug`, which prints the merged
 * configuration and exits without scanning. The launcher is run under the
 * current Node rather than through a shell so the same call works on every
 * platform jscpd ships a binary for.
 */
function debugRun(): DebugRun {
  const launcher = createRequire(import.meta.url).resolve('jscpd/run-jscpd.js');
  const child = spawnSync(process.execPath, [launcher, ...scanArguments(), '--debug'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    throw new Error(`jscpd --debug exited ${String(child.status)}: ${child.stderr}`);
  }
  const merged = MergedShape.parse(JSON.parse(child.stdout));
  return {
    threshold: merged.threshold,
    stderrLines: child.stderr.split(/\r?\n/).filter((line) => line.length > 0),
  };
}

let cachedRun: DebugRun | undefined;

function mergedRun(): DebugRun {
  cachedRun ??= debugRun();
  return cachedRun;
}

describe('duplication threshold', () => {
  it('is loaded from the config file named explicitly by the scan', () => {
    const args = scanArguments();
    const at = args.indexOf('--config');

    expect(args.slice(at, at + 2)).toEqual(['--config', CONFIG_FILE]);
  });

  it('is not passed on the scan command line', () => {
    expect(scanArguments()).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(--threshold|-t)(=|$)/)])
    );
  });

  it('merges to a number rather than to no threshold', () => {
    expect(mergedRun().threshold).toEqual(expect.any(Number));
  });

  it('merges to the number the config file declares', () => {
    expect(mergedRun().threshold).toBe(declaredThreshold());
  });

  it('loads with no diagnostic beyond the line naming its config', () => {
    expect(mergedRun().stderrLines).toEqual([CONFIG_SOURCE_LINE]);
  });
});

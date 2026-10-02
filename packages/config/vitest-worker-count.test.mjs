// A package config that merges this one carries the ceiling it declares, so a
// run vitest resolves against such a config reads this declaration. A run
// resolved against the consolidated root config reads it too — that config
// lifts each package config, drops this declaration from the lift, and
// spreads this config's test options into its own root block — and the batch
// coordinator passes the same count on its command line. One decision, taken
// from the derivation by every site that needs the count rather than spelled
// at any of them: a figure spelled here decays on every machine nobody
// measured, and the shapes would stop agreeing about it.
//
// The ceiling a worker reads here is the ceiling a real run uses only because
// it is declared unconditionally. A vitest worker's own argv carries neither
// the subcommand nor the flags the run was launched with, so a declaration
// gated on argv resolves to its other branch in every case written here.
//
// Asserted against the shared assembly rather than against a second spelling of
// its arguments: a re-derivation here would be two implementations kept in
// agreement by this file, which is the shape `docs/CODE-RULES.md` §One
// Implementation, Shared forbids. What survives is the property the file was
// written for — that the declaration is taken from the derivation rather than
// spelled — and it survives because a spelled figure cannot match a derived
// one on every machine.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { machineFingerprint } from '../../scripts/lib/pool/machine.ts';
import { deriveRepositoryVitestWorkers } from '../../scripts/lib/vitest/workers.ts';
import rootConfig from './vitest.config.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('shared worker ceiling', () => {
  it('is the count the shared derivation gives for this machine and what it has run', () => {
    expect(rootConfig.test.maxWorkers).toBe(
      deriveRepositoryVitestWorkers(REPO_ROOT, machineFingerprint()).derivation.workers
    );
  });
});

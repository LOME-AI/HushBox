import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withScratchDirectory } from './lib/scratch-directory.js';
import {
  allowedBy,
  deadExceptions,
  formatOffender,
  licensedPackagesIn,
  lockedPackageNames,
  offendersIn,
  parseLicensePolicy,
  pnpmLicenseDependencies,
  readLicensePolicy,
  readRootDevPackages,
  runLicenseCheck,
  type LicenseCheckDependencies,
  type LicensedPackage,
  type LicensePolicy,
  type LicenseListing,
} from './verify-licenses.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_PREFIX = 'hushbox-licenses-';

/** Stands for the ruled allowlist wherever a case only needs a couple of ids. */
const ALLOW = new Set(['MIT', 'ISC', 'Apache-2.0', 'CC0-1.0', 'BSD-2-Clause']);

function policyOf(
  allow: readonly string[],
  exceptions: Readonly<Record<string, string>> = {}
): LicensePolicy {
  return { allow, exceptions };
}

function packageOf(name: string, version: string, license: string): LicensedPackage {
  return { name, version, license };
}

function dependenciesOver(
  listing: LicenseListing,
  policy: LicensePolicy,
  locked: readonly string[] = [],
  rootDev: readonly LicensedPackage[] = []
): LicenseCheckDependencies {
  return {
    listing: () => Promise.resolve(listing),
    policy: () => Promise.resolve(policy),
    lockedNames: () => Promise.resolve(new Set(locked)),
    rootDevPackages: () => Promise.resolve(rootDev),
  };
}

async function writeManifest(root: string, manifest: unknown): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest), 'utf8');
}

async function writeInstalled(root: string, name: string, manifest: unknown): Promise<void> {
  const directory = path.join(root, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest), 'utf8');
}

/**
 * A workspace the listing command matches but finds nothing to license in. It
 * answers that case in prose — "No licenses in packages found" on stdout, exit
 * zero — so this fixture is what proves a zero exit is not evidence of JSON.
 */
async function writeDependencyFreeWorkspace(root: string): Promise<void> {
  await writeManifest(root, { name: 'workspace-root', version: '0.0.0' });
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - member\n', 'utf8');
  await mkdir(path.join(root, 'member'), { recursive: true });
  await writeFile(
    path.join(root, 'member', 'package.json'),
    JSON.stringify({ name: 'member', version: '0.0.0' }),
    'utf8'
  );
  await writeFile(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  member: {}\n",
    'utf8'
  );
}

describe('the licence expression an allowlist admits', () => {
  it('admits a bare id the allowlist names', () => {
    expect(allowedBy('MIT', ALLOW)).toBe(true);
  });

  it('refuses a bare id the allowlist omits', () => {
    expect(allowedBy('GPL-3.0-only', ALLOW)).toBe(false);
  });

  it('admits a disjunction one of whose operands is allowed', () => {
    expect(allowedBy('GPL-2.0-only OR MIT', ALLOW)).toBe(true);
  });

  it('refuses a disjunction no operand of which is allowed', () => {
    expect(allowedBy('GPL-2.0-only OR AGPL-3.0', ALLOW)).toBe(false);
  });

  it('admits a conjunction whose every operand is allowed', () => {
    expect(allowedBy('MIT AND ISC', ALLOW)).toBe(true);
  });

  it('refuses a conjunction one of whose operands is not allowed', () => {
    expect(allowedBy('MIT AND GPL-3.0-only', ALLOW)).toBe(false);
  });

  it('reads a parenthesised disjunction', () => {
    expect(allowedBy('(MIT OR CC0-1.0)', ALLOW)).toBe(true);
  });

  it('binds a conjunction tighter than the disjunction around it', () => {
    // `A AND B OR C` is `(A AND B) OR C`, so an allowed C carries the whole.
    expect(allowedBy('GPL-3.0-only AND AGPL-3.0 OR MIT', ALLOW)).toBe(true);
  });

  it('refuses an expression naming no licence at all', () => {
    expect(allowedBy('Unknown', ALLOW)).toBe(false);
  });

  it('refuses a manifest that points at a file instead of naming a licence', () => {
    expect(allowedBy('SEE LICENSE IN LICENSE.md', ALLOW)).toBe(false);
  });

  it('refuses prose carrying a licence name it cannot parse', () => {
    expect(allowedBy('Remotion License https://remotion.dev/license', ALLOW)).toBe(false);
  });

  it('refuses an id whose case differs from the ruled spelling', () => {
    // The allowlist is a ruling, so `UNLICENSE` is reported for a human to
    // rule rather than silently matched against `Unlicense`.
    expect(allowedBy('UNLICENSE', new Set(['Unlicense']))).toBe(false);
  });

  it('refuses an empty expression', () => {
    expect(allowedBy('', ALLOW)).toBe(false);
  });

  it('refuses a disjunction missing its right operand', () => {
    expect(allowedBy('MIT OR', ALLOW)).toBe(false);
  });

  it('refuses an unclosed parenthesis', () => {
    expect(allowedBy('(MIT OR ISC', ALLOW)).toBe(false);
  });

  it('refuses an expression opening with a closing parenthesis', () => {
    expect(allowedBy(') MIT', ALLOW)).toBe(false);
  });

  it('refuses an expression opening with an operator', () => {
    expect(allowedBy('AND MIT', ALLOW)).toBe(false);
  });
});

describe('the packages a listing names', () => {
  it('reads one package under its licence', () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    expect(licensedPackagesIn(listing)).toEqual([packageOf('left-pad', '1.3.0', 'MIT')]);
  });

  it('reads a package installed at more than one version as one entry each', () => {
    const listing: LicenseListing = { ISC: [{ name: 'sax', versions: ['1.6.0', '1.6.1'] }] };
    expect(licensedPackagesIn(listing).map(({ version }) => version)).toEqual(['1.6.0', '1.6.1']);
  });

  it('carries the licence expression its group is keyed by', () => {
    const listing: LicenseListing = { Unknown: [{ name: 'remotion', versions: ['4.0.488'] }] };
    expect(licensedPackagesIn(listing)[0]?.license).toBe('Unknown');
  });
});

describe('the packages a policy refuses', () => {
  it('passes a package whose licence the allowlist names', () => {
    expect(offendersIn([packageOf('left-pad', '1.3.0', 'MIT')], policyOf(['MIT']))).toEqual([]);
  });

  it('reports a package whose licence the allowlist omits', () => {
    const offenders = offendersIn([packageOf('sjcl', '1.0.9', 'GPL-2.0-only')], policyOf(['MIT']));
    expect(offenders.map(({ name }) => name)).toEqual(['sjcl']);
  });

  it('passes a refused package an exception names', () => {
    const policy = policyOf(['MIT'], { sjcl: 'vendored crypto, reviewed' });
    expect(offendersIn([packageOf('sjcl', '1.0.9', 'GPL-2.0-only')], policy)).toEqual([]);
  });

  it('passes a refused package at whatever version the tree installs', () => {
    const policy = policyOf(['MIT'], { sjcl: 'vendored crypto, reviewed' });
    expect(offendersIn([packageOf('sjcl', '1.0.8', 'GPL-2.0-only')], policy)).toEqual([]);
  });

  it('reports a refused package no exception names', () => {
    const policy = policyOf(['MIT'], { khroma: 'reviewed' });
    const offenders = offendersIn([packageOf('sjcl', '1.0.9', 'GPL-2.0-only')], policy);
    expect(offenders.map(({ name }) => name)).toEqual(['sjcl']);
  });
});

describe('the exceptions nothing installed answers for', () => {
  it('keeps an exception naming a package the lockfile holds', () => {
    const policy = policyOf(['MIT'], { sjcl: 'reviewed' });
    expect(deadExceptions(policy, new Set(['sjcl']))).toEqual([]);
  });

  it('reports an exception naming a package the lockfile no longer holds', () => {
    const policy = policyOf(['MIT'], { sjcl: 'reviewed' });
    expect(deadExceptions(policy, new Set(['khroma']))).toEqual(['sjcl']);
  });
});

describe('the package names a lockfile holds', () => {
  it('reads an unscoped key as the package it names', () => {
    const lockfile = ['packages:', '', '  khroma@2.1.0:', '    resolution: {integrity: sha512-x}'];
    expect(lockedPackageNames(lockfile.join('\n')).has('khroma')).toBe(true);
  });

  it('reads a scoped key written in quotes as the package it names', () => {
    const lockfile = [
      'packages:',
      '',
      "  '@remotion/bundler@4.0.488':",
      '    resolution: {integrity: sha512-x}',
    ];
    expect(lockedPackageNames(lockfile.join('\n')).has('@remotion/bundler')).toBe(true);
  });

  it('reads one name for a package the lockfile resolves at two versions', () => {
    const lockfile = ['packages:', '', '  sax@1.6.0:', '    x: y', '  sax@1.6.1:', '    x: y'];
    expect([...lockedPackageNames(lockfile.join('\n'))]).toEqual(['sax']);
  });

  it('reads no name from a section other than the package list', () => {
    const lockfile = ['importers:', '', '  .:', '    dependencies:', '      zod:', '        x: y'];
    expect(lockedPackageNames(lockfile.join('\n')).size).toBe(0);
  });
});

describe('the policy file', () => {
  it('reads an allowlist and an exceptions map', () => {
    const parsed = parseLicensePolicy({ allow: ['MIT'], exceptions: { 'sjcl@1.0.9': 'reviewed' } });
    expect(parsed).toEqual({ allow: ['MIT'], exceptions: { 'sjcl@1.0.9': 'reviewed' } });
  });

  it('refuses a policy whose allowlist is not a list of ids', () => {
    expect(() => parseLicensePolicy({ allow: 'MIT', exceptions: {} })).toThrow(/allow/);
  });

  it('refuses an exception carrying no reason', () => {
    expect(() => parseLicensePolicy({ allow: ['MIT'], exceptions: { 'sjcl@1.0.9': 1 } })).toThrow(
      /exceptions/
    );
  });
});

describe('how a finding reads', () => {
  it('names the package, its version and what its manifest declares', () => {
    expect(formatOffender(packageOf('remotion', '4.0.488', 'Unknown'))).toBe(
      '  remotion@4.0.488  Unknown'
    );
  });
});

describe('the check over a dependency set', () => {
  it('passes when every licence is allowed', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const outcome = await runLicenseCheck(dependenciesOver(listing, policyOf(['MIT'])));
    expect(outcome.code).toBe(0);
  });

  it('reports how many packages it checked', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const outcome = await runLicenseCheck(dependenciesOver(listing, policyOf(['MIT'])));
    expect(outcome.report).toContain('packages checked: 1');
  });

  it('fails naming the package whose licence is outside the allowlist', async () => {
    const listing: LicenseListing = { 'GPL-3.0-only': [{ name: 'sjcl', versions: ['1.0.9'] }] };
    const outcome = await runLicenseCheck(dependenciesOver(listing, policyOf(['MIT'])));
    expect(outcome).toEqual({
      report: [
        'Licenses: every installed package against the ruled allowlist.',
        '  packages checked: 1',
        '  packages allowed: 0',
        '  sjcl@1.0.9  GPL-3.0-only',
      ].join('\n'),
      code: 1,
    });
  });

  it('fails naming an exception nothing installed answers for', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const policy = policyOf(['MIT'], { 'sjcl@1.0.9': 'reviewed' });
    const outcome = await runLicenseCheck(dependenciesOver(listing, policy, []));
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('sjcl@1.0.9');
  });

  it('passes an exception the lockfile still holds', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const policy = policyOf(['MIT'], { 'sjcl@1.0.9': 'reviewed' });
    const outcome = await runLicenseCheck(dependenciesOver(listing, policy, ['sjcl@1.0.9']));
    expect(outcome.code).toBe(0);
  });

  it("counts the root project's own devDependencies among the packages it checks", async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const rootDev = [packageOf('turbo', '2.10.12', 'MIT')];
    const outcome = await runLicenseCheck(
      dependenciesOver(listing, policyOf(['MIT']), [], rootDev)
    );
    expect(outcome.report).toContain('packages checked: 2');
  });

  it('fails naming a root devDependency whose licence is outside the allowlist', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const rootDev = [packageOf('husky', '9.1.7', 'GPL-3.0-only')];
    const outcome = await runLicenseCheck(
      dependenciesOver(listing, policyOf(['MIT']), [], rootDev)
    );
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('husky@9.1.7  GPL-3.0-only');
  });

  it('counts a root devDependency the listing already names once', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'tsx', versions: ['4.22.4'] }] };
    const rootDev = [packageOf('tsx', '4.22.4', 'MIT')];
    const outcome = await runLicenseCheck(
      dependenciesOver(listing, policyOf(['MIT']), [], rootDev)
    );
    expect(outcome.report).toContain('packages checked: 1');
  });

  it('says so when it found nothing to report', async () => {
    const listing: LicenseListing = { MIT: [{ name: 'left-pad', versions: ['1.3.0'] }] };
    const outcome = await runLicenseCheck(dependenciesOver(listing, policyOf(['MIT'])));
    expect(outcome.report).toContain('no findings');
  });
});

describe('the policy file this repository ships', () => {
  it('parses', async () => {
    await expect(readLicensePolicy(REPO_ROOT)).resolves.toBeDefined();
  });

  it('allows the licences the ruling names', async () => {
    const policy = await readLicensePolicy(REPO_ROOT);
    expect(policy.allow).toEqual([
      '0BSD',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'BlueOak-1.0.0',
      'CC0-1.0',
      'ISC',
      'LGPL-3.0',
      'LGPL-3.0-only',
      'LGPL-3.0-or-later',
      'MIT',
      'MIT-0',
      'MPL-2.0',
      'Python-2.0',
      'UNLICENSE',
      'Unlicense',
    ]);
  });
});

describe('the check over this repository', () => {
  it('reads the package names this lockfile holds', async () => {
    const locked = await pnpmLicenseDependencies(REPO_ROOT).lockedNames();
    expect(locked.has('khroma')).toBe(true);
  });

  it('ships no exception naming a package this lockfile no longer resolves', async () => {
    const [policy, locked] = await Promise.all([
      readLicensePolicy(REPO_ROOT),
      pnpmLicenseDependencies(REPO_ROOT).lockedNames(),
    ]);
    expect(deadExceptions(policy, locked)).toEqual([]);
  });

  it('reads the root devDependencies this tree installs', async () => {
    const rootDev = await pnpmLicenseDependencies(REPO_ROOT).rootDevPackages();
    expect(rootDev.map(({ name }) => name)).toContain('turbo');
  });

  it('reads the licences the installed tree declares', async () => {
    const listing = await pnpmLicenseDependencies(REPO_ROOT).listing();
    expect(licensedPackagesIn(listing).length).toBeGreaterThan(1000);
  });
});

describe("the root project's own devDependencies", () => {
  it('reads one where the installed tree holds it', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeManifest(root, { name: 'root', devDependencies: { turbo: '^2.10.12' } });
      await writeInstalled(root, 'turbo', { version: '2.10.12', license: 'MIT' });
      await expect(readRootDevPackages(root)).resolves.toEqual([
        packageOf('turbo', '2.10.12', 'MIT'),
      ]);
    }));

  it('reads a scoped one from the directory its name spells', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeManifest(root, { name: 'root', devDependencies: { '@types/node': '^24.13.3' } });
      await writeInstalled(root, '@types/node', { version: '24.13.3', license: 'MIT' });
      await expect(readRootDevPackages(root)).resolves.toEqual([
        packageOf('@types/node', '24.13.3', 'MIT'),
      ]);
    }));

  it('reads one declaring no licence the way the package manager reports it', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeManifest(root, { name: 'root', devDependencies: { khroma: '^2.1.0' } });
      await writeInstalled(root, 'khroma', { version: '2.1.0' });
      await expect(readRootDevPackages(root)).resolves.toEqual([
        packageOf('khroma', '2.1.0', 'Unknown'),
      ]);
    }));

  it('reads nothing where the root declares no devDependencies', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeManifest(root, { name: 'root' });
      await expect(readRootDevPackages(root)).resolves.toEqual([]);
    }));

  it('refuses a devDependency the installed tree does not hold', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeManifest(root, { name: 'root', devDependencies: { turbo: '^2.10.12' } });
      await expect(readRootDevPackages(root)).rejects.toThrow('turbo');
    }));
});

describe('a listing the package manager cannot produce', () => {
  it('refuses rather than passing a tree it never checked', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      const manifest = JSON.stringify({ name: 'not-a-workspace', version: '0.0.0' });
      await writeFile(path.join(root, 'package.json'), manifest, 'utf8');
      await expect(pnpmLicenseDependencies(root).listing()).rejects.toThrow('pnpm licenses list');
    }));

  it('refuses prose where it asked for a listing, naming the call that produced it', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeDependencyFreeWorkspace(root);
      const refusal = pnpmLicenseDependencies(root).listing();
      await expect(refusal).rejects.toThrow('pnpm licenses list');
      await expect(refusal).rejects.toThrow(root);
    }));

  it('carries the parse failure as the cause of its refusal', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await writeDependencyFreeWorkspace(root);
      await expect(pnpmLicenseDependencies(root).listing()).rejects.toMatchObject({
        cause: expect.any(SyntaxError),
      });
    }));
});

describe('a policy file that cannot be read', () => {
  it('refuses rather than passing a tree it never checked', () =>
    withScratchDirectory(FIXTURE_PREFIX, async (root) => {
      await mkdir(path.join(root, 'packages', 'config'), { recursive: true });
      await writeFile(path.join(root, 'packages', 'config', 'licenses.json'), '{', 'utf8');
      await expect(readLicensePolicy(root)).rejects.toThrow();
    }));
});

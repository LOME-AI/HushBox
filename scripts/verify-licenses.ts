/**
 * Licence conformance: an installed package whose licence the ruling does not
 * admit.
 *
 * The allowlist is a ruling rather than a judgement this file makes, so the
 * policy lives in data and this only decides what the data means. Two things
 * follow. An id is matched exactly, case included, so a manifest declaring
 * `UNLICENSE` is reported rather than quietly read as the ruled `Unlicense` —
 * the spelling is the kind of thing a human should see once. And anything the
 * SPDX grammar cannot parse — prose, a pointer at a licence file, the empty
 * declaration pnpm reports as `Unknown` — is a finding, never an allowance,
 * because a licence nobody could read is exactly what the gate exists to
 * surface.
 *
 * Scope is every installed package, reached by two routes because one cannot
 * cover both: the listing excludes the workspace's root project, since
 * `pnpm licenses list` refuses the whole command when a selection includes a
 * project declaring a runtime under `devEngines`, and the root declares one.
 * Every other project is walked whole, dev dependencies included, and the root
 * project's own devDependencies are read from the installed tree instead.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import type { GateOutcome } from './privacy-gate.js';

const POLICY_FILE = ['packages', 'config', 'licenses.json'];

const LOCKFILE = 'pnpm-lock.yaml';

const PolicyShape = z.object({
  allow: z.array(z.string()),
  exceptions: z.record(z.string(), z.string()),
});

const ListingShape = z.record(
  z.string(),
  z.array(z.object({ name: z.string(), versions: z.array(z.string()) }))
);

export interface LicensePolicy {
  /** The SPDX ids the ruling admits, spelled as it spelled them. */
  readonly allow: readonly string[];
  /** Package name to the reason that package is admitted anyway. */
  readonly exceptions: Readonly<Record<string, string>>;
}

export interface LicenseListingEntry {
  readonly name: string;
  readonly versions: readonly string[];
}

/** What the package manager reports: one group per licence expression. */
export type LicenseListing = Readonly<Record<string, readonly LicenseListingEntry[]>>;

export interface LicensedPackage {
  readonly name: string;
  readonly version: string;
  /** The expression the package's own manifest declares. */
  readonly license: string;
}

export function parseLicensePolicy(raw: unknown): LicensePolicy {
  return PolicyShape.parse(raw);
}

export async function readLicensePolicy(repoRoot: string): Promise<LicensePolicy> {
  const raw: unknown = JSON.parse(await readFile(path.join(repoRoot, ...POLICY_FILE), 'utf8'));
  return parseLicensePolicy(raw);
}

const OPERATORS = new Set(['AND', 'OR']);

/** An SPDX expression's tokens: ids, operators, and parentheses as their own. */
function tokensOf(expression: string): string[] {
  return expression
    .replaceAll(/([()])/gu, ' $1 ')
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

/** A position in a token run, which each reader below advances as it accepts. */
interface Reader {
  readonly tokens: readonly string[];
  index: number;
}

/**
 * Whether one operand is allowed, or `null` where the tokens are not an
 * expression at all. The three readers are the SPDX grammar: `AND` binds
 * tighter than `OR`, and a parenthesised group is an operand like any other.
 */
function readOperand(reader: Reader, allow: ReadonlySet<string>): boolean | null {
  const token = reader.tokens[reader.index];
  if (token === undefined || token === ')' || OPERATORS.has(token)) return null;
  if (token === '(') {
    reader.index += 1;
    const inner = readExpression(reader, allow);
    if (inner === null || reader.tokens[reader.index] !== ')') return null;
    reader.index += 1;
    return inner;
  }
  reader.index += 1;
  return allow.has(token);
}

function readConjunction(reader: Reader, allow: ReadonlySet<string>): boolean | null {
  const first = readOperand(reader, allow);
  if (first === null) return null;
  let allowed = first;
  while (reader.tokens[reader.index] === 'AND') {
    reader.index += 1;
    const next = readOperand(reader, allow);
    if (next === null) return null;
    allowed = allowed && next;
  }
  return allowed;
}

function readExpression(reader: Reader, allow: ReadonlySet<string>): boolean | null {
  const first = readConjunction(reader, allow);
  if (first === null) return null;
  let allowed = first;
  while (reader.tokens[reader.index] === 'OR') {
    reader.index += 1;
    const next = readConjunction(reader, allow);
    if (next === null) return null;
    allowed = allowed || next;
  }
  return allowed;
}

/** Whether an allowlist admits a licence expression. */
export function allowedBy(expression: string, allow: ReadonlySet<string>): boolean {
  const reader: Reader = { tokens: tokensOf(expression), index: 0 };
  const allowed = readExpression(reader, allow);
  // A token left over means the text was never an expression — prose carrying a
  // licence name reads as an id followed by words, and passing its first word
  // would admit the package on a coincidence.
  return allowed === true && reader.index === reader.tokens.length;
}

/** Every installed release the listing names, one per version. */
export function licensedPackagesIn(listing: LicenseListing): LicensedPackage[] {
  return Object.entries(listing).flatMap(([license, entries]) =>
    entries.flatMap((entry) =>
      entry.versions.map((version) => ({ name: entry.name, version, license }))
    )
  );
}

/** How one installed release is named: the package and the version together. */
function keyOf(entry: LicensedPackage): string {
  return `${entry.name}@${entry.version}`;
}

/** The installed releases the policy admits by neither allowlist nor exception. */
export function offendersIn(
  packages: readonly LicensedPackage[],
  policy: LicensePolicy
): LicensedPackage[] {
  const allow = new Set(policy.allow);
  return packages.filter(
    (entry) => !allowedBy(entry.license, allow) && policy.exceptions[entry.name] === undefined
  );
}

/** The exceptions naming a package the lockfile no longer holds. */
export function deadExceptions(policy: LicensePolicy, locked: ReadonlySet<string>): string[] {
  return Object.keys(policy.exceptions).filter((key) => !locked.has(key));
}

/** A key line of the lockfile's package list: two spaces in, quoted when scoped. */
const PACKAGE_KEY = /^ {2}(?<key>'[^']+'|[^'\s][^:]*):$/u;

/** The package a `name@version` key names; a scoped name keeps its leading `@`. */
function packageNameOf(key: string): string {
  const separator = key.lastIndexOf('@');
  return separator > 0 ? key.slice(0, separator) : key;
}

/**
 * Every package the lockfile resolves, by name. Read off the package list
 * alone, so an importer's dependency range is not mistaken for a release.
 */
export function lockedPackageNames(lockfile: string): Set<string> {
  const names = new Set<string>();
  let reading = false;
  for (const line of lockfile.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ')) {
      reading = line.startsWith('packages:');
      continue;
    }
    if (!reading) continue;
    const key = PACKAGE_KEY.exec(line)?.groups?.['key'];
    if (key !== undefined) names.add(packageNameOf(key.replaceAll("'", '')));
  }
  return names;
}

export interface LicenseCheckDependencies {
  readonly listing: () => Promise<LicenseListing>;
  readonly policy: () => Promise<LicensePolicy>;
  readonly lockedNames: () => Promise<ReadonlySet<string>>;
  readonly rootDevPackages: () => Promise<readonly LicensedPackage[]>;
}

/** One entry per release: a root devDependency is usually a transitive one too. */
function dedupedPackages(packages: readonly LicensedPackage[]): LicensedPackage[] {
  const seen = new Set<string>();
  return packages.filter((entry) => {
    const key = keyOf(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const RootManifestShape = z.object({
  name: z.string(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

const InstalledManifestShape = z.object({ version: z.string(), license: z.unknown().optional() });

/** What the package manager calls a manifest that declares no licence. */
const UNDECLARED = 'Unknown';

async function readRootManifest(repoRoot: string): Promise<z.infer<typeof RootManifestShape>> {
  const raw: unknown = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return RootManifestShape.parse(raw);
}

/** The workspace project a selection must leave out for the listing to run. */
async function rootProjectName(repoRoot: string): Promise<string> {
  const manifest = await readRootManifest(repoRoot);
  return manifest.name;
}

/**
 * The root project's own devDependencies, read where they are installed rather
 * than through the listing, which cannot select the root project at all.
 */
export async function readRootDevPackages(repoRoot: string): Promise<LicensedPackage[]> {
  const manifest = await readRootManifest(repoRoot);
  const declared = Object.keys(manifest.devDependencies ?? {});
  return Promise.all(
    declared.map(async (name) => {
      const installed = path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json');
      const raw: unknown = await readFile(installed, 'utf8').then(
        (text) => JSON.parse(text) as unknown,
        () => {
          throw new Error(`devDependency declared but not installed: ${name}`);
        }
      );
      const { version, license } = InstalledManifestShape.parse(raw);
      return { name, version, license: typeof license === 'string' ? license : UNDECLARED };
    })
  );
}

async function pnpmLicenseListing(repoRoot: string): Promise<LicenseListing> {
  const excluded = await rootProjectName(repoRoot);
  const run = await execa('pnpm', ['licenses', 'list', '--json', '--filter', `!${excluded}`], {
    cwd: repoRoot,
    reject: false,
  });
  // A refusal reports no packages, and reading that as "nothing to report"
  // would pass the gate on a tree it never looked at.
  if (run.exitCode !== 0) {
    throw new Error(
      `pnpm licenses list could not answer in ${repoRoot}: ${run.stderr || run.stdout}`
    );
  }
  // A zero exit is not evidence it answered: with nothing to license it prints
  // prose rather than the JSON it was asked for.
  let raw: unknown;
  try {
    raw = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`pnpm licenses list did not answer with a listing in ${repoRoot}`, {
      cause: error,
    });
  }
  return ListingShape.parse(raw);
}

export function pnpmLicenseDependencies(repoRoot: string): LicenseCheckDependencies {
  return {
    listing: () => pnpmLicenseListing(repoRoot),
    policy: () => readLicensePolicy(repoRoot),
    lockedNames: async () =>
      lockedPackageNames(await readFile(path.join(repoRoot, LOCKFILE), 'utf8')),
    rootDevPackages: () => readRootDevPackages(repoRoot),
  };
}

export function formatOffender(entry: LicensedPackage): string {
  return `  ${keyOf(entry)}  ${entry.license}`;
}

/** Every installed licence against the ruling, and every exception against the tree. */
export async function runLicenseCheck(
  dependencies: LicenseCheckDependencies
): Promise<GateOutcome> {
  const [listing, rootDev, policy, locked] = await Promise.all([
    dependencies.listing(),
    dependencies.rootDevPackages(),
    dependencies.policy(),
    dependencies.lockedNames(),
  ]);
  const packages = dedupedPackages([...licensedPackagesIn(listing), ...rootDev]);
  const offenders = offendersIn(packages, policy);
  const dead = deadExceptions(policy, locked);
  const findings = [
    ...offenders.map((entry) => formatOffender(entry)),
    ...dead.map((key) => `  exception answers for nothing installed: ${key}`),
  ];
  const report = [
    'Licenses: every installed package against the ruled allowlist.',
    `  packages checked: ${String(packages.length)}`,
    `  packages allowed: ${String(packages.length - offenders.length)}`,
    ...(findings.length === 0 ? ['  no findings'] : findings),
  ].join('\n');
  return { report, code: findings.length === 0 ? 0 : 1 };
}

export const COMMAND_LINE = {
  command: 'pnpm verify:licenses',
  summary: "Checks every installed package's licence against the ruled allowlist.",
  flags: [],
  positionals: { kind: 'none' },
  effect: 'reports',
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through the gate */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await runLicenseCheck(pnpmLicenseDependencies(process.cwd()));
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */

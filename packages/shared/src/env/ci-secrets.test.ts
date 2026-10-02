import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CI_IDENTIFIERS, CI_SECRETS } from './ci-secrets.ts';
import { envConfig, Mode, isSecret, resolveRaw, type VariableConfig } from './env.config.ts';
import {
  CREDENTIAL_FAMILIES,
  runbookPath,
  type Credential,
  type SecretStore,
} from './env-types.ts';

// Resolved relative to this file, never through an absolute path.
const REPO_ROOT = new URL('../../../../', import.meta.url);
const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT);
const RUNBOOKS_DIR = new URL('docs/runbooks/', REPO_ROOT);
const SECRET_RUNBOOKS_DIR = new URL('secrets/', RUNBOOKS_DIR);
const INFRA_RUNBOOKS_DIR = new URL('infra/', RUNBOOKS_DIR);

const REGISTRY_ENTRIES = Object.entries<VariableConfig>(envConfig);

/**
 * Run records and audit directories are historical: each cites paths as they
 * stood when it was written, so a target that has since legitimately moved is a
 * record of the past rather than a broken link.
 */
const HISTORICAL_ROOTS = ['docs/runs/', 'docs/audits/'];

/**
 * A cited runbook path, from `docs/runbooks/` through the `.md` that ends it.
 * The character class is negated rather than enumerated so that every future
 * file name is matched: an enumerated family segment of `[a-z][a-z-]*` excludes
 * digits, which silently dropped `r2-token.md` from a sweep of this very set.
 * Interpolation delimiters are excluded because a path built at runtime, such
 * as the one {@link runbookPath} returns, is not a citation and resolves to
 * nothing on disk.
 */
const CITATION = /docs\/runbooks\/[^\s"'`()[\]<>{}$|,;*]*\.md/gu;

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly target: string;
}

/**
 * Every file in the working tree that mentions the runbooks directory, tracked
 * or not, never ignored, never binary. Derived from the repository itself so
 * that a citation in a directory nobody thought to name is still scanned. A
 * hand-listed set of roots is what let a directory move break `ops/`.
 */
function citingFiles(): readonly string[] {
  try {
    const listing = execFileSync(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
      'git',
      ['grep', '--untracked', '-I', '-l', '-z', '-F', '-e', 'docs/runbooks/'],
      { cwd: REPO_ROOT_PATH, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    return listing.split('\0').filter((entry) => entry !== '');
  } catch (error) {
    // `git grep` exits 1 for "no file matched", which is an empty listing.
    if ((error as { status?: unknown }).status === 1) return [];
    throw error;
  }
}

function runbookCitations(): readonly Citation[] {
  const found: Citation[] = [];
  for (const file of citingFiles()) {
    if (HISTORICAL_ROOTS.some((root) => file.startsWith(root))) continue;
    const lines = readFileSync(path.join(REPO_ROOT_PATH, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(CITATION)) {
        found.push({ file, line: index + 1, target: match[0] });
      }
    }
  }
  return found;
}

const RUNBOOK_CITATIONS = runbookCitations();

const REGISTRY_SECRET_NAMES = new Set(
  REGISTRY_ENTRIES.flatMap(([, config]) =>
    Object.values(Mode).flatMap((mode) => {
      const raw = resolveRaw(config, mode);
      return isSecret(raw) ? [raw.name] : [];
    })
  )
);

/** Every declaration in either home, keyed by its declaration name. */
const DECLARATIONS = new Map<string, Credential>([
  ...REGISTRY_ENTRIES.flatMap(([name, config]) =>
    config.credential === undefined ? [] : [[name, config.credential] as const]
  ),
  ...Object.entries(CI_SECRETS),
]);

function isProse(text: string): boolean {
  return text.trim() !== '';
}

describe('CI_SECRETS', () => {
  it('declares only names the registry holds as no secret marker', () => {
    const overlap = Object.keys(CI_SECRETS).filter((name) => REGISTRY_SECRET_NAMES.has(name));
    expect(overlap).toEqual([]);
  });

  it('carries prose in every description and userVisible', () => {
    for (const credential of Object.values(CI_SECRETS)) {
      expect(isProse(credential.description)).toBe(true);
      expect(isProse(credential.userVisible)).toBe(true);
    }
  });
});

describe('CI_IDENTIFIERS', () => {
  it('shares no name with CI_SECRETS', () => {
    const overlap = CI_IDENTIFIERS.filter((name) => name in CI_SECRETS);
    expect(overlap).toEqual([]);
  });

  it('shares no name with the registry secret markers', () => {
    const overlap = CI_IDENTIFIERS.filter((name) => REGISTRY_SECRET_NAMES.has(name));
    expect(overlap).toEqual([]);
  });

  it('lists each name once', () => {
    expect(new Set(CI_IDENTIFIERS).size).toBe(CI_IDENTIFIERS.length);
  });
});

/**
 * Whether some escrow job can bind a declaration held in this store. A job
 * declaring an environment reads that environment's secrets and the
 * repository's alike, so every `github:` store is within reach of a job and a
 * store no GitHub secret backs is within reach of none — which makes a
 * restore-from-copy declaration held there a claim of an offline copy nothing
 * writes. Which job captures which store, and that each binds its whole set,
 * is asserted where the jobs are generated (`scripts/generate-env.test.ts`);
 * this package cannot reach that generator, and the store is the half of the
 * pairing it can see.
 */
function escrowReachable(store: SecretStore): boolean {
  return store.startsWith('github:');
}

describe('the stores an escrow job can bind', () => {
  it('counts a repository-scoped store as one a job can bind', () => {
    expect(escrowReachable('github:repository')).toBe(true);
  });

  it('counts a store no GitHub secret backs as one no job can bind', () => {
    expect(escrowReachable('worker-only')).toBe(false);
  });
});

describe('credential declarations across both homes', () => {
  it('never declare a replacement class worse than admin action', () => {
    const forbidden = [...DECLARATIONS]
      .filter(
        ([, credential]) => credential.replace === 'userMigration' || credential.replace === 'dead'
      )
      .map(([name]) => name);
    expect(forbidden).toEqual([]);
  });

  it('couple symmetrically: when A names B, B names A', () => {
    const asymmetric: string[] = [];
    for (const [name, credential] of DECLARATIONS) {
      for (const other of credential.coupledWith ?? []) {
        const back = DECLARATIONS.get(other)?.coupledWith ?? [];
        if (!back.includes(name)) asymmetric.push(`${name} -> ${other}`);
      }
    }
    expect(asymmetric).toEqual([]);
  });

  it('hold every restore-from-copy declaration where an escrow job can bind it', () => {
    const unreachable = [...DECLARATIONS]
      .filter(
        ([, credential]) =>
          credential.onLoss === 'restoreFromCopy' && !escrowReachable(credential.store)
      )
      .map(([name]) => name);
    expect(unreachable).toEqual([]);
  });

  it('never couple a declaration with itself', () => {
    const reflexive = [...DECLARATIONS]
      .filter(([name, credential]) => (credential.coupledWith ?? []).includes(name))
      .map(([name]) => name);
    expect(reflexive).toEqual([]);
  });
});

describe('runbooks', () => {
  const declaredFamilies = new Set([...DECLARATIONS.values()].map((c) => c.family));

  it('exist for every family id', () => {
    const missing = CREDENTIAL_FAMILIES.filter(
      (family) => !existsSync(new URL(runbookPath(family), REPO_ROOT))
    );
    expect(missing).toEqual([]);
  });

  it('are split into exactly the secrets and infra subdirectories', () => {
    const entries = readdirSync(RUNBOOKS_DIR).toSorted((a, b) => a.localeCompare(b));
    expect(entries).toEqual(['infra', 'secrets']);
  });

  it('hold no secrets file that is not a family id runbook', () => {
    const families = new Set<string>(CREDENTIAL_FAMILIES);
    const orphans = readdirSync(SECRET_RUNBOOKS_DIR).filter(
      (file) => !(file.endsWith('.md') && families.has(file.slice(0, -'.md'.length)))
    );
    expect(orphans).toEqual([]);
  });

  // Infra runbooks document operated surfaces, which no registry enumerates, so
  // the only claim available here is shape; `.gitkeep` tracks the directory while
  // it holds no runbook.
  it('hold no infra file that is not a runbook', () => {
    const orphans = readdirSync(INFRA_RUNBOOKS_DIR).filter(
      (file) => file !== '.gitkeep' && !file.endsWith('.md')
    );
    expect(orphans).toEqual([]);
  });

  it('carry an Obtain section for every family id', () => {
    const lacking = CREDENTIAL_FAMILIES.filter(
      (family) =>
        !/^## Obtain$/mu.test(readFileSync(new URL(runbookPath(family), REPO_ROOT), 'utf8'))
    );
    expect(lacking).toEqual([]);
  });

  it('carry a Replace section for every family an admin-action secret declares', () => {
    const adminFamilies = new Set(
      [...DECLARATIONS.values()]
        .filter((credential) => credential.replace === 'adminAction')
        .map((credential) => credential.family)
    );
    const lacking = [...adminFamilies].filter(
      (family) =>
        !/^## Replace$/mu.test(readFileSync(new URL(runbookPath(family), REPO_ROOT), 'utf8'))
    );
    expect(lacking).toEqual([]);
  });

  it('are each declared by at least one secret', () => {
    const undeclared = CREDENTIAL_FAMILIES.filter((family) => !declaredFamilies.has(family));
    expect(undeclared).toEqual([]);
  });

  // A citation is checked by resolving it on disk, never by matching it against
  // an expected shape: a shape check passes for a path that no longer exists,
  // which is how moving this directory broke every cross-reference into it
  // while the suite stayed green.
  it('resolve every runbook path cited anywhere outside the historical directories', () => {
    const unresolved = RUNBOOK_CITATIONS.filter(
      (citation) => !existsSync(path.join(REPO_ROOT_PATH, citation.target))
    ).map((citation) => `${citation.file}:${String(citation.line)} -> ${citation.target}`);
    expect(unresolved).toEqual([]);
  });

  // Without this, a scan that returned nothing would satisfy the resolution
  // assertion for the worst possible reason.
  it('are cited somewhere the scan reaches', () => {
    expect(RUNBOOK_CITATIONS.length).toBeGreaterThan(0);
  });
});

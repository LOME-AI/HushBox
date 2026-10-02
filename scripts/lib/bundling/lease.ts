import path from 'node:path';
import { ClaimHeldError, claim } from '../claims/claim.js';

/**
 * A cross-process lease over one built output directory, the kind several
 * unrelated commands write. It is the claim primitive in `refuse` mode: a second
 * writer is refused rather than queued, because the two outcomes it prevents — a
 * half-overwritten bundle serving blank pages, and a marketing merge landing on
 * a bundle a concurrent `vite build` has since wiped — read like a broken
 * product rather than like a build failure.
 *
 * Each output is keyed on its own lease file, so a web build and an admin build
 * are independent: they write disjoint directories, and one lease over both
 * would refuse a writer that could not have corrupted anything.
 *
 * The lease is deliberately taken by the composite commands (the ones a person
 * or an agent runs) and not by `@hushbox/web`'s own `build` script. Two reasons,
 * both structural: those commands nest that script inside themselves, so a lease
 * there would refuse its own parent; and `turbo build` restores `dist/**` from
 * its cache without running the script at all, so a lease there would not cover
 * the write that a cache hit performs.
 *
 * `packages/docket` keeps its own separate lock over audit-finding writes. The
 * two guard unrelated resources and never have to agree, and folding docket's
 * into this one would make the audit-finding format a dependency of the build
 * tooling.
 */

/** The built outputs a lease is keyed on, one lease file each. */
export const BUILD_OUTPUTS = ['web-dist', 'admin-dist'] as const;

export type BuildOutput = (typeof BUILD_OUTPUTS)[number];

export function isBuildOutput(value: string): value is BuildOutput {
  return (BUILD_OUTPUTS as readonly string[]).includes(value);
}

/**
 * Raised instead of building. A caller turns it into a refusal the operator
 * sees; the one thing it must never become is a write into the output.
 */
export class BuildLeaseHeldError extends Error {
  constructor(resource: BuildOutput, holder: string) {
    super(
      `${resource} is being written by \`${holder}\`. ` +
        `Concurrent writers corrupt each other's bundle, so this run refused rather than ` +
        `join in. Re-run once that finishes.`
    );
    this.name = 'BuildLeaseHeldError';
  }
}

/**
 * Beside the other runtime cache files rather than inside the output it
 * protects: that directory is wiped by the very builds that hold the lease.
 */
export function buildLeasePath(repoRoot: string, resource: BuildOutput): string {
  return path.join(repoRoot, 'scripts', '.cache', `${resource}.lease`);
}

export async function withBuildLease<T>(
  repoRoot: string,
  resource: BuildOutput,
  holder: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await claim(
      { name: resource, lockPath: buildLeasePath(repoRoot, resource) },
      { onHeld: 'refuse', holder },
      run
    );
  } catch (error) {
    if (error instanceof ClaimHeldError) throw new BuildLeaseHeldError(resource, error.holder);
    throw error;
  }
}
